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
 * Kelikameroiden originit (Kamerat-välilehti, ks. apps/web/src/api/cameras.ts).
 *
 * - `tie.digitraffic.fi` — asemaluettelo, haetaan `fetch`:llä → `connect-src`
 * - `weathercam.digitraffic.fi` — itse kuvatiedostot `<img>`-elementillä → `img-src`
 *
 * Molemmat lisätään kumpaankin direktiiviin: silloin kuvan vaihtaminen
 * `fetch`-pohjaiseksi (esim. myöhempi välimuisti) ei riko sivua hiljaisesti.
 */
export const CAMERA_ORIGINS = ['https://tie.digitraffic.fi', 'https://weathercam.digitraffic.fi'];

/**
 * Kamerahavaintokuvat (Kamerahavainnot-välilehti §43, ks.
 * apps/camera-detections).
 *
 * Lähdepalvelun raw-kuvat ovat S3:ssa, ja heidän `GET /images` palauttaa
 * **presigned** URLin, jonka host on muotoa
 * `traffic-cam-dev-wf-raw-bucket.s3.eu-north-1.amazonaws.com`. Bucketin nimi on
 * ympäristökohtainen, joten sallitaan alueen S3-kanta kokonaisuudessaan —
 * ei kuitenkaan koko `*.amazonaws.com`ia.
 *
 * Vain `img-src` tarvitsee tämän: kuva renderöidään `<img>`-elementillä.
 * `connect-src`:ssä on jo `https://*.amazonaws.com`, joten sama origin toimii
 * myös, jos kuvat joskus haetaan `fetch`:llä (esim. välimuisti).
 */
export const DETECTION_IMAGE_ORIGINS = ['https://*.s3.eu-north-1.amazonaws.com'];

export interface CspOptions {
  /** API:n origin, esim. `https://abc123.execute-api.eu-north-1.amazonaws.com`. */
  apiOrigin: string;
  /** Karttatiilien originit. Oletus: TILE_ORIGINS. */
  tileOrigins?: string[];
  /** Kelikameroiden originit. Oletus: CAMERA_ORIGINS. */
  cameraOrigins?: string[];
  /**
   * Kamerahavaintokuvien originit (presigned S3). Oletus:
   * DETECTION_IMAGE_ORIGINS.
   */
  detectionImageOrigins?: string[];
  /** Sallitaanko `blob:` (MapLibren Web Worker). Oletus: true. */
  allowBlob?: boolean;
}

/** Rakentaa CloudFrontin ResponseHeadersPolicylle sopivan CSP-merkkijonon. */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const {
    apiOrigin,
    tileOrigins = TILE_ORIGINS,
    cameraOrigins = CAMERA_ORIGINS,
    detectionImageOrigins = DETECTION_IMAGE_ORIGINS,
    allowBlob = true,
  } = options;
  const tiles = tileOrigins.join(' ');
  const cameras = cameraOrigins.length > 0 ? ` ${cameraOrigins.join(' ')}` : '';
  const detectionImages =
    detectionImageOrigins.length > 0 ? ` ${detectionImageOrigins.join(' ')}` : '';
  const blob = allowBlob ? ' blob:' : '';

  return [
    "default-src 'self'",
    `img-src 'self' data:${blob} ${tiles}${cameras}${detectionImages}`,
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
