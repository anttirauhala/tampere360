/**
 * Kamerahavainnot (§43).
 *
 * Data tulee **oman API:n kautta** (`/v1/camera-detections`), ei suoraan
 * lähdepalvelusta: yksi kortti tarvitsee kolme upstream-kutsua (lista, detalji,
 * presigned-kuva-URL), joten ne on tehtävä palvelimella ja välimuistettava —
 * lähdepalvelun kiintiö (10 000 req/vrk) on jaettu kaikkien käyttäjien kesken
 * (ks. apps/camera-detections).
 *
 * **Kuvat** tulevat tässä poikkeuksellisesti suoraan S3:sta presigned-URLilla:
 * ne eivät kulje oman API:n kautta, joten kuvien katselu ei kuluta Lambda-aikaa.
 * API palauttaa vain viimeisen **60 vuorokauden** havainnot; `imageUrl` on
 * `null`, jos lähdepalvelu ei anna kuvalle osoitetta (harvinaista).
 */

import { apiGet } from './client';

/** Yksi bounding box -havainto: luokka, confidence ja laatikko kuvan pikseleinä. */
export interface DetectionBox {
  label: string;
  /** 0…1 (lähdepalvelun confidence). */
  score: number;
  /** `[x1, y1, x2, y2]` kuvan pikseleinä tai `null`, jos lähde ei antanut sitä. */
  bbox: [number, number, number, number] | null;
}

/** Kamera, jonka kuvaan havainto tehtiin (liitetty lähdepalvelun kameraluettelosta). */
export interface DetectionCamera {
  cameraId: string;
  name: string | null;
  municipality: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Yksi kamerahavainto. */
export interface CameraDetection {
  /** `cameraId:capturedAtEpoch` — vakaa avain listan renderoinnille. */
  id: string;
  camera: DetectionCamera;
  /** Kuvan kuvausaika (ISO 8601 UTC). */
  capturedAt: string;
  capturedAtEpoch: number;
  /** Analyysin valmistumisaika tai `null`. */
  processedAt: string | null;
  hasPerson: boolean;
  hasWildlife: boolean;
  detectionCount: number;
  detectedClasses: string[];
  /** Bounding boxit; `null` = detaljia ei saatu (kortti näytetään ilman laatikoita). */
  detections: DetectionBox[] | null;
  /** Presigned URL alkuperäiseen kuvaan tai `null`. */
  imageUrl: string | null;
  imageKey: string;
  processingStatus: string;
}

export interface CameraDetectionsResponse {
  /** Milloin Tampere 247 haki tiedot. */
  fetchedAt: string;
  /** true = lähdepalvelun haku epäonnistui ja tarjolla on vanhempi kimppu. */
  stale: boolean;
  count: number;
  /** true = lähteellä on lisää osumia ikkunan sisällä. */
  hasMore: boolean;
  /** Aikaikkuna, jonka sisällä havainnot ovat (vrk) — palvelimen kiinteä raja. */
  windowDays: number;
  /** Kuinka monelta havainnolta kuvaa ei saatu. */
  imagesUnavailable: number;
  nextCursor: string | null;
  items: CameraDetection[];
  source: { system: string; name: string; url: string; license: string };
}

/** Oletussivukoko: yksi kuva on ~210 kt, joten 12 on reilu ensimmäinen sivu. */
export const DETECTION_PAGE_SIZE = 12;

/** Yläraja, jonka oma API hyväksyy (`limit` ≤ 30). */
export const DETECTION_MAX_LIMIT = 30;

/**
 * Pollausväli 10 min: analyysi ajetaan tunneittain klo 9–16 ja Lambdan
 * välimuisti on 5 min, joten tiuhempi pollaus ei toisi tuoreempaa tietoa.
 */
export const DETECTIONS_POLL_MS = 600_000;

/**
 * Havainnot viimeiseltä 60 vuorokaudelta.
 *
 * Aikaikkuna on palvelimen puolella kiinteä eikä sitä voi laajentaa
 * (lähdepalvelu arkistoi kuvat ~90 pv jälkeen → vanhempia ei näytetä).
 */
export function fetchCameraDetections(limit: number): Promise<CameraDetectionsResponse> {
  return apiGet<CameraDetectionsResponse>('/v1/camera-detections', { limit });
}
