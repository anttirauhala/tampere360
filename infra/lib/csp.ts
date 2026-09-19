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

export interface CspOptions {
  /** API:n origin, esim. `https://abc123.execute-api.eu-north-1.amazonaws.com`. */
  apiOrigin: string;
  /** Karttatiilien originit. Oletus: TILE_ORIGINS. */
  tileOrigins?: string[];
  /** Sallitaanko `blob:` (MapLibren Web Worker). Oletus: true. */
  allowBlob?: boolean;
}

/** Rakentaa CloudFrontin ResponseHeadersPolicylle sopivan CSP-merkkijonon. */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const { apiOrigin, tileOrigins = TILE_ORIGINS, allowBlob = true } = options;
  const tiles = tileOrigins.join(' ');
  const blob = allowBlob ? ' blob:' : '';

  return [
    "default-src 'self'",
    `img-src 'self' data:${blob} ${tiles}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    `connect-src 'self' ${apiOrigin} https://*.amazonaws.com ${tiles}${blob}`,
    `worker-src 'self'${blob}`,
    `child-src 'self'${blob}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
