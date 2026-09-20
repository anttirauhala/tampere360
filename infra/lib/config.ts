/**
 * Tampere360 — infra-konfiguraatio.
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
  /**
   * Oman domainin konfiguraatio. `undefined` = käytetään CloudFrontin
   * oletusdomainia (dev/test). Prod käyttää omaa domainia (ENVIRONMENT_DOMAINS).
   */
  domain?: DomainConfig;
}

/**
 * Oman domainin, TLS:n ja DNS:n konfiguraatio (arkkitehtuuri §14:
 * CloudFront + WAF + Route 53).
 *
 * Kaikki arvot ovat **jo olemassa olevia** AWS-resursseja, jotka on luotu
 * käsin (domain + sertifikaatti + hosted zone) — CDK vain kytkee ne.
 * Poikkeus: API:n alueellinen sertifikaatti (eu-north-1) luodaan CDK:lla,
 * koska CloudFront-sertifikaatti (us-east-1) ei kelpaa API Gatewaylle.
 */
export interface DomainConfig {
  /** Frontendin ensisijainen osoite (CloudFrontin ensisijainen alias). */
  frontendDomainName: string;
  /** Muut frontendin osoitteet samaan jakeluun (esim. `www.`-etuliite). */
  additionalFrontendDomainNames?: string[];
  /** API:n julkinen osoite, esim. `api.tampere247.online`. */
  apiDomainName: string;
  /** Route 53 -hosted zone, johon alias-tietueet luodaan. */
  hostedZoneId: string;
  /** Hosted zonen nimi ilman loppupistettä, esim. `tampere247.online`. */
  hostedZoneName: string;
  /**
   * CloudFrontin ACM-sertifikaatti (AINA us-east-1). CloudFront ei hyväksy
   * sertifikaattia muusta alueesta. Sertifikaatin on katettava kaikki
   * `frontendDomainName`-kentän nimet — `*.domain` kattaa aliverkkotunnukset.
   */
  cloudFrontCertificateArn: string;
}

/**
 * Ympäristökohtaiset domainit.
 *
 * dev/test: ei domainia → CloudFrontin oletusdomain, ei DNS-tietueita eikä
 * WAF-kustannuksia. prod: oma domain (tampere247.online + *.tampere247.online
 * -sertifikaatti us-east-1:ssä, hosted zone Z04105072OQTLR436VXG7).
 */
export const ENVIRONMENT_DOMAINS: Partial<Record<EnvName, DomainConfig>> = {
  prod: {
    frontendDomainName: 'tampere247.online',
    additionalFrontendDomainNames: ['www.tampere247.online'],
    apiDomainName: 'api.tampere247.online',
    hostedZoneId: 'Z04105072OQTLR436VXG7',
    hostedZoneName: 'tampere247.online',
    cloudFrontCertificateArn:
      'arn:aws:acm:us-east-1:132339120388:certificate/fce78d52-b0b6-4eb9-8abb-d94250666a13',
  },
};

/** Kaikki frontendin osoitteet: ensisijainen + lisänimet. */
export function frontendDomainNames(domain: DomainConfig): string[] {
  return [domain.frontendDomainName, ...(domain.additionalFrontendDomainNames ?? [])];
}

/** Frontendin originit CORS- ja CSP-käyttöön, esim. `https://tampere247.online`. */
export function frontendOrigins(domain: DomainConfig): string[] {
  return frontendDomainNames(domain).map((name) => `https://${name}`);
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
    description: 'Visit Tampere / Eventz -tapahtumakalenteri (API /api/v1/event palauttaa 404 — selvitys kesken)',
    scheduleRateMinutes: 30,
    // Disabloitu: visittampere.fi/api/v1/event palauttaa WordPress-404:n (18.9.2026).
    // Selvitä korvaava rajapinta (Eventz.today / kaupungin kalenteri) ennen käyttöönottoa.
    enabled: false,
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

/** Yhteinen resurssinimeäminen: tampere360-{env}-{suffix}. */
export function resourceName(envName: EnvName, suffix: string): string {
  return `tampere360-${envName}-${suffix}`;
}
