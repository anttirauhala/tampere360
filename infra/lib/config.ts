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
    description:
      'Visit Tampere / Eventz -tapahtumakalenteri (API /api/v1/event palauttaa 404 — selvitys kesken)',
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

/**
 * API-kustannussuojat (arkkitehtuuri §14: API Gateway throttling).
 *
 * Palvelu on **julkinen GET-rajapinta ilman API-avainta**, joten stage-tason
 * throttlaus ja varattu concurrency ovat ainoat aidat suojat väärinkäyttöä
 * vastaan (CORS rajaa vain selaimia):
 *
 *  - `rateLimit 10 req/s` + `burstLimit 20` riittää ~75 samanaikaiselle
 *    selaimelle (frontend pollaa 30 s välein) ja rajaa pahimman
 *    kustannusskenaarion ~15–25 $/vrk. Ilman rajaa DynamoDB-lukemat
 *    (`/v1/situations?limit=100` ≈ 50 RRU/pyyntö) voisivat maksaa
 *    satoja euroja vuorokaudessa.
 *  - Ylimenevä liikenne saa HTTP 429, eikä Lambda- tai DynamoDB-kutsuja synny.
 */
export const API_THROTTLE = { rateLimit: 10, burstLimit: 20 } as const;

/**
 * Query-Lambdan varattu concurrency: kova katto sekä Lambda-ajalle että
 * DynamoDB:n polttonopeudelle. 10 req/s × ~100 ms = ~1 concurrency, joten 5
 * on reilusti yli normaalin tarpeen.
 */
export const QUERY_RESERVED_CONCURRENCY = 5;

/**
 * Joukkoliikenteen ajoneuvosijainnit (`GET /v1/vehicles`, arkkitehtuuri §27).
 *
 * Karttasivu pollaa 5 sekunnin välein, joten reitti on selvästi vilkkain osa
 * API:ta. Kustannus pidetään kurissa kolmella keinolla:
 *
 *  1. **Lambdan muistivälimuisti** (`VEHICLE_CACHE_MS`): N selainta aiheuttaa
 *     enintään yhden Waltti-kutsun per TTL per lämmin kontti.
 *  2. **Varattu concurrency** (`VEHICLE_RESERVED_CONCURRENCY`): kova katto
 *     sille, montako konttia voi hakea Walttilta samaan aikaan. Lisäksi tämä
 *     erottaa ajoneuvoreitin query-Lambdan kustannuskatosta (5), jotta
 *     karttasivun liikenne ei syö tilannelistojen kapasiteettia.
 *  3. **Havaintojen ikäraja** (`VEHICLE_MAX_AGE_MINUTES`): liian vanhat
 *     havainnot pudotetaan pois, jotta kartalle ei jää "haamuja".
 *
 * Waltti dokumentoi VehicleMonitoring-pyyntöjen väliksi 1 s; me pollaamme
 * huomattavasti harvemmin (5 s selaimesta, upstream enintään kerran TTL:ssä).
 */
export const VEHICLE_CACHE_MS = 5_000;
export const VEHICLE_STALE_MAX_MS = 60_000;
export const VEHICLE_MAX_AGE_MINUTES = 5;
export const VEHICLE_RESERVED_CONCURRENCY = 2;
export const VEHICLE_UPSTREAM_TIMEOUT_MS = 4_000;

/**
 * Pysäkit ja pysäkkimonitori (`/v1/stops`, `/v1/stops/{stopId}/departures`,
 * arkkitehtuuri §28).
 *
 * Kaksi hyvin erilaista dataa samassa Lambdassa, mutta **eri välimuisteilla**:
 *
 *  1. **Staattinen pysäkkirekisteri** (GTFS-static, ~17 Mt zip): muuttuu
 *     käytännössä päivittäin, joten TTL on tunteja. Purku kestää ~200 ms, joten
 *     sitä ei pidä tehdä kuin kerran kontin elinaikana.
 *  2. **Reaaliaikaiset lähdöt** (Waltti SIRI StopMonitoring): TTL 15 s,
 *     koska lähde itse päivittyy 30 sekunnin välein — tiuhempi kysely ei toisi
 *     tuoreempaa tietoa, mutta kertautuisi jokaisen avoimen selaimen myötä.
 *
 * Varattu concurrency on pieni ja **erillään** sekä query-Lambdasta (5) että
 * ajoneuvolambdasta (2), jotta pysäkkimonitorin pollaus ei syö kummankaan
 * kustannuskattoa.
 */
