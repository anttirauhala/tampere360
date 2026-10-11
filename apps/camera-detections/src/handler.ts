/**
 * camera-detections — kamerahavainnot (arkkitehtuuri §43).
 *
 * Reitti:
 *   `GET /v1/camera-detections?limit=&cursor=`
 *
 * Putki: API Gateway HTTP API → tämä Lambda → (muistivälimuistit) →
 * traffic-cam-analyzer-REST-API → JSON.
 *
 * **Miksi oma Lambda eikä selain suoraan:** yksi havaintokortti tarvitsee
 * kolme upstream-kutsua (lista, detalji, presigned-URL) + kuvatiedoston, joten
 * 12 kortin sivu olisi ~26 pyyntöä **per kävijä** — ja lähdepalvelun kiintiö on
 * heidän tilillään (10 000 req/vrk, jaettu). Lambdan välimuistit pudottavat
 * määrän ~26:een per 5 min per lämmin kontti kaikille kävijöille yhteensä.
 * Lisäksi frontend saa oman sopimuksen (`types.ts`), joten lähdepalvelun
 * kenttämuutokset eivät riko käyttöliittymää.
 *
 * **Miksi kuvat eivät kulje Lambdan läpi:** presigned-URL on ainoa tapa saada
 * kuva (bucket on heidän tilillään), ja kuvien proksaaminen maksaisi jokaisen
 * kuvan Lambda-ajassa (~212 kt / kuva) ja hidastaisi sivua. Selain hakee kuvan
 * suoraan S3:sta; CSP:ssä `img-src` sallii `*.s3.eu-north-1.amazonaws.com`.
 *
 * **Miksi 90 päivää vanhat kuvat näkyvät ilman kuvaa:** lähdepalvelun
 * raw-bucket siirtää kuvat 90 päivän jälkeen Glacier-luokkaan, jolloin
 * presigned-GET palauttaa 403. Se ei ole virhe vaan tiedossa oleva rajoite —
 * siksi vastauksessa on `imagesUnavailable` ja UI näyttää "kuvaa ei enää
 * saatavilla" (ei riko sivua).
 */

import {
  createLogger,
  newCorrelationId,
  serializeError,
  withCorrelationId,
} from '@tampere360/observability';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import {
  DETECTIONS_API_URL,
  fetchCameras,
  fetchDetectionDetail,
  fetchDetectionHits,
  fetchImageUrl,
} from './analyzer';
import { type CachedValue, createKeyedCache } from './cache';
import { mapLimit } from './concurrency';
import {
  buildDetectionItem,
  dedupeById,
  indexCameras,
  isRelevantDetection,
  sortByCapturedDesc,
} from './detections';
import {
  DEFAULT_WINDOW_DAYS,
  type ListQuery,
  UPSTREAM_MAX_LIMIT,
  resolveListQuery,
} from './params';
import { isRetryableUpstreamError, withRetry } from './retry';
import type {
  AnalyzerCamera,
  AnalyzerDetectionDetail,
  CameraDetectionItem,
  CameraDetectionsResponse,
} from './types';

