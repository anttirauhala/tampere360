/**
 * Kelikameroiden suodatus ja muunnos näkymän tarvitsemaan muotoon.
 *
 * Nämä ovat puhtaita funktioita (ei verkkoa eikä Reactia), jotta suodatuslogiikka
 * on yksikkötestattavissa ilman selainta. Verkkohaku on `api/cameras.ts`:ssä.
 */

import {
  CAMERA_IMAGE_BASE_URL,
  type DigitrafficCameraDataResponse,
  type DigitrafficCameraStationsResponse,
  type DigitrafficCameraStationData,
} from '../api/cameras';

export interface LatLon {
  latitude: number;
  longitude: number;
}

/** Tampereen keskusta (Keskustori) — kamerahaun keskipiste. */
export const TAMPERE_CENTER: LatLon = { latitude: 61.4978, longitude: 23.761 };

/** Näytettävien kameroiden enimmäisetäisyys keskustasta. */
export const CAMERA_RADIUS_KM = 10;

export interface TrafficCameraPreset {
  id: string;
  /** Valmis kuvaosoite (ilman cache-avainta). */
  imageUrl: string;
  /** Kuvan kuvausaika (ISO 8601 UTC) Digitrafficin `measuredTime`-kentästä. */
  measuredTime: string | null;
}

export interface TrafficCamera {
  stationId: string;
  /** Lähteen tekninen nimi, esim. `vt12_Tampere_Rantatie`. */
  name: string;
  /** Näytettävä nimi, esim. `vt12 Tampere Rantatie`. */
  label: string;
  latitude: number;
  longitude: number;
  /** Etäisyys keskustasta kilometreinä. */
  distanceKm: number;
  /**
   * Aseman tuorein kuvausaika (ISO 8601 UTC) asemien kuvausaikarajapinnasta.
   *
   * HUOM: asemaluettelon oma `dataUpdatedTime` EI ole kuvan aika — se voi olla
   * tunteja vanha metatietoa. Siksi tämä arvo tulee `/stations/data`-kutsusta
   * (ks. `cameraImageTime`).
   */
  updatedAt: string | null;
  /** Vain kuvauskierrossa olevat kamerat (inCollection !== false). */
  presets: TrafficCameraPreset[];
}

/** Kameran kuvatiedoston osoite preset-tunnisteesta. */
export function cameraImageUrl(presetId: string): string {
  return `${CAMERA_IMAGE_BASE_URL}${presetId}.jpg`;
}

/** Kahden pisteen etäisyys kilometreinä (haversine, pallon säde 6371 km). */
export function haversineKm(from: LatLon, to: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;

  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2;

  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Tekninen nimi käyttäjälle luettavaan muotoon: `vt12_Tampere_Rantatie`. */
export function cameraLabel(name: string | null | undefined): string {
  return String(name ?? '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Etäisyys suomalaisella desimaalierottimella, esim. `1,2 km`.
 *
 * Arvo katkaistaan (ei pyöristetä): 9,96 km näytetään muodossa `9,9 km`, jotta
 * alle 10 km:n sääntö ei näytä käyttäjälle ristiriitaiselta.
 */
export function formatDistance(km: number): string {
  const truncated = Math.floor(km * 10) / 10;
  return `${truncated.toFixed(1).replace('.', ',')} km`;
}

/**
 * Kuvan kuvausaika: kamerakohtainen `measuredTime`, muuten aseman päivitysaika.
 *
 * Palauttaa `null`, jos lähde ei kerro aikaa — silloin aika jätetään näyttämättä
 * (§20: aikaleimoja ei arvata).
 */
export function cameraImageTime(camera: TrafficCamera, preset: TrafficCameraPreset): string | null {
  return preset.measuredTime ?? camera.updatedAt;
}

/** Asemakohtaiset kuvausajat tunnisteittain: `stationId → station data`. */
function indexCameraData(
  response: DigitrafficCameraDataResponse | undefined | null,
): Map<string, DigitrafficCameraStationData> {
  const index = new Map<string, DigitrafficCameraStationData>();
  for (const station of response?.stations ?? []) {
    if (station?.id) index.set(station.id, station);
  }
  return index;
}

/**
 * Muuntaa Digitrafficin asemaluettelon näkymän kameroiksi.
 *
 * Mukaan otetaan vain asemat, jotka ovat `radiusKm` sisällä `center`-pisteestä
 * (oletus: Tampereen keskusta, 10 km) ja joilla on vähintään yksi kuvauskierrossa
 * oleva kamera. Tulos on järjestetty lähimmästä kauimmaiseen.
 *
 * `data`-parametri on asemien kuvausajat (`/stations/data`). Sitä tarvitaan,
 * koska asemaluettelon `dataUpdatedTime` on metatietoa ja voi olla tunteja
 * vanha — kuvan todellinen aika on `presets[].measuredTime` (ks. api/cameras.ts).
 */
export function toTrafficCameras(
  response: DigitrafficCameraStationsResponse | undefined | null,
  data?: DigitrafficCameraDataResponse | undefined | null,
  center: LatLon = TAMPERE_CENTER,
  radiusKm: number = CAMERA_RADIUS_KM,
): TrafficCamera[] {
  const cameras: TrafficCamera[] = [];
  const dataByStation = indexCameraData(data);

  for (const feature of response?.features ?? []) {
    const coordinates = feature.geometry?.coordinates;
    if (!coordinates || coordinates.length < 2) continue;

    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const distanceKm = haversineKm(center, { latitude, longitude });
    if (!(distanceKm < radiusKm)) continue;

    const stationId = feature.properties.id || feature.id || '';
    const stationData = dataByStation.get(stationId);
    const measuredById = new Map(
      (stationData?.presets ?? []).map((preset) => [preset.id, preset.measuredTime ?? null]),
    );

    const presets: TrafficCameraPreset[] = (feature.properties.presets ?? [])
      .filter((preset) => preset.inCollection !== false && Boolean(preset?.id))
      .map((preset) => ({
        id: preset.id,
        imageUrl: cameraImageUrl(preset.id),
        measuredTime: measuredById.get(preset.id) ?? null,
      }));

    // Ilman kuvauskierrossa olevaa kameraa ei ole näytettävää kuvaa.
    if (presets.length === 0) continue;

    const name = cameraLabel(feature.properties.name) || stationId;

    cameras.push({
      stationId,
      name,
      label: name,
      latitude,
      longitude,
      distanceKm,
      updatedAt: stationData?.dataUpdatedTime ?? null,
      presets,
    });
  }

  return cameras.sort((a, b) => a.distanceKm - b.distanceKm);
}
