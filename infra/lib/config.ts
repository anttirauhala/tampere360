/**
 * Tampere247 — infra-konfiguraatio.
 *
 * Lähdekohtaiset ajastukset ja Lambda-entryt keskitetysti, jotta
 * IngestionStack voi luoda Scheduler+Lambda-parin per lähde silmukassa.
 * Uuden lähteen lisäys = uusi rivi tähän listaan + apps/ingest-<id>/.
 */

export type EnvName = 'dev' | 'test' | 'prod';

export interface AppContext {
  envName: EnvName;
  /** AWS-tili (CDK_DEFAULT_ACCOUNT) tai undefined ympäristöriippumattomalle synthille. */
  account?: string;
  region: string;
  /** WAF CloudFront-jakelulle. Oletus false (ei omaa domainia MVP:ssä). */
  wafEnabled: boolean;
}

export interface SourceDefinition {
  /** Lyhyt tunniste: käytetään SSM-polussa, S3-avaimen etuliitteessä ja ajastuksen nimessä. */
  id: string;
  /** SourceSystem-enumin arvo (packages/event-contracts). */
  system: string;
  /** App-hakemiston nimi (apps/<appDir>); oletus `ingest-${id}`. */
  appDir?: string;
  /** Ihmisluettava kuvaus (Lambdan description-kenttään). */
  description: string;
  /** Ajastuksen hakuväli minuutteina (arkkitehtuuri §1). */
  scheduleRateMinutes: number;
  /** Onko lähde käytössä MVP:ssä (arkkitehtuuri §16). */
  enabled: boolean;
}

/**
 * MVP-lähteet hakuväleineen (arkkitehtuuri §9, §16).
 * Pelastustoimi (rescue-media) on adapteri valmiiksi, mutta disabloitu
 * kunnes uusi mediapalvelu julkaistaan — ks. .clinerules/architechture.md.
 */
export const SOURCE_DEFINITIONS: SourceDefinition[] = [
  {
    id: 'fmi-cap',
    appDir: 'ingest-fmi',
    system: 'FMI_CAP',
    description: 'Ilmatieteen laitoksen CAP-säävaroitukset (Pirkanmaa/Tampere-suodatus)',
    scheduleRateMinutes: 5,
    enabled: true,
  },
  {
    id: 'tampere-traffic',
    system: 'TAMPERE_TRAFFIC',
    description: 'Tampereen kaupungin liikennetiedotteet ja tietyöt (ensisijainen liikennelähde)',
    scheduleRateMinutes: 1,
    enabled: true,
  },
  {
    id: 'police',
    system: 'POLICE_RSS',
    description: 'Sisä-Suomen poliisilaitoksen RSS-tiedotteet',
    scheduleRateMinutes: 3,
    enabled: true,
  },
  {
    id: 'events',
    system: 'VISIT_TAMPERE',
    description: 'Visit Tampere / Eventz -tapahtumakalenteri',
    scheduleRateMinutes: 30,
    enabled: true,
  },
  {
    id: 'nysse',
    system: 'NYSSE_ALERTS',
    description: 'Nysse-joukkoliikenteen häiriötiedotteet (GTFS-RT Alerts)',
    scheduleRateMinutes: 1,
    enabled: true,
  },
  {
    id: 'rescue',
    system: 'RESCUE_MEDIA',
    description: 'Pelastustoimen mediapalvelu (vaihdettava adapteri, ei vielä julkaistu lähde)',
    scheduleRateMinutes: 5,
    enabled: false,
  },
];

/** Yhteinen resurssinimeäminen: tampere247-{env}-{suffix}. */
export function resourceName(envName: EnvName, suffix: string): string {
  return `tampere247-${envName}-${suffix}`;
}