const logger = createLogger({
  service: 'camera-detections',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

/** Positiivinen luku ympäristömuuttujasta tai oletus. */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Totuusarvo ympäristömuuttujasta; `false`/`0` sammuttavat ominaisuuden. */
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

const baseUrl = process.env['DETECTION_API_URL'] ?? DETECTIONS_API_URL;
const upstreamTimeoutMs = envNumber('DETECTION_UPSTREAM_TIMEOUT_MS', 6_000);
const retryAttempts = envNumber('DETECTION_RETRY_ATTEMPTS', 2);
const retryBackoffMs = envNumber('DETECTION_RETRY_BACKOFF_MS', 300);
const detailConcurrency = envNumber('DETECTION_DETAIL_CONCURRENCY', 3);
const imageConcurrency = envNumber('DETECTION_IMAGE_CONCURRENCY', 3);
/** Detaljien haku voidaan sammuttaa (`DETECTION_DETAIL_ENABLED=false`). */
const detailEnabled = envFlag('DETECTION_DETAIL_ENABLED', true);

/**
 * Näytettävä aikaikkuna (vuorokautta) — **kiinteä 60**.
 *
 * Lähdepalvelu siirtää raw-kuvat 90 päivän jälkeen Glacier-luokkaan, jolloin
 * kuvan GET palauttaa 403 — ja alkuperäinen kuva on näkymän pointti. 60 vrk
 * jää selvästi sen alle, eikä käyttäjä voi pyytää vanhempia (ei `days`-
 * parametria). Ks. params.ts DEFAULT_WINDOW_DAYS.
 */
const windowDays = envNumber('DETECTION_WINDOW_DAYS', DEFAULT_WINDOW_DAYS);

/**
 * Hakukimppu: analyysi ajetaan tunneittain (klo 9–16), joten 5 min TTL ei
 * hävitä tuoreutta mutta pitää upstream-kutsut harvassa. Varafallback on tunti,
 * jotta lähdepalvelun hetkellinen katkos ei tyhjennä sivua.
 */
interface Bundle {
  items: CameraDetectionItem[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Aikaikkuna, jonka sisällä kimppu on (vuorokautta). */
  windowDays: number;
}

const listCache = createKeyedCache<Bundle>({
  ttlMs: envNumber('DETECTION_LIST_CACHE_MS', 5 * 60_000),
  staleMaxMs: envNumber('DETECTION_LIST_STALE_MAX_MS', 60 * 60_000),
  maxEntries: 8,
  now: () => Date.now(),
});

/**
 * Havaintodetalji: **muuttumaton** (`cameraId` + kuvausaika yksilöi havainnon),
 * joten TTL on viikko ja upstream-kutsu tapahtuu käytännössä kerran per havainto.
 */
const detailCache = createKeyedCache<AnalyzerDetectionDetail>({
  ttlMs: envNumber('DETECTION_DETAIL_CACHE_MS', 7 * 86_400_000),
  staleMaxMs: envNumber('DETECTION_DETAIL_STALE_MAX_MS', 7 * 86_400_000),
  maxEntries: 500,
  now: () => Date.now(),
});

/** Kameraluettelo: nimet ja sijainnit muuttuvat harvoin. */
const camerasCache = createKeyedCache<AnalyzerCamera[]>({
  ttlMs: envNumber('DETECTION_CAMERAS_CACHE_MS', 24 * 3_600_000),
  staleMaxMs: envNumber('DETECTION_CAMERAS_STALE_MAX_MS', 7 * 86_400_000),
  maxEntries: 1,
  now: () => Date.now(),
});

/**
 * Presigned-kuva-URL: **45 min** (alle tunnin voimassaolon). `staleMaxMs` on
 * sama kuin TTL, joten vanhentunutta URL:ia ei koskaan tarjoilla —
 * epäonnistunut uusinta tuottaa mieluummin `null`in (UI näyttää
 * "kuvaa ei saatavilla") kuin rikkinäisen kuvan.
 */
const imageUrlCache = createKeyedCache<string>({
  ttlMs: envNumber('DETECTION_IMAGE_URL_CACHE_MS', 45 * 60_000),
  staleMaxMs: envNumber('DETECTION_IMAGE_URL_CACHE_MS', 45 * 60_000),
  maxEntries: 200,
  now: () => Date.now(),
});

function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** Kutsuu upstreamia yhdellä uusintayrityksellä (ks. retry.ts). */
async function withUpstreamRetry<T>(resource: string, run: () => Promise<T>): Promise<T> {
  return withRetry(run, {
    attempts: retryAttempts,
    backoffMs: retryBackoffMs,
    isRetryable: isRetryableUpstreamError,
    onRetry: (error, attempt) =>
      logger.warn('Upstream-kutsu yritetään uudelleen', {
        resource,
        attempt,
        error: serializeError(error),
      }),
  });
}

/**
 * Kameraluettelo. Jos haku epäonnistuu, palautetaan tyhjä lista: havainnot
 * näytetään silti (ilman nimeä ja sijaintia) — puuttuva lisätieto ei ole syy
 * jättää koko sivua tyhjäksi (§20-henki).
 */
async function loadCameras(): Promise<AnalyzerCamera[]> {
  try {
    return await withUpstreamRetry('cameras', () => fetchCameras(baseUrl, upstreamTimeoutMs));
  } catch (error) {
    logger.warn('Kameraluettelon haku epäonnistui', { error: serializeError(error) });
    return [];
  }
}

/**
 * Detaljin haku välimuistista: epäonnistuminen ei kaada korttia — silloin
 * bounding boxit jäävät puuttumaan (`detections: null`) ja UI kertoo siitä.
 */
async function loadDetail(summary: {
  cameraId: string;
  capturedAtEpoch: number;
}): Promise<AnalyzerDetectionDetail | null> {
  const key = `${summary.cameraId}:${summary.capturedAtEpoch}`;
  try {
    const entry = await detailCache.get(key, () =>
      withUpstreamRetry('detection', () =>
        fetchDetectionDetail(baseUrl, summary.cameraId, summary.capturedAtEpoch, upstreamTimeoutMs),
      ),
    );
    return entry.value;
  } catch (error) {
    logger.warn('Havainnon detaljin haku epäonnistui', {
      key,
      error: serializeError(error),
    });
    return null;
  }
}

/** Kokoaa hakukimpun: osumarivit + kameraliitos + detaljit. */
async function loadBundle(query: ListQuery): Promise<Bundle> {
  const started = Date.now();
  const cameras = await camerasCache.get('cameras', loadCameras);
  const cameraIndex = indexCameras(cameras.value);

  // Haetaan upstreamilta kaksinkertainen määrä näytettäviin nähden: yksi
  // lisäkutsu ei maksa mitään (sama pyyntö), mutta se kompensoi rivit, jotka
  // oma suodatin pudottaa (esim. tulevaisuuden luokka, joka ei ole ihminen
  // eikä eläin, tai ikkunan ulkopuolelle jäävä vanha havainto). Detaljit
  // haetaan silti vain näytettäville.
  const upstreamLimit = Math.min(query.limit * 2, UPSTREAM_MAX_LIMIT);
  const hits = await withUpstreamRetry('detections', () =>
    fetchDetectionHits(baseUrl, { limit: upstreamLimit, cursor: query.cursor }, upstreamTimeoutMs),
  );

  // Aikaikkuna: lähdepalvelu arkistoi kuvat 90 pv jälkeen, joten vanhempien
  // havaintojen alkuperäistä kuvaa ei enää ole. Ikkuna on kiinteä (60 vrk):
  // vanhempia ei näytetä eikä niitä voi pyytää.
  const cutoffEpoch = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  const relevant = hits.items
    .filter((summary) => isRelevantDetection(summary) && summary.capturedAtEpoch >= cutoffEpoch)
    .slice(0, query.limit);

  const items = await mapLimit(relevant, detailConcurrency, async (summary) => {
    const detail = detailEnabled ? await loadDetail(summary) : null;
    return buildDetectionItem({ summary, detail, cameraIndex });
  });

  // Haettu sivu on laskevassa kuvausaikajärjestyksessä, joten jos sivun vanhin
  // rivi on jo ikkunan ulkopuolella, sitä vanhemmatkaan eivät enää mahdu.
  const oldestFetchedEpoch = hits.items.length > 0 ? hits.items[hits.items.length - 1] : undefined;
  const nextPageCouldBeInWindow =
    oldestFetchedEpoch === undefined || oldestFetchedEpoch.capturedAtEpoch >= cutoffEpoch;

  const bundle: Bundle = {
    items: dedupeById(sortByCapturedDesc(items)),
    hasMore: hits.more && nextPageCouldBeInWindow,
    nextCursor: hits.nextToken,
    windowDays,
  };

  logger.info('Kamerahavainnot haettu', {
    requested: query.limit,
    returned: bundle.items.length,
    scanned: hits.items.length,
    windowDays,
    details: detailEnabled,
    hasMore: bundle.hasMore,
    durationMs: Date.now() - started,
  });

  return bundle;
}

/** Liittää korttiin presigned-kuva-URLin; epäonnistuminen → `null`. */
async function attachImageUrl(item: CameraDetectionItem): Promise<CameraDetectionItem> {
  if (!item.imageKey) return item;
  try {
    const entry = await imageUrlCache.get(`${item.imageKey}`, () =>
      withUpstreamRetry('images', () =>
        fetchImageUrl(baseUrl, 'raw', item.imageKey, upstreamTimeoutMs),
      ),
    );
    return { ...item, imageUrl: entry.value };
  } catch (error) {
    // Tavallisin syy: kuva on arkistoitu (Glacier) eikä presigned-GET toimi.
    // Tämä ei ole virhe käyttäjälle vaan tieto: kortti näytetään ilman kuvaa.
    logger.warn('Kuvan URL:ia ei saatu', {
      imageKey: item.imageKey,
      error: serializeError(error),
    });
    return item;
  }
}

/** `GET /v1/camera-detections`. */
async function handleList(query: {
  limit?: string | null;
  cursor?: string | null;
}): Promise<APIGatewayProxyResultV2> {
  const resolved = resolveListQuery(query);
  if (!resolved.ok) {
    return jsonResponse(400, {
      error: resolved.error,
      ...(resolved.max !== undefined ? { max: resolved.max } : {}),
    });
  }

  const { limit, cursor } = resolved.query;
  let entry: CachedValue<Bundle>;
  try {
    entry = await listCache.get(`list:${limit}:${cursor ?? ''}`, () => loadBundle(resolved.query));
  } catch (error) {
    logger.error('Kamerahavaintojen haku epäonnistui', { error: serializeError(error) });
    // 503 eikä 502: kyse on lähteen tilapäisestä viasta, ja selain saa luvan
    // yrittää uudelleen. Frontend näyttää tämän rauhallisena huomautuksena.
    return jsonResponse(503, { error: 'UPSTREAM_UNAVAILABLE' }, { 'retry-after': '300' });
  }

  const items = await mapLimit(entry.value.items, imageConcurrency, attachImageUrl);
  const imagesUnavailable = items.filter((item) => item.imageUrl === null).length;

  const response: CameraDetectionsResponse = {
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    stale: entry.stale,
    count: items.length,
    hasMore: entry.value.hasMore,
    windowDays: entry.value.windowDays,
    imagesUnavailable,
    nextCursor: entry.value.nextCursor,
    items,
    source: {
      system: 'TRAFFIC_CAM_ANALYZER',
      name: 'traffic-cam-analyzer (YOLO World XL, Replicate)',
      url: baseUrl,
      license: 'MIT',
    },
  };

  // Selain saa välimuistittaa lyhyesti: sama kimppu palvellaan joka tapauksessa
  // välimuistista koko TTL-ajan (kuvat tulevat S3:sta omalla URLillaan).
  return jsonResponse(200, response, { 'cache-control': 'public, max-age=60' });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withCorrelationId(newCorrelationId(), async () => {
    const path = event.rawPath ?? '';
    if (path.endsWith('/v1/camera-detections')) {
      return handleList(event.queryStringParameters ?? {});
    }
    return jsonResponse(404, { error: 'NOT_FOUND' });
  });
}
