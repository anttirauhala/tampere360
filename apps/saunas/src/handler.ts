/**
 * saunas — saunat (arkkitehtuuri §33).
 *
 * Reitti:
 *   `GET /v1/saunas`   saunahaku.fi-rajapinnan saunaluettelo (22 saunaa)
 *
 * **Miksi oma Lambda eikä suora selainhaku:** sama rakenne kuin muilla
 * reittikohtaisilla Lambdoilla (§27–30). Yksi paikka hakea ja normalisoida
 * data, muistivälimuisti (N selainta → 1 upstream-kutsu per TTL) ja oma
 * varattu concurrency, joka erottaa reitin query-Lambdan (5) sekä ajoneuvo-,
 * pysäkki- ja mittausasema-Lambdan kustannuskatosta (ks. infra/lib/config.ts
 * SAUNA_*).
 *
 * Data ei tule DynamoDB:stä eikä kuluta lukukapasiteettia: saunat ovat
 * staattinen hakemisto, kuten pysäkit ja kamerat.
 */

import {
  createLogger,
  newCorrelationId,
  serializeError,
  withCorrelationId,
} from '@tampere360/observability';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { type CachedValue, createKeyedCache } from './cache';
import { isRetryableUpstreamError, withRetry } from './retry';
import { fetchSaunaList } from './sauna-list';
import type { Sauna, SaunaListResponse } from './types';

const logger = createLogger({
  service: 'saunas',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

/** Positiivinen luku ympäristömuuttujasta tai oletus. */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const upstreamTimeoutMs = envNumber('SAUNA_UPSTREAM_TIMEOUT_MS', 5_000);
/** Lähde on vakaa API Gateway, mutta yksi uusintayritys varalle (ks. retry.ts). */
const retryAttempts = envNumber('SAUNA_RETRY_ATTEMPTS', 2);
const retryBackoffMs = envNumber('SAUNA_RETRY_BACKOFF_MS', 300);

/**
 * Saunalista on yksi arvo (`maxEntries: 1`). TTL on minuutteja, koska
 * aukioloajat ja hinnat muuttuvat harvoin; `staleMaxMs` on viikkoja, jotta
 * hetkellinen upstream-katkos ei tyhjennä sivua.
 */
const listCache = createKeyedCache<Sauna[]>({
  ttlMs: envNumber('SAUNA_CACHE_MS', 15 * 60_000),
  staleMaxMs: envNumber('SAUNA_STALE_MAX_MS', 7 * 86_400_000),
  maxEntries: 1,
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

/** Hakee saunalistan upstreamista yhdellä uusintayrityksellä. */
async function loadList(): Promise<Sauna[]> {
  const started = Date.now();
  const saunas = await withRetry(() => fetchSaunaList(upstreamTimeoutMs), {
    attempts: retryAttempts,
    backoffMs: retryBackoffMs,
    isRetryable: isRetryableUpstreamError,
    onRetry: (error, attempt) =>
      logger.warn('Saunalistan haku yritetään uudelleen', {
        attempt,
        error: serializeError(error),
      }),
  });
  logger.info('Saunalista haettu', { count: saunas.length, durationMs: Date.now() - started });
  return saunas;
}

/** `GET /v1/saunas`. */
async function handleSaunas(): Promise<APIGatewayProxyResultV2> {
  let entry: CachedValue<Sauna[]>;
  try {
    entry = await listCache.get('list', loadList);
  } catch (error) {
    logger.error('Saunalistan haku epäonnistui', { error: serializeError(error) });
    // 503 eikä 502: kyse on lähteen tilapäisestä viasta, ja selain saa luvan
    // yrittää uudelleen. Frontend näyttää tämän rauhallisena huomautuksena.
    return jsonResponse(503, { error: 'UPSTREAM_UNAVAILABLE' }, { 'retry-after': '60' });
  }

  const response: SaunaListResponse = {
    saunas: entry.value,
    count: entry.value.length,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    stale: entry.stale,
  };
  return jsonResponse(200, response, { 'cache-control': 'public, max-age=300' });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withCorrelationId(newCorrelationId(), async () => {
    const path = event.rawPath ?? '';
    if (path.endsWith('/v1/saunas')) return handleSaunas();
    return jsonResponse(404, { error: 'NOT_FOUND' });
  });
}
