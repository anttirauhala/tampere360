import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Handler-testit: moduulin vakiot ja välimuistit luetaan import-hetkellä, joten
 * jokainen testi lataa moduulin uudelleen (`vi.resetModules`) ympäristön
 * asettamisen jälkeen — muuten testit jakaisivat saman välimuistin.
 *
 * Aikaleimat ovat **suhteessa nykyhetkeen**, koska handler suodattaa havainnot
 * aikaikkunalla (`days`). Kiinteät epochit vanhenisivat ja rikkoisivat testit.
 */
const BASE = 'https://analyzer.example/dev';
const NOW_EPOCH = Math.floor(Date.now() / 1000);
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString();

const PERSON_EPOCH = NOW_EPOCH - 3_600;
const EMPTY_EPOCH = NOW_EPOCH - 7_200;
const OLD_EPOCH = NOW_EPOCH - 200 * 86_400;

/** Ihmishavainto tunnin takaa. */
const PERSON_ROW = {
  cameraId: 'C04546:C0454601',
  capturedAtEpoch: PERSON_EPOCH,
  capturedAt: iso(PERSON_EPOCH),
  hasWildlife: false,
  hasPerson: true,
  detectionCount: 1,
  detectedClasses: ['person'],
  processingStatus: 'SUCCESS',
  rawImageKey: 'C04546/C0454601/raw.jpg',
  processedImageKey: null,
};

/** Rivi, jossa ei ole ihmistä eikä eläintä → pudotetaan omassa suodattimessa. */
const EMPTY_ROW = {
  ...PERSON_ROW,
  capturedAtEpoch: EMPTY_EPOCH,
  capturedAt: iso(EMPTY_EPOCH),
  cameraId: 'C04524:C0452401',
  hasPerson: false,
  detectionCount: 0,
  detectedClasses: [],
  rawImageKey: 'C04524/C0452401/raw.jpg',
};

/** Osuma, joka on aikaikkunan ulkopuolella (kuva on jo arkistoitu). */
const OLD_ROW = {
  ...PERSON_ROW,
  capturedAtEpoch: OLD_EPOCH,
  capturedAt: iso(OLD_EPOCH),
  cameraId: 'C04544:C0454402',
  rawImageKey: 'C04544/C0454402/raw.jpg',
};

const CAMERAS = {
  cameras: [
    {
      cameraId: 'C04546:C0454601',
      name: 'Tie 12 Tampere, Hyhky - Lahteen',
      municipality: 'Tampere',
      lat: 61.508008,
      lon: 23.687886,
    },
  ],
};

