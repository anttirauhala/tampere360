/**
 * camera-detections — lähteen ja oman API:n tyypit (arkkitehtuuri §43).
 *
 * Kaksi tasoa:
 *  1. `Analyzer*` = traffic-cam-analyzer-palvelun raakamuoto sellaisena kuin se
 *     tulee upstreamista (vain ne kentät, joita käytämme).
 *  2. `CameraDetection*` = **oma sopimus**, joka palvellaan frontendille
 *     reitiltä `/v1/camera-detections`. Frontend ei siis koskaan näe
 *     upstreamin kenttänimiä, joten lähdepalvelun muutokset eivät riko UI:ta.
 *
 * **Perusperiaate (§20): puuttuva arvo on `null`, ei koskaan arvaus tai nolla.**
 */

// --- Upstream: traffic-cam-analyzer ---------------------------------------

/** `GET /detections`-listan rivi (yhteenveto, ei bounding boxeja). */
export interface AnalyzerDetectionSummary {
  cameraId: string;
  capturedAtEpoch: number;
  capturedAt: string;
  hasPerson: boolean;
  hasWildlife: boolean;
  detectionCount: number;
  /** Mallin tunnistamat luokat, esim. `['person']` tai `['person', 'animal']`. */
  detectedClasses: string[];
  processingStatus: string;
  /** S3-avain alkuperäiseen kuvaan (kuva haetaan presigned-URLilla). */
  rawImageKey: string;
}

/** Yksi bounding box -havainto (`GET /detections/{cameraId}/{epoch}`). */
export interface AnalyzerBoxDetection {
  label: string;
  score: number;
  /** [x1, y1, x2, y2] kuvan pikseleinä; `null` jos muoto oli odottamaton. */
  bbox: [number, number, number, number] | null;
}

/** Havainnon detalji: sama kuin yhteenveto + bounding boxit. */
export interface AnalyzerDetectionDetail extends AnalyzerDetectionSummary {
  /** Analyysin valmistumisaika (epoch sekunteina) tai `null`. */
  processedAtEpoch: number | null;
  /** `null` = detaljeja ei haettu (esim. `detail=false`). */
  detections: AnalyzerBoxDetection[] | null;
}

/** `GET /cameras`-listan rivi. */
export interface AnalyzerCamera {
  cameraId: string;
  name: string | null;
  municipality: string | null;
  latitude: number | null;
  longitude: number | null;
}

// --- Oma API: /v1/camera-detections ---------------------------------------

/** Kameran tiedot havaintokortille (liitetty `/cameras`-listasta). */
export interface CameraRef {
  cameraId: string;
  /** Havaintoaseman nimi lähteen mukaan; `null` jos kameraa ei löytynyt. */
  name: string | null;
  municipality: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Yksi havaintokortti. */
export interface CameraDetectionItem {
  /** Läpinäkymätön avain: `cameraId:capturedAtEpoch` (React-avain, ei ULID-oletuksia). */
  id: string;
  camera: CameraRef;
  /** Kuvan kuvausaika (ISO 8601 UTC) — lähteen oma aika. */
  capturedAt: string;
  capturedAtEpoch: number;
  /** Analyysin valmistumisaika (ISO 8601 UTC) tai `null`. */
  processedAt: string | null;
  hasPerson: boolean;
  hasWildlife: boolean;
  detectionCount: number;
  detectedClasses: string[];
  /** Bounding boxit + confidence; `null` = detaljeja ei haettu. */
  detections: AnalyzerBoxDetection[] | null;
  /**
   * Presigned URL alkuperäiseen kuvaan tai `null`.
   *
   * `null` on **tavallinen tilanne**: lähdepalvelun raw-bucket siirtää kuvat
   * 90 päivän jälkeen Glacier-luokkaan, jolloin presigned-GET palauttaa 403.
   * Silloin kortti näyttää "kuvaa ei enää saatavilla" — ei virhettä.
   */
  imageUrl: string | null;
  imageKey: string;
  processingStatus: string;
}

/** `GET /v1/camera-detections` -vastaus. */
export interface CameraDetectionsResponse {
  /** Milloin Tampere 247 haki tiedot (aina asetettu). */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui ja tarjolla on vanhempi kimppu. */
  stale: boolean;
  /** Mukana palautettujen havaintojen määrä. */
  count: number;
  /** true = lähteellä on lisää osumia (sivutus `cursor`-parametrilla). */
  hasMore: boolean;
  /** Aikaikkuna, jonka sisällä havainnot ovat (vuorokautta). Kiinteä — vanhempia ei näytetä. */
  windowDays: number;
  /** Kuinka monelta havainnolta kuvaa ei saatu (arkistoitu) — rehellisyysluku. */
  imagesUnavailable: number;
  /** Seuraavan sivun kursori tai `null`. */
  nextCursor: string | null;
  items: CameraDetectionItem[];
  source: {
    system: 'TRAFFIC_CAM_ANALYZER';
    name: string;
    url: string;
    license: 'MIT';
  };
}

/** Kuva-bucketit lähdepalvelussa. */
export type ImageBucket = 'raw' | 'processed';
