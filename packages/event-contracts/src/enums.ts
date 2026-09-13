/**
 * Tampere360 — yhteiset enumeraatiot.
 *
 * Toteutus const object + type -kuviona (ei TS `enum`), jotta tyypit
 * toimivat sellaisenaan sekä runtime-arvoina että tyyppinä ja ovat
 * JSON-ystävällisiä EventBridge/DynamoDB-käytössä.
 */

/** Lähdejärjestelmät. Jokaisella on oma adapterinsa (ks. source-adapter-sdk). */
export const SourceSystem = {
  /** Tampereen kaupungin liikennetiedote- ja tietyörajapinta (ensisijainen liikennelähde) */
  TAMPERE_TRAFFIC: 'TAMPERE_TRAFFIC',
  /** Fintraffic Digitraffic tie (täydentävä lähde, vaihe 2) */
  FINTRAFFIC_ROAD: 'FINTRAFFIC_ROAD',
  /** Fintraffic Digitraffic rautatieliikenne (vaihe 2) */
  FINTRAFFIC_RAIL: 'FINTRAFFIC_RAIL',
  /** Poliisin RSS-tiedotteet (Sisä-Suomen poliisilaitos) */
  POLICE_RSS: 'POLICE_RSS',
  /** Pelastustoimen mediapalvelu (vaihdettava adapteri; Peto poistunut) */
  RESCUE_MEDIA: 'RESCUE_MEDIA',
  /** Ilmatieteen laitos, CAP 1.2 -varoitukset */
  FMI_CAP: 'FMI_CAP',
  /** Visit Tampere / Eventz -tapahtumakalenteri */
  VISIT_TAMPERE: 'VISIT_TAMPERE',
  /** Nysse-joukkoliikenteen häiriötiedotteet (GTFS-RT Alerts / SIRI GM) */
  NYSSE_ALERTS: 'NYSSE_ALERTS',
} as const;
export type SourceSystem = (typeof SourceSystem)[keyof typeof SourceSystem];

/** Tapahtuman kategoria (UI-suodatus ja EventBridge-reititys). */
export const EventCategory = {
  TRAFFIC: 'TRAFFIC',
  PUBLIC_TRANSPORT: 'PUBLIC_TRANSPORT',
  POLICE: 'POLICE',
  RESCUE: 'RESCUE',
  WEATHER: 'WEATHER',
  EVENT: 'EVENT',
  RAIL: 'RAIL',
} as const;
export type EventCategory = (typeof EventCategory)[keyof typeof EventCategory];

/** Tapahtuman tarkka tyyppi. */
export const EventType = {
  TRAFFIC_INCIDENT: 'TRAFFIC_INCIDENT',
  ROADWORK: 'ROADWORK',
  TRAFFIC_ANNOUNCEMENT: 'TRAFFIC_ANNOUNCEMENT',
  POLICE_ANNOUNCEMENT: 'POLICE_ANNOUNCEMENT',
  RESCUE_INCIDENT: 'RESCUE_INCIDENT',
  WEATHER_WARNING: 'WEATHER_WARNING',
  PUBLIC_EVENT: 'PUBLIC_EVENT',
  TRANSIT_DISRUPTION: 'TRANSIT_DISRUPTION',
  RAIL_DISRUPTION: 'RAIL_DISRUPTION',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** Vakavuusaste (nouseva järjestys). */
export const Severity = {
  INFO: 'INFO',
  MINOR: 'MINOR',
  MAJOR: 'MAJOR',
  CRITICAL: 'CRITICAL',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

/** Tapahtuman elinkaari (arkkitehtuuri §3). */
export const LifecycleStatus = {
  DISCOVERED: 'DISCOVERED',
  ACTIVE: 'ACTIVE',
  UPDATED: 'UPDATED',
  ENDED: 'ENDED',
  ARCHIVED: 'ARCHIVED',
  CANCELLED: 'CANCELLED',
} as const;
export type LifecycleStatus = (typeof LifecycleStatus)[keyof typeof LifecycleStatus];

/** Tilannekuva/UI-tila (eri kuin käsittelyn elinkaari). */
export const SituationStatus = {
  ACTIVE: 'ACTIVE',
  UPCOMING: 'UPCOMING',
  ENDED: 'ENDED',
  CANCELLED: 'CANCELLED',
} as const;
export type SituationStatus = (typeof SituationStatus)[keyof typeof SituationStatus];

/** Aluetasot: Tampereen kunta, Tampereen seutu, Pirkanmaa. */
export const AreaCode = {
  TAMPERE: 'TAMPERE',
  TAMPERE_REGION: 'TAMPERE_REGION',
  PIRKANMAA: 'PIRKANMAA',
} as const;
export type AreaCode = (typeof AreaCode)[keyof typeof AreaCode];

/** Miten sijainti on päätelty (arkkitehtuuri §5). */
export const LocationMethod = {
  /** Lähde antaa koordinaatin suoraan */
  SOURCE_COORDINATE: 'SOURCE_COORDINATE',
  /** Lähde antaa alueen (kunta/maakunta) ilman koordinaattia */
  SOURCE_AREA: 'SOURCE_AREA',
  /** Sijainti päätelty kaupunginosasta tai paikannimestä */
  DISTRICT_LOOKUP: 'DISTRICT_LOOKUP',
  /** Geokoodattu tekstistä (locationConfidence pakollinen) */
  TEXT_GEOCODING: 'TEXT_GEOCODING',
  MANUAL: 'MANUAL',
} as const;
export type LocationMethod = (typeof LocationMethod)[keyof typeof LocationMethod];

/** Lähdekohtainen keräystila (IngestionState-taulu). */
export const IngestionStatus = {
  OK: 'OK',
  ERROR: 'ERROR',
  STALE: 'STALE',
  DISABLED: 'DISABLED',
} as const;
export type IngestionStatus = (typeof IngestionStatus)[keyof typeof IngestionStatus];
