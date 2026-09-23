/**
 * Content-Security-Policy -rakentaja (arkkitehtuuri §14).
 *
 * Keskeinen yksityiskohta, joka on helppo rikkoa: **MapLibre hakee rasteritiilet
 * fetch:llä**, ei <img>-elementillä. Siksi karttatiilien origin tarvitaan SEKÄ
 * `img-src`- ETTÄ `connect-src`-direktiiviin — pelkkä img-src riittää vain
 * silloin, jos tiilet renderöidään kuvina. Ilman connect-src:tä selain estää
 * tiilet ja kartta jää harmaaksi ("NetworkError when attempting to fetch
 * resource").
 */

/** Tampere360:n karttatiilien originit (OSM-rasteri + varalla OpenFreeMap). */
export const TILE_ORIGINS = [
  'https://tile.openstreetmap.org',
  'https://*.tile.openstreetmap.org',
  'https://tiles.openfreemap.org',
];

/**
 * Kelikameroiden originit (Liikennekamerat-välilehti, ks. apps/web/src/api/cameras.ts).
 *
 * - `tie.digitraffic.fi` — asemaluettelo, haetaan `fetch`:llä → `connect-src`
 * - `weathercam.digitraffic.fi` — itse kuvatiedostot `<img>`-elementillä → `img-src`
 *
 * Molemmat lisätään kumpaankin direktiiviin: silloin kuvan vaihtaminen
 * `fetch`-pohjaiseksi (esim. myöhempi välimuisti) ei riko sivua hiljaisesti.
 */
export const CAMERA_ORIGINS = ['https://tie.digitraffic.fi', 'https://weathercam.digitraffic.fi'];

export interface CspOptions {
  /** API:n origin, esim. `https://abc123.execute-api.eu-north-1.amazonaws.com`. */
  apiOrigin: string;
  /** Karttatiilien originit. Oletus: TILE_ORIGINS. */
  tileOrigins?: string[];
  /** Kelikameroiden originit. Oletus: CAMERA_ORIGINS. */
  cameraOrigins?: string[];
  /** Sallitaanko `blob:` (MapLibren Web Worker). Oletus: true. */
  allowBlob?: boolean;
}

/** Rakentaa CloudFrontin ResponseHeadersPolicylle sopivan CSP-merkkijonon. */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const {
    apiOrigin,
    tileOrigins = TILE_ORIGINS,
    cameraOrigins = CAMERA_ORIGINS,
    allowBlob = true,
  } = options;
  const tiles = tileOrigins.join(' ');
  const cameras = cameraOrigins.length > 0 ? ` ${cameraOrigins.join(' ')}` : '';
  const blob = allowBlob ? ' blob:' : '';

  return [
    "default-src 'self'",
    `img-src 'self' data:${blob} ${tiles}${cameras}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    `connect-src 'self' ${apiOrigin} https://*.amazonaws.com ${tiles}${cameras}${blob}`,
    `worker-src 'self'${blob}`,
    `child-src 'self'${blob}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
