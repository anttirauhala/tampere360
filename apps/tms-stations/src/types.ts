/**
 * Tyypit: Digitrafficin TMS-rajapintojen raakamuodot ja oman API:n vastaukset
 * (arkkitehtuuri §30).
 *
 * **Miksi oma Lambda eikä `apps/api`:** mittausasemat eivät tule DynamoDB:stä
 * eivätkä kuluta lukukapasiteettia, ja reaaliaikasnapshot päivittyy minuutin
 * välein. Oma varattu concurrency erottaa reitin query-Lambdan kustannuskatosta
 * (ks. infra/lib/config.ts TMS_*).
 *
 * **Miksi dataa ei haeta selaimesta suoraan Digitrafficilta:** kaikkien asemien
 * reaaliaikavastaus on 3,4 Mt pakkaamattomana (144 kt gzipattuna) ja
 * historia-rajapinta palauttaa CSV:tä, joten haku, suodatus ja jäsennys
 * kuuluvat palvelimelle — ja välimuisti pitää upstream-kutsut kurissa.
 */

// --- Digitraffic: asemaluettelo (simplified) ---------------------------------

export interface DigitrafficStationProperties {
  id: number;
  /** Historiarajapinnan `piste`-parametri on tämä sama luku. */
  tmsNumber: number;
  /** Tekninen nimi, esim. `vt12_Tre_Paasikiventie`. */
  name: string;
  bearing?: number | null;
  /** `GATHERING` = keruussa. Muut arvot tarkoittavat, ettei dataa kerätä. */
  collectionStatus?: string | null;
  /** Metatietojen päivitysaika — **ei** mittausten aika (ks. `StationData`). */
  dataUpdatedTime?: string | null;
}

export interface DigitrafficStationFeature {
  type: 'Feature';
  id?: number;
  geometry?: { type: 'Point'; coordinates: number[] };
  properties: DigitrafficStationProperties;
}

export interface DigitrafficStationsResponse {
  type: 'FeatureCollection';
  features: DigitrafficStationFeature[];
}

// --- Digitraffic: yksittäisen aseman metatiedot (detailed) -------------------

export interface DigitrafficStationDetailProperties extends DigitrafficStationProperties {
  /** Kieliversiot: `fi` on käyttäjälle näytettävä otsikko. */
  names?: Record<string, string> | null;
  municipality?: string | null;
  province?: string | null;
  /** Suunnan 1 määränpääkunta, esim. "Lahti" (kertoo ajosuunnan). */
  direction1Municipality?: string | null;
  direction2Municipality?: string | null;
  /** Vapaan ajon nopeus suunnittain (km/h) → perusta sujuvuusarviolle. */
  freeFlowSpeed1?: number | null;
  freeFlowSpeed2?: number | null;
}

export interface DigitrafficStationDetail {
  type: 'Feature';
  id: number;
  geometry?: { type: 'Point'; coordinates: number[] };
  properties: DigitrafficStationDetailProperties;
}

// --- Digitraffic: mittaustiedot ---------------------------------------------

export interface DigitrafficSensorValue {
  id: number;
  stationId: number;
  /** Anturin nimi, esim. `KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1`. */
  name: string;
  value: number;
  unit: string;
  /** Mittauksen aika (ISO 8601, UTC). */
  measuredTime?: string | null;
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
}

export interface DigitrafficStationData {
  id: number;
  tmsNumber: number;
  /** **Mittausten** aikaleima (toisin kuin metatiedoissa). */
  dataUpdatedTime: string;
  sensorValues: DigitrafficSensorValue[];
}

export interface DigitrafficStationsDataResponse {
  dataUpdatedTime: string;
  stations: DigitrafficStationData[];
}

// --- Oma API: reaaliaikasnapshot --------------------------------------------

/**
 * Sujuvuusarvio on **oma laskelmamme** (nopeus / vapaa nopeus), ei lähteen
 * luokittelu — sama periaate kuin tilanteiden vakavuusluokittelussa (§24).
 */
export type FlowLevel = 'SUJUVAA' | 'HIDASTUNUT' | 'RUUHKAUTUNUT' | 'TUNTEMATON';

export interface DirectionSnapshot {
  direction: 1 | 2;
  /** Suunnan määränpääkunta (esim. "Lahti"), `null` jos ei tiedossa. */
  municipality: string | null;
  /** Vapaan ajon nopeus (km/h), `null` jos metatiedoista ei saatu. */
  freeFlowSpeed: number | null;
  /** Keskimääräinen nopeus (km/h), `null` jos anturia ei ole. */
  speed: number | null;
  /** Liikennemäärä (kpl/h), `null` jos anturia ei ole. */
  volume: number | null;
  /** `speed / freeFlowSpeed`, 1 = vapaa ajo. */
  speedRatio: number | null;
  level: FlowLevel;
}