export const STOP_CACHE_MS = 15_000;
export const STOP_STALE_MAX_MS = 60_000;
export const STOP_CACHE_MAX_ENTRIES = 200;
export const STOP_RESERVED_CONCURRENCY = 2;
export const STOP_UPSTREAM_TIMEOUT_MS = 5_000;
/** Kuinka pitkälle tulevaisuuteen lähtöjä näytetään (`PreviewInterval`). */
export const STOP_PREVIEW_MINUTES = 60;
/** Kuinka monta lähtöä sidepaneliin enintään palautetaan. */
export const STOP_DEPARTURE_LIMIT = 20;
/** Staattisen pysäkkirekisterin TTL (tunteja) ja varafallbackin enimmäisikä. */
export const GTFS_STOPS_CACHE_MS = 6 * 3_600_000;
export const GTFS_STOPS_STALE_MAX_MS = 7 * 86_400_000;
/** GTFS-paketin latauksen aikakatkaisu (17 Mt; selvästi Lambdan timeoutia lyhyempi). */
export const GTFS_STOPS_TIMEOUT_MS = 15_000;
/** Tampereen/Nyssen GTFS-static-paketti (ITS Factory, CC BY 4.0). */
export const GTFS_STOPS_URL =
  'https://data.itsfactory.fi/journeys/files/gtfs/latest/gtfs_tampere.zip';

/**
 * Liikenteen mittausasemat (`/v1/tms/stations`, `/v1/tms/stations/{id}/history`,
 * arkkitehtuuri §30).
 *
 * Kolme välimuistia samassa Lambdassa, koska data päivittyy kolmella eri
 * nopeudella:
 *
 *  1. **Reaaliaikasnapshot** (`TMS_STATIONS_CACHE_MS`, 60 s): lähde päivittyy
 *     minuutin välein. Yksi upstream-kutsu hakee kaikkien asemien arvot
 *     (144 kt gzipattuna), joten ilman välimuistia jokainen avoin selain
 *     aiheuttaisi oman 3,4 Mt:n purun ja oman Digitraffic-kutsunsa.
 *  2. **Metatiedot** (`TMS_METADATA_CACHE_MS`, 24 h): nimet, kunnat ja vapaan
 *     ajon nopeudet muuttuvat harvoin, mutta kokoaminen vaatii yhden pyynnön
 *     per asema (~20). Siksi pitkä TTL.
 *  3. **Historia** (`TMS_HISTORY_CACHE_MS`, 6 h): tilastot päivittyvät
 *     tunneittain ja koskevat päättyneitä vuorokausia tai kuukausia.
 *
 * Varattu concurrency on pieni ja **erillään** query-Lambdasta (5) sekä
 * ajoneuvo- (2) ja pysäkkilambdasta (2), jotta mikään reitti ei syö toisen
 * kustannuskattoa.
 */
export const TMS_STATIONS_CACHE_MS = 60_000;
export const TMS_STATIONS_STALE_MAX_MS = 5 * 60_000;
export const TMS_METADATA_CACHE_MS = 24 * 3_600_000;
export const TMS_METADATA_STALE_MAX_MS = 7 * 86_400_000;
export const TMS_HISTORY_CACHE_MS = 6 * 3_600_000;
export const TMS_HISTORY_STALE_MAX_MS = 7 * 86_400_000;
export const TMS_HISTORY_CACHE_MAX_ENTRIES = 200;
/**
 * Varattu concurrency: **3**, vaikka reitti on kevyt.
 *
 * Miksi ei 2: sivun ensimmäinen lataus tekee enimmillään **neljä rinnakkaista
 * kutsua** (1 × `/v1/tms/stations` + 3 × historia valitulle asemalle). Kylmällä
 * kontilla jokainen kestää 1–3 s (metatietojen kokoaminen), joten kahden
 * kontin katto aiheuttaisi uusille pyynnöille Lambda-throttlauksen, jonka
 * API Gateway näyttää käyttäjälle **503 `{"message":"Service Unavailable"}`** —
 * havaittu 27.9.2026 kuuden rinnakkaisen kutsun sarjassa. Kolme antaa
 * pelivaraa ilman että kustannuskatto olennaisesti löystyy.
 */
