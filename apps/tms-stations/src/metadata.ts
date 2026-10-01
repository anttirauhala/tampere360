/**
 * Asemien metatietojen kokoaminen (arkkitehtuuri §30).
 *
 * Metatiedot kootaan kahdesta lähteestä, koska kumpikaan ei yksin riitä:
 *
 *  - **simplified-lista** (`/stations`) kertoo, mitkä asemat ovat olemassa,
 *    missä ne sijaitsevat ja kerätäänkö niiltä dataa — mutta ei kuntaa eikä
 *    vapaan ajon nopeutta.
 *  - **detailed-haku** (`/stations/{id}`) kertoo kunnan, maakunnan,
 *    suuntien määränpäät ja `freeFlowSpeed1/2`n — mutta vaatii yhden pyynnön
 *    per asema, joten se tehdään vain alueelle osuville asemille.
 *
 * Jos detailed-haku epäonnistuu, asemaa **ei pudoteta pois**: otsikoksi jää
 * tekninen nimi ja vapaan ajon nopeudeksi `null`, jolloin sujuvuus näkyy
 * `TUNTEMATON`ina. Puuttuva tieto näkyy siis puuttuvana, ei vääränä arviona.
 */

import { inTampereRegion, roadFromName, stationTitle } from './region';
import type {
  DigitrafficStationDetail,
  DigitrafficStationFeature,
  DigitrafficStationsResponse,
} from './types';

export interface StationMeta {
  id: number;
  /** Historiarajapinnan `piste`-parametri. */
  tmsNumber: number;
  name: string;
  title: string;
  road: string | null;
  municipality: string | null;
  province: string | null;
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  direction1Municipality: string | null;
  direction2Municipality: string | null;
  freeFlowSpeed1: number | null;
  freeFlowSpeed2: number | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Valitsee Tampereen seudun asemat, joilta kerätään dataa (`GATHERING`).
 *
 * Poistetut ja tilapäisesti poissa käytöstä olevat asemat jätetään pois: sivu
 * näyttää nykyistä liikennettä, ja esimerkiksi `REMOVED_TEMPORARILY`-asemalle
 * ei tule tuoreita mittauksia. Ratkaisu on tarkoituksellinen rajaus, joka on
 * kirjattu myös käyttöliittymän tietoihin.
 */
export function selectRegionStations(
  response: DigitrafficStationsResponse | null | undefined,
): DigitrafficStationFeature[] {
  const features = response?.features ?? [];
  return features.filter((feature) => {
    const coordinates = feature.geometry?.coordinates;
    const [longitude, latitude] = coordinates ?? [];
    if (!inTampereRegion(latitude, longitude)) return false;
    return feature.properties.collectionStatus === 'GATHERING';
  });
}

/** Yhdistää simplified- ja detailed-metatiedot yhdeksi asemakuvaukseksi. */
export function buildStationMeta(
  feature: DigitrafficStationFeature,
  detail: DigitrafficStationDetail | null,
): StationMeta {
  const properties = feature.properties;
  const detailProperties = detail?.properties;
  const coordinates = detail?.geometry?.coordinates ?? feature.geometry?.coordinates;

  return {
    id: properties.id,
    tmsNumber: properties.tmsNumber,
    name: properties.name,
    title: stationTitle(detailProperties?.names, properties.name),
    road: roadFromName(properties.name),
    municipality: stringOrNull(detailProperties?.municipality),
    province: stringOrNull(detailProperties?.province),
    longitude: finiteOrNull(coordinates?.[0]),
    latitude: finiteOrNull(coordinates?.[1]),
    bearing: finiteOrNull(detailProperties?.bearing ?? properties.bearing),
    direction1Municipality: stringOrNull(detailProperties?.direction1Municipality),
    direction2Municipality: stringOrNull(detailProperties?.direction2Municipality),
    freeFlowSpeed1: finiteOrNull(detailProperties?.freeFlowSpeed1),
    freeFlowSpeed2: finiteOrNull(detailProperties?.freeFlowSpeed2),
  };
}