export interface StationSnapshot {
  id: number;
  tmsNumber: number;
  /** Tekninen nimi (esim. `vt12_Tre_Paasikiventie`). */
  name: string;
  /** Käyttäjälle näytettävä otsikko (`names.fi`), tai tekninen nimi. */
  title: string;
  /** Tienumero teknisestä nimestä johdettuna (esim. `vt12`), tai `null`. */
  road: string | null;
  municipality: string | null;
  province: string | null;
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  directions: [DirectionSnapshot, DirectionSnapshot];
  /** Mittausten aikaleima lähteestä (ei arvattu). */
  measuredAt: string | null;
  /** Kuinka vanha mittaus oli vastausta rakennettaessa (min). */
  ageMinutes: number | null;
}

export interface StationsResponse {
  stations: StationSnapshot[];
  counts: {
    stations: number;
    /** Asemat, joiden vähintään yksi suunta on `RUUHKAUTUNUT`. */
    congested: number;
    /** Asemat, joiden sujuvuutta ei voitu arvioida. */
    unknown: number;
  };
  /** Tietolähteen aikaleima (kaikkien asemien datan `dataUpdatedTime`). */
  generatedAt: string | null;
  /** Hakuhetki palvelimella. */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui, tarjolla on vanhempi snapshot. */
  stale: boolean;
}

// --- Oma API: historia -------------------------------------------------------

export interface HourlyPoint {
  /** Tunti 0–23 (lähteen oma jaottelu 00_01 … 23_24). */
  hour: number;
  value: number | null;
}

export interface DailyPoint {
  /** Lähde ilmoittaa päivän muodossa YYYY-MM-DD. */
  date: string;
  total: number | null;
  light: number | null;
  heavy: number | null;
}

export interface DirectionSpeed {
  /** Lähde: `1`, `2` tai `*` (molemmat suunnat yhteensä). */
  direction: string;
  municipality: string | null;
  /** Nopeusrajoitus muodossa "70/70" (kesä/talvi), tai `null`. */
  speedLimit: string | null;
  total: number | null;
  light: number | null;
  heavy: number | null;
  avgSpeed: number | null;
  avgSpeedLight: number | null;
  avgSpeedHeavy: number | null;
}

export interface HistoryBase {
  tmsNumber: number;
  /** Aseman tekninen nimi, jos se on tiedossa ilman lisähakua. */
  name: string | null;
  generatedAt: string | null;
  fetchedAt: string;
  stale: boolean;
}

export interface DailyHistoryResponse extends HistoryBase {
  type: 'daily';
  range: { from: string; to: string };
  days: DailyPoint[];
}

export interface HourlyHistoryResponse extends HistoryBase {
  type: 'hourly';
  date: string;
  hours: HourlyPoint[];
  total: number | null;
}

export interface SpeedHistoryResponse extends HistoryBase {
  type: 'speed';
  month: string;
  directions: DirectionSpeed[];
}

export type HistoryResponse = DailyHistoryResponse | HourlyHistoryResponse | SpeedHistoryResponse;

/**
 * Koko historian nippu yhdellä vastauksella (`type=all`).
 *
 * **Miksi:** sivun asemakortin napsautus tarvitsee kolme eri näkymää. Jos
 * selain tekisi kolme rinnakkaista pyyntöä, kylmä Lambda ehtisi throttlautua
 * (varattu concurrency) ja käyttäjä näkisi 503:n — havaittu 27.9.2026.
 * Yhdellä pyynnöllä sivun lataus tekee enimmillään kaksi rinnakkaista kutsua
 * (tilannekuva + historia).
 */
export interface HistoryBundle extends HistoryBase {
  type: 'all';
  /**
   * true = ainakin yksi kolmesta jaksosta epäonnistui ja on tyhjä.
   * Sivu näyttää silloin huomautuksen, mutta muut kuvaajat näkyvät normaalisti
   * (yksi hidas lähdevastaus ei kaada koko näkymää).
   */
  partial: boolean;
  daily: DailyHistoryResponse;
  hourly: HourlyHistoryResponse;
  speed: SpeedHistoryResponse;
}

export type HistoryPayload = HistoryResponse | HistoryBundle;
