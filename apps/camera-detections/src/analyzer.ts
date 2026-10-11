/**
 * traffic-cam-analyzer-rajapinnan haku (arkkitehtuuri §43).
 *
 * Lähde (verifioitu 11.10.2026):
 *   `https://qwypy5x3c6.execute-api.eu-north-1.amazonaws.com/dev`
 *   → API Gateway REST (edge-optimized), CORS `*`, **ei API-avainta**
 *   → kiintiöt ovat heidän tilillään: 50 req/s, burst 100, 10 000 req/vrk
 *   → kamerakuvat S3:ssa, `GET /images` palauttaa presigned-URLin (1 h)
 *
 * Kolme asiaa, jotka on pakko muistaa:
 *
 * 1. **Suodatin on `hasDetection=true`**, ei `hasPerson`/`hasWildlife`:
 *    jälkimmäiset palauttavat HTTP 500 (heidän GSI:nsä eivät vastaa avaimia).
 *    `hasDetection` tarkoittaa "analyysi löysi jotain", joten rivi
 *    tarkistetaan silti itse (`detections.ts`).
 * 2. **Kameratunniste polussa ilman enkoodausta:** `%3A` → HTTP 404.
 *    Tunniste validoidaan (`params.ts`), jotta polkuun ei voi injektoida.
 * 3. **Kuva-avain kyselyparametrina:** `/` toimii sekä raakana että `%2F`:nä;
 *    käytetään `URLSearchParams`ia, joka enkoodaa myös `+`/`=`-merkit
 *    (sivutusmerkki on base64:ää).
 */

import { isValidCameraId, UPSTREAM_MAX_LIMIT } from './params';
import type {
  AnalyzerBoxDetection,
  AnalyzerCamera,
  AnalyzerDetectionDetail,
  AnalyzerDetectionSummary,
  ImageBucket,
} from './types';

/** Rajapinnan juuri; ympäristömuuttujalla voi vaihtaa (testi/staging). */
export const DETECTIONS_API_URL =
  process.env['DETECTION_API_URL'] ?? 'https://qwypy5x3c6.execute-api.eu-north-1.amazonaws.com/dev';

/** Lähteetön HTTP/parse-virhe tilakoodin kanssa (kutsuja päättää uusinnasta). */
export class AnalyzerError extends Error {
  /** HTTP-tilakoodi, tai `0` jos virhe on vastauksen muodossa. */
  readonly status: number;
  readonly resource: string;

  constructor(status: number, resource: string, message?: string) {
    super(message ?? `traffic-cam-analyzer vastasi ${status} (${resource})`);
    this.name = 'AnalyzerError';
    this.status = status;
    this.resource = resource;
  }
}

// --- URL-rakentajat (puhtaat, testattavat) --------------------------------

/** `GET /detections?hasDetection=true&limit=…[&nextToken=…]` */
export function buildDetectionsUrl(
  baseUrl: string,
  options: { limit: number; cursor?: string | null },
): string {
  const query = new URLSearchParams({
    hasDetection: 'true',
    limit: String(Math.min(options.limit, UPSTREAM_MAX_LIMIT)),
  });
  if (options.cursor) query.set('nextToken', options.cursor);
  return `${baseUrl}/detections?${query.toString()}`;
}

/** `GET /cameras` */
export function buildCamerasUrl(baseUrl: string): string {
  return `${baseUrl}/cameras`;
}

/** `GET /detections/{cameraId}/{epoch}` — tunniste **raakana** (ks. yllä). */
export function buildDetectionDetailUrl(
  baseUrl: string,
  cameraId: string,
  capturedAtEpoch: number,
): string {
  return `${baseUrl}/detections/${cameraId}/${capturedAtEpoch}`;
}

/** `GET /images?bucket=raw&key=…` */
export function buildImageUrlEndpoint(baseUrl: string, bucket: ImageBucket, key: string): string {
  const query = new URLSearchParams({ bucket, key });
  return `${baseUrl}/images?${query.toString()}`;
}

// --- Normalisointi --------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Merkkijono tai luku numerona; muuten `null` (ei arvausta, §20). */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry) => entry !== '');
}

/** Yksi bounding box `[x1, y1, x2, y2]` neljänä äärellisenä numerona. */
function asBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const numbers = value.slice(0, 4).map((entry) => asNumber(entry));
  if (numbers.some((entry) => entry === null)) return null;
  const [x1, y1, x2, y2] = numbers as [number, number, number, number];
  return [x1, y1, x2, y2];
}

/**
 * Normalisoi listan rivin. Palauttaa `null`, jos tunniste tai kuvausaika
 * puuttuu — ilman niitä havaintoa ei voi näyttää eikä yksilöidä.
 */
export function normalizeSummary(raw: unknown): AnalyzerDetectionSummary | null {
  const obj = asObject(raw);
  if (!obj) return null;

  const cameraId = asString(obj['cameraId']);
  const capturedAtEpoch = asNumber(obj['capturedAtEpoch']);
  if (!isValidCameraId(cameraId) || capturedAtEpoch === null) return null;

  const rawImageKey = asString(obj['rawImageKey']);
  if (!rawImageKey) return null;

  return {
    cameraId,
    capturedAtEpoch: Math.floor(capturedAtEpoch),
    capturedAt: asString(obj['capturedAt']),
    hasPerson: asBoolean(obj['hasPerson']),
    hasWildlife: asBoolean(obj['hasWildlife']),
    detectionCount: Math.max(0, Math.floor(asNumber(obj['detectionCount']) ?? 0)),
    detectedClasses: asStringArray(obj['detectedClasses']),
    processingStatus: asString(obj['processingStatus']),
    rawImageKey,
  };
}

