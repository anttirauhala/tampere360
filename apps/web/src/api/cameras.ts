/**
 * Digitraffic-kelikamerat (weathercam v1).
 *
 * Kuvat haetaan **suoraan Digitrafficilta** selaimesta — ne eivät kulje oman
 * API:n kautta, joten kameroiden katselu ei kuluta oman API:n kiintiötä eikä
 * Lambda-/DynamoDB-kustannuksia.
 *
 * Kaksi Digitrafficin erityispiirrettä, jotka on hoidettava:
 *
 * 1. **`Digitraffic-User`-otsikko**: Digitraffic edellyttää, että sovellus
 *    identifioi itsensä. Otsikko on sallittu CORS-preflightissa
 *    (`access-control-allow-headers`), joten selain voi asettaa sen — tämä
 *    aiheuttaa yhden OPTIONS-kutsun, jonka selain välimuistaa 24 h
 *    (`access-control-max-age: 86400`).
 * 2. **gzip-pakko**: Digitraffic vastaa 406, jos pyyntö ei hyväksy
 *    gzip-koodausta. Selain lähettää `Accept-Encoding`-otsikon itse eikä sitä
 *    voi (eikä tarvitse) asettaa käsin.
 *
 * Kuvatiedostot ovat muotoa `https://weathercam.digitraffic.fi/{presetId}.jpg`
 * (sama `imageUrl`, jonka Digitrafficin oma metatietorajapinta palauttaa).
 * Listarajapinnassa ei ole kuvien aikaleimoja eikä suuntien nimiä, joten
 * "kuva päivitetty" -aikana käytetään aseman `dataUpdatedTime`-kenttää.
 */

/** Asemaluettelo (GeoJSON): asemat, sijainnit ja preset-id:t. */
export const CAMERA_STATIONS_URL = 'https://tie.digitraffic.fi/api/weathercam/v1/stations';

/**
 * Asemien **kuvausajat**: yksi kutsu, kaikki asemat.
 *
 * Tämä on eri asia kuin asemaluettelon `dataUpdatedTime`. Asemaluettelo on
 * metatietoa, jonka `dataUpdatedTime` voi olla tunteja vanha (mitattu
 * 23.9.2026: asemaluettelon arvo 15:26Z, kun kuvat olivat 18:47Z). Kuvan
 * todellinen kuvausaika on tämän rajapinnan `presets[].measuredTime`.
 *
 * Yksi kutsu (~19 kt gzipattuna) kattaa kaikki asemat, joten asemakohtaista
 * hakua (`/stations/{id}/data`) ei tarvita.
 */
export const CAMERA_DATA_URL = 'https://tie.digitraffic.fi/api/weathercam/v1/stations/data';

/** Kuvatiedostojen juuri; kuva = `${CAMERA_IMAGE_BASE_URL}${presetId}.jpg`. */
export const CAMERA_IMAGE_BASE_URL = 'https://weathercam.digitraffic.fi/';

/** Digitraffic pyytää tunnistamaan sovelluksen tällä otsikolla. */
export const CAMERA_USER = 'Tampere247';

export interface DigitrafficCameraPreset {
  /** Presetin tunniste, esim. `C0450701`; sama kuin kuvatiedoston nimi. */
  id: string;
  /** false = kamera ei ole tällä hetkellä kuvauskierrossa. */
  inCollection?: boolean;
}

export interface DigitrafficCameraProperties {
  id: string;
  /** Tekninen nimi, esim. `vt12_Tampere_Rantatie`. */
  name?: string | null;
  collectionStatus?: string | null;
  /** Aseman kuvien päivitysaika (ISO 8601, UTC). */
  dataUpdatedTime?: string | null;
  presets?: DigitrafficCameraPreset[];
}

export interface DigitrafficCameraFeature {
  type: 'Feature';
  id?: string;
  /** GeoJSON-piste, [longitude, latitude, korkeus]. */
  geometry?: { type: 'Point'; coordinates: number[] };
  properties: DigitrafficCameraProperties;
}

export interface DigitrafficCameraStationsResponse {
  type: 'FeatureCollection';
  features: DigitrafficCameraFeature[];
}

/** Yksittäisen kameran (presetin) kuvausaika. */
export interface DigitrafficCameraPresetData {
  id: string;
  /** Kuvan kuvausaika (ISO 8601, UTC). */
  measuredTime?: string | null;
}

/** Aseman kuvausajat: aseman oma päivitysaika ja kamerakohtaiset ajat. */
export interface DigitrafficCameraStationData {
  id: string;
  dataUpdatedTime?: string | null;
  presets?: DigitrafficCameraPresetData[];
}

export interface DigitrafficCameraDataResponse {
  dataUpdatedTime?: string | null;
  stations?: DigitrafficCameraStationData[];
}

/**
 * Hakee kaikki kelikamerat (n. 810 asemaa, ~40 kt gzipattuna).
 *
 * `cache: 'no-cache'` tarkoittaa, että selain validoi välimuistissa olevan
 * vastauksen ETagilla: jos data ei ole muuttunut, vastaus on kevyt 304.
 * Näin "Päivitä kuvat" -painike saa oikeasti tuoreen listan.
 */
export async function fetchCameraStations(
  signal?: AbortSignal,
): Promise<DigitrafficCameraStationsResponse> {
  const res = await fetch(CAMERA_STATIONS_URL, {
    cache: 'no-cache',
    signal,
    headers: {
      accept: 'application/json',
      'Digitraffic-User': CAMERA_USER,
    },
  });

  if (!res.ok) {
    throw new Error(`Kameratietojen haku epäonnistui (HTTP ${res.status})`);
  }

  return (await res.json()) as DigitrafficCameraStationsResponse;
}

/**
 * Hakee asemien kuvausajat (kaikki asemat yhdellä kutsulla, ~19 kt gzipattuna).
 *
 * Tätä tarvitaan, koska asemaluettelon `dataUpdatedTime` ei ole kuvan aika
 * (ks. `CAMERA_DATA_URL`). Sama gzip-pakko ja `Digitraffic-User`-otsikko
 * koskevat tätä rajapintaa.
 */
export async function fetchCameraData(
  signal?: AbortSignal,
): Promise<DigitrafficCameraDataResponse> {
  const res = await fetch(CAMERA_DATA_URL, {
    cache: 'no-cache',
    signal,
    headers: {
      accept: 'application/json',
      'Digitraffic-User': CAMERA_USER,
    },
  });

  if (!res.ok) {
    throw new Error(`Kameroiden kuvausaikojen haku epäonnistui (HTTP ${res.status})`);
  }

  return (await res.json()) as DigitrafficCameraDataResponse;
}