const DETAIL = {
  detection: {
    ...PERSON_ROW,
    processedAtEpoch: PERSON_EPOCH + 120,
    replicateOutput: {
      detections: [{ bbox: [755.06, 545.46, 800.55, 644.96], label: 'person', score: 0.337 }],
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setEnv(): void {
  process.env['ENVIRONMENT'] = 'test';
  process.env['DETECTION_API_URL'] = BASE;
  process.env['DETECTION_UPSTREAM_TIMEOUT_MS'] = '2000';
  process.env['DETECTION_RETRY_ATTEMPTS'] = '2';
  process.env['DETECTION_RETRY_BACKOFF_MS'] = '1';
  process.env['DETECTION_DETAIL_ENABLED'] = 'true';
  process.env['DETECTION_DETAIL_CACHE_MS'] = '604800000';
  process.env['DETECTION_LIST_CACHE_MS'] = '300000';
  process.env['DETECTION_IMAGE_URL_CACHE_MS'] = '2700000';
  process.env['DETECTION_WINDOW_DAYS'] = '60';
}

async function loadHandler(): Promise<typeof import('./handler')> {
  vi.resetModules();
  setEnv();
  return import('./handler');
}

function request(path: string, query: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return { rawPath: path, queryStringParameters: query } as unknown as APIGatewayProxyEventV2;
}

function bodyOf(result: { body?: string }): Record<string, unknown> {
  return JSON.parse(result.body ?? '{}') as Record<string, unknown>;
}

/** Oletusreititin: lista + kamerat + detalji + kuva-URL. */
function defaultRouter(url: string, rows: unknown[] = [PERSON_ROW, EMPTY_ROW]): Response {
  if (url.includes('/detections?'))
    return jsonResponse({ items: rows, count: rows.length, nextToken: 'tok-1' });
  if (url.includes('/detections/')) return jsonResponse(DETAIL);
  if (url.includes('/cameras')) return jsonResponse(CAMERAS);
  if (url.includes('/images?'))
    return jsonResponse({ url: 'https://s3.example/raw.jpg?x=1', expiresIn: 3600 });
  throw new Error(`odottamaton kutsu: ${url}`);
}

function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL | Request) => handler(String(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('camera-detections handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('palauttaa 404 tuntemattomalle polulle', async () => {
    const { handler } = await loadHandler();
    const result = await handler(request('/v1/something-else'));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('palauttaa 400 virheellisestä limitistä (ei hiljaista tyhjää listaa)', async () => {
    const { handler } = await loadHandler();
    const result = await handler(request('/v1/camera-detections', { limit: '999' }));
    expect(result).toMatchObject({ statusCode: 400 });
    expect(bodyOf(result)).toMatchObject({ error: 'INVALID_LIMIT' });
  });

  it('ei laajenna aikaikkunaa vanhentuneella parametrilla (vanhempia ei voi katsoa)', async () => {
    stubFetch((url) => defaultRouter(url, [PERSON_ROW, OLD_ROW]));
    const { handler } = await loadHandler();

    const result = await handler(request('/v1/camera-detections', { days: '365' }));
    const body = bodyOf(result);
    expect(result).toMatchObject({ statusCode: 200 });
    expect(body['windowDays']).toBe(60);
    // 200 vrk vanha havainto on ikkunan ulkopuolella eikä tule mukaan.
    expect(body['count']).toBe(1);
  });

  it('kokoaa havainnot: suodattaa ei-osumat pois ja liittää kameran ja kuvan', async () => {
    stubFetch((url) => defaultRouter(url));
    const { handler } = await loadHandler();

    const result = await handler(request('/v1/camera-detections', { limit: '5' }));
    const body = bodyOf(result);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(body['count']).toBe(1);
    expect(body['hasMore']).toBe(true);
    expect(body['windowDays']).toBe(60);
    expect(body['nextCursor']).toBe('tok-1');
    expect(body['imagesUnavailable']).toBe(0);
    expect(body['source']).toMatchObject({ system: 'TRAFFIC_CAM_ANALYZER', license: 'MIT' });

    const items = body['items'] as Record<string, unknown>[];
    const item = items[0] as Record<string, unknown>;
    expect(item['id']).toBe(`C04546:C0454601:${PERSON_EPOCH}`);
    expect(item['imageUrl']).toBe('https://s3.example/raw.jpg?x=1');
    expect(item['camera']).toMatchObject({
      name: 'Tie 12 Tampere, Hyhky - Lahteen',
      municipality: 'Tampere',
    });
    expect(item['detections']).toHaveLength(1);
    expect(item['processedAt']).toBe(iso(PERSON_EPOCH + 120));
  });

  it('jättää aikaikkunan ulkopuoliset havainnot pois ja kertoo ikkunan', async () => {
    // Vanhan havainnon kuva on lähdepalvelussa arkistoitu (90 pv → Glacier),
    // joten ikkuna (60 vrk) rajaa ne pois eikä niitä voi pyytää.
    stubFetch((url) => defaultRouter(url, [PERSON_ROW, OLD_ROW]));
    const { handler } = await loadHandler();

    const result = await handler(request('/v1/camera-detections'));
    const body = bodyOf(result);
    expect(body['count']).toBe(1);
    expect(body['windowDays']).toBe(60);
    // Haetun sivun vanhin rivi (200 vrk) on jo ikkunan ulkopuolella, joten
    // seuraavallakaan sivulla ei voi olla ikkunaan mahtuvia havaintoja.
    expect(body['hasMore']).toBe(false);
  });

  it('paljastaa puuttuvat kuvat luvulla eikä kaada pyyntöä', async () => {
    stubFetch((url) => {
      if (url.includes('/images?')) return new Response('{"error":"Forbidden"}', { status: 403 });
      return defaultRouter(url);
    });
    const { handler } = await loadHandler();

    const result = await handler(request('/v1/camera-detections'));
    const body = bodyOf(result);
    expect(result).toMatchObject({ statusCode: 200 });
    expect(body['imagesUnavailable']).toBe(1);
    expect((body['items'] as Record<string, unknown>[])[0]?.['imageUrl']).toBeNull();
  });

  it('näyttää havainnon ilman bounding boxeja, jos detaljin haku epäonnistuu', async () => {
    stubFetch((url) => {
      if (url.includes('/detections/')) return new Response('{}', { status: 500 });
      return defaultRouter(url);
    });
    const { handler } = await loadHandler();

    const result = await handler(request('/v1/camera-detections'));
    const body = bodyOf(result);
    expect(result).toMatchObject({ statusCode: 200 });
    expect((body['items'] as Record<string, unknown>[])[0]?.['detections']).toBeNull();
  });

  it('palauttaa 503, kun lähteeseen ei saada yhteyttä eikä vanhaa kimppua ole', async () => {
    stubFetch(() => {
      throw new Error('verkkovirhe');
    });
    const { handler } = await loadHandler();

    const result = await handler(request('/v1/camera-detections'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('hakee listan lähteestä vain kerran välimuistin TTL:n sisällä', async () => {
    const fetchMock = stubFetch((url) => defaultRouter(url));
    const { handler } = await loadHandler();

    await handler(request('/v1/camera-detections', { limit: '5' }));
    await handler(request('/v1/camera-detections', { limit: '5' }));

    const listCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/detections?'),
    );
    expect(listCalls).toHaveLength(1);
  });

  it('hakee listan lähteestä vain kerran välimuistin TTL:n sisällä', async () => {
    const fetchMock = stubFetch((url) => defaultRouter(url));
    const { handler } = await loadHandler();

    await handler(request('/v1/camera-detections', { limit: '5' }));
    await handler(request('/v1/camera-detections', { limit: '5' }));

    const listCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/detections?'),
    );
    expect(listCalls).toHaveLength(1);
  });
});