export const TMS_RESERVED_CONCURRENCY = 3;
/** Kaikkien asemien reaaliaikakutsun timeout (mitattu 0,25 s). */
export const TMS_UPSTREAM_TIMEOUT_MS = 5_000;
/**
 * Historia-CSV:n **yrityskohtainen** timeout.
 *
 * 8 s eikä 10 s: sama kutsu mitattiin 27.9.2026 sekä 45 ms että 7 597 ms
 * (lähde muodostaa CSV:n pyynnön yhteydessä). 8 s on mitatun hitaimman
 * vastauksen yläpuolella, ja koska uusintayritys on käytössä, hidas vastaus
 * korjautuu toisella yrityksellä (joka vastaa kymmenissä millisekunneissa).
 *
 * Yläraja tulee Lambdan 20 s timeoutista: 2 × 8 s + 0,4 s tauko = 16,4 s.
 */
export const TMS_HISTORY_TIMEOUT_MS = 8_000;
/** Uusintayritys, kun CSV-haku aikakatkaisee tai lähde vastaa 5xx. */
export const TMS_HISTORY_RETRY_ATTEMPTS = 2;
export const TMS_HISTORY_RETRY_BACKOFF_MS = 400;
/** Vuorokausisarjan oletuspituus (päivää). */
export const TMS_HISTORY_DAYS = 14;

/**
 * Tampereen nykyinen sää (`/v1/weather/current`, arkkitehtuuri §31).
 *
 * FMI:n **avoin WFS**, ei API-avainta → ei SSM- eikä Secrets Manager
 * -tarvetta. Havainnot päivittyvät noin 10 minuutin välein, joten 5 min TTL ei
 * hävitä tuoreutta mutta pitää upstream-kutsut harvassa. Tämä on tärkeää, koska
 * FMI:n WFS:llä on pyyntörajat (10 000/vrk, yhteensä 600 / 5 min) — ilman
 * palvelimen välimuistia jokainen avoin selain tekisi oman kutsunsa.
 *
 * Asema on **Tampere-Pirkkala lentoasema (fmisid 101118)**: FMI:n täydellisin
 * havaintoasema Tampereen alueella (lämpötila, tuuli, puuska, suunta, kosteus,
 * paine, pilvisyys). Havaintoaikaa ei koskaan arvata — puuttuva arvo jää
 * `null`iksi (§20).
 *
 * Varattu concurrency on pieni ja **erillään** query- (5), ajoneuvo- (2),
 * pysäkki- (2) ja mittausasema-Lambdasta (3), jotta sääkortin pollaus ei syö
 * muiden reittien kustannuskattoa.
 */
export const WEATHER_FMISID = '101118';
export const WEATHER_STATION_NAME = 'Tampere-Pirkkala lentoasema';
export const WEATHER_CACHE_MS = 300_000;
export const WEATHER_STALE_MAX_MS = 1_800_000;
export const WEATHER_UPSTREAM_TIMEOUT_MS = 6_000;
export const WEATHER_OBSERVATION_HOURS = 3;
export const WEATHER_RESERVED_CONCURRENCY = 2;

/**
 * Kustannusvalvonnan hälytysrajat (MonitoringStack).
 * Normaali liikenne on murto-osa näistä — hälytys tarkoittaa väärinkäyttöä,
 * ei ruuhkaa.
 */
export const API_REQUEST_SPIKE_PER_5MIN = 1000; // ≈3,3 req/s jatkuvaa
export const API_CLIENT_ERRORS_PER_5MIN = 100; // 429-throttlaukset + virhepyynnöt

/**
 * Tilanteiden vanhentumisen siivousväli minuutteina (arkkitehtuuri §5).
 *
 * Lähteet eivät aina ilmoita tapahtuman päättymistä (FMI poistaa päättyneen
 * varoituksen syötteestä), joten ACTIVE-tilanteet, joiden `validity.endsAt` on
 * ohitettu tai joiden `canonicalKey`llä on terminaalitilainen rivi, suljetaan
 * ajastetusti. Pidetään selvästi alle 30 minuutin, jotta käyttöliittymän
 * "aktiivinen"-tila ei ehdi vanhentua näkyvästi.
 */
export const EXPIRY_SWEEP_MINUTES = 5;