/** Normalisoi yhden bounding box -havainnon. */
export function normalizeBoxDetection(raw: unknown): AnalyzerBoxDetection | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const label = asString(obj['label']);
  if (!label) return null;
  return { label, score: asNumber(obj['score']) ?? 0, bbox: asBbox(obj['bbox']) };
}

/**
 * Normalisoi detaljivastauksen. Puuttuva `replicateOutput` ei ole virhe:
 * epäonnistuneella analyysillä ei ole havaintoja, ja silloin lista on tyhjä.
 */
export function normalizeDetail(raw: unknown): AnalyzerBoxDetection[] {
  const obj = asObject(raw);
  const detection = asObject(obj?.['detection']);
  const output = asObject(detection?.['replicateOutput']);
  const detections = output?.['detections'];
  if (!Array.isArray(detections)) return [];
  return detections
    .map(normalizeBoxDetection)
    .filter((entry): entry is AnalyzerBoxDetection => entry !== null);
}

/** Normalisoi `/cameras`-listan. */
export function normalizeCameras(raw: unknown): AnalyzerCamera[] {
  const obj = asObject(raw);
  const cameras = obj?.['cameras'];
  if (!Array.isArray(cameras)) return [];

  const result: AnalyzerCamera[] = [];
  for (const entry of cameras) {
    const item = asObject(entry);
    if (!item) continue;
    const cameraId = asString(item['cameraId']);
    if (!cameraId) continue;
    result.push({
      cameraId,
      name: asString(item['name']) || null,
      municipality: asString(item['municipality']) || null,
      latitude: asNumber(item['lat']),
      longitude: asNumber(item['lon']),
    });
  }
  return result;
}

// --- Verkkohaut ------------------------------------------------------------

async function getJson(url: string, resource: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new AnalyzerError(response.status, resource);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new AnalyzerError(0, resource, `Vastauksen muoto oli odottamaton (${resource})`);
  }
}

/** Hakee osumarivit (`hasDetection=true`), uusin kuvausaika ensin. */
export async function fetchDetectionHits(
  baseUrl: string,
  options: { limit: number; cursor?: string | null },
  timeoutMs: number,
): Promise<{ items: AnalyzerDetectionSummary[]; nextToken: string | null; more: boolean }> {
  const raw = await getJson(buildDetectionsUrl(baseUrl, options), 'detections', timeoutMs);
  const obj = asObject(raw);
  const items = obj?.['items'];
  if (!Array.isArray(items)) {
    throw new AnalyzerError(
      0,
      'detections',
      'Havaintolistan muoto oli odottamaton (ei items-taulukkoa)',
    );
  }
  const summaries = items
    .map(normalizeSummary)
    .filter((entry): entry is AnalyzerDetectionSummary => entry !== null);
  const nextToken = asString(obj?.['nextToken']) || null;
  return { items: summaries, nextToken, more: nextToken !== null };
}

/** Hakee kameraluettelon (nimet, kunnat, sijainnit). */
export async function fetchCameras(baseUrl: string, timeoutMs: number): Promise<AnalyzerCamera[]> {
  return normalizeCameras(await getJson(buildCamerasUrl(baseUrl), 'cameras', timeoutMs));
}

/**
 * Hakee yhden havainnon bounding boxit ja confidencet.
 * Palauttaa tyhjän listan, jos analyysi ei löytänyt mitään.
 */
export async function fetchDetectionDetail(
  baseUrl: string,
  cameraId: string,
  capturedAtEpoch: number,
  timeoutMs: number,
): Promise<AnalyzerDetectionDetail> {
  const raw = await getJson(
    buildDetectionDetailUrl(baseUrl, cameraId, capturedAtEpoch),
    'detection',
    timeoutMs,
  );
  const obj = asObject(raw);
  const detection = asObject(obj?.['detection']);
  if (!detection) {
    throw new AnalyzerError(
      0,
      'detection',
      'Havainnon muoto oli odottamaton (ei detection-oliota)',
    );
  }
  const processedAtEpoch = asNumber(detection['processedAtEpoch']);
  return {
    cameraId,
    capturedAtEpoch,
    capturedAt: asString(detection['capturedAt']),
    hasPerson: asBoolean(detection['hasPerson']),
    hasWildlife: asBoolean(detection['hasWildlife']),
    detectionCount: Math.max(0, Math.floor(asNumber(detection['detectionCount']) ?? 0)),
    detectedClasses: asStringArray(detection['detectedClasses']),
    processingStatus: asString(detection['processingStatus']),
    rawImageKey: asString(detection['rawImageKey']),
    processedAtEpoch: processedAtEpoch === null ? null : Math.floor(processedAtEpoch),
    detections: normalizeDetail(raw),
  };
}

/** Hakee presigned-URLin yhdelle kuvalle (voimassa 1 h). */
export async function fetchImageUrl(
  baseUrl: string,
  bucket: ImageBucket,
  key: string,
  timeoutMs: number,
): Promise<string> {
  const raw = await getJson(buildImageUrlEndpoint(baseUrl, bucket, key), 'images', timeoutMs);
  const url = asString(asObject(raw)?.['url']);
  if (!url) throw new AnalyzerError(0, 'images', 'Kuvavastauksesta puuttui url');
  return url;
}
