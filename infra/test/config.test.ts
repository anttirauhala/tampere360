import { describe, expect, it } from 'vitest';

import {
  API_CLIENT_ERRORS_PER_5MIN,
  API_REQUEST_SPIKE_PER_5MIN,
  API_THROTTLE,
  ENVIRONMENT_DOMAINS,
  EXPIRY_SWEEP_MINUTES,
  GTFS_STOPS_CACHE_MS,
  GTFS_STOPS_STALE_MAX_MS,
  GTFS_STOPS_TIMEOUT_MS,
  GTFS_STOPS_URL,
  QUERY_RESERVED_CONCURRENCY,
  SAUNA_CACHE_MS,
  SAUNA_LIST_URL,
  SAUNA_RESERVED_CONCURRENCY,
  SAUNA_RETRY_ATTEMPTS,
  SAUNA_RETRY_BACKOFF_MS,
  SAUNA_STALE_MAX_MS,
  SAUNA_UPSTREAM_TIMEOUT_MS,
  STOP_CACHE_MS,
  STOP_DEPARTURE_LIMIT,
  STOP_PREVIEW_MINUTES,
  STOP_RESERVED_CONCURRENCY,
  STOP_STALE_MAX_MS,
  STOP_UPSTREAM_TIMEOUT_MS,
  TMS_HISTORY_CACHE_MAX_ENTRIES,
  TMS_HISTORY_CACHE_MS,
  TMS_HISTORY_DAYS,
  TMS_HISTORY_RETRY_ATTEMPTS,
  TMS_HISTORY_RETRY_BACKOFF_MS,
  TMS_HISTORY_STALE_MAX_MS,
  TMS_HISTORY_TIMEOUT_MS,
  TMS_METADATA_CACHE_MS,
  TMS_METADATA_STALE_MAX_MS,
  TMS_RESERVED_CONCURRENCY,
  TMS_STATIONS_CACHE_MS,
  TMS_STATIONS_STALE_MAX_MS,
  TMS_UPSTREAM_TIMEOUT_MS,
  VEHICLE_CACHE_MS,
  VEHICLE_MAX_AGE_MINUTES,
  VEHICLE_RESERVED_CONCURRENCY,
  VEHICLE_STALE_MAX_MS,
  VEHICLE_UPSTREAM_TIMEOUT_MS,
  WATER_TEMPERATURE_CACHE_MS,
  WATER_TEMPERATURE_PAIKKA_ID,
  WATER_TEMPERATURE_RESERVED_CONCURRENCY,
  WATER_TEMPERATURE_STALE_MAX_MS,
  WATER_TEMPERATURE_STATION_NAME,
  WATER_TEMPERATURE_UPSTREAM_TIMEOUT_MS,
  WATER_TEMPERATURE_URL,
  WEATHER_CACHE_MS,
  WEATHER_OBSERVATION_HOURS,
  WEATHER_RESERVED_CONCURRENCY,
  WEATHER_STALE_MAX_MS,
  WEATHER_UPSTREAM_TIMEOUT_MS,
  frontendDomainNames,
  frontendOrigins,
} from '../lib/config';

/**
 * Regressiosuoja domain-konfiguraatiolle: prod-domainin on oltava
 * hosted zonen sisällä, CloudFront-sertifikaatin us-east-1:ssä ja API:n
 * saman domainin aliverkkotunnus. Ilman näitä deploy epäonnistuu vasta
 * CloudFormationissa (esim. "Invalid certificate" / CNAME-virhe).
 */
describe('ENVIRONMENT_DOMAINS', () => {
  const prod = ENVIRONMENT_DOMAINS.prod;

  it('ei kytke omaa domainia dev/test-ympäristöihin', () => {
    expect(ENVIRONMENT_DOMAINS.dev).toBeUndefined();
    expect(ENVIRONMENT_DOMAINS.test).toBeUndefined();
  });

  it('määrittää prod-domainin', () => {
    expect(prod).toBeDefined();
  });

  it('kaikki frontend-osoitteet kuuluvat hosted zoneen', () => {
    for (const name of frontendDomainNames(prod!)) {
      expect(name === prod!.hostedZoneName || name.endsWith(`.${prod!.hostedZoneName}`)).toBe(true);
    }
  });

  it('CloudFront-sertifikaatti on us-east-1:ssä (CloudFrontin vaatimus)', () => {
    expect(prod!.cloudFrontCertificateArn).toContain(':acm:us-east-1:');
    // Sertifikaatin pitää kattaa sekä apex että aliverkkotunnukset.
    expect(frontendDomainNames(prod!).length).toBeGreaterThan(0);
  });

  it('API-osoite on frontend-domainin aliverkkotunnus', () => {
    expect(prod!.apiDomainName.endsWith(`.${prod!.hostedZoneName}`)).toBe(true);
    expect(frontendDomainNames(prod!)).not.toContain(prod!.apiDomainName);
  });

  it('frontendOrigins palauttaa https-originit CORS- ja CSP-käyttöön', () => {
    expect(frontendOrigins(prod!)).toEqual([
      `https://${prod!.frontendDomainName}`,
      ...(prod!.additionalFrontendDomainNames ?? []).map((n) => `https://${n}`),
    ]);
  });
});

/**
 * Kustannussuojat: API on julkinen ilman avainta, joten throttlaus ja
 * concurrency-katto ovat ainoat aidat rajat. Nämä testit estävät sen, että
 * rajausta vahingossa löysennetään (esim. takaisin 100 req/s).
 */
describe('API-kustannussuojat', () => {
  it('throttlaus on kiristetty (enintään 20 req/s, purske 40)', () => {
    expect(API_THROTTLE.rateLimit).toBeLessThanOrEqual(20);
    expect(API_THROTTLE.burstLimit).toBeLessThanOrEqual(40);
  });

  it('query-Lambdalle on varattu pieni concurrency', () => {
    expect(QUERY_RESERVED_CONCURRENCY).toBeLessThanOrEqual(10);
  });

  it('hälytysrajat laukeavat selvästi ennen throttlen sallimaa maksimia', () => {
    // 10 req/s × 300 s = 3000 pyyntöä / 5 min; hälytyksen on oltava tätä
    // selvästi pienempi, jotta se ehtii kertoa väärinkäytöstä ajoissa.
    expect(API_REQUEST_SPIKE_PER_5MIN).toBeLessThan(API_THROTTLE.rateLimit * 300);
    expect(API_CLIENT_ERRORS_PER_5MIN).toBeLessThan(API_THROTTLE.rateLimit * 300);
  });
});

/**
 * Tilanteiden elinkaari: vanhentuneet tilanteet pitää sulkea ajastetusti,
 * koska lähteet eivät aina ilmoita päättymistä (FMI poistaa varoituksen
 * syötteestä). Ilman siivousta vanha varoitus näkyisi "aktiivisena" päiviä.
 */
describe('tilanteiden vanhentuminen', () => {
  it('siivous ajetaan selvästi alle 30 minuutin välein', () => {
    expect(EXPIRY_SWEEP_MINUTES).toBeGreaterThan(0);
    expect(EXPIRY_SWEEP_MINUTES).toBeLessThanOrEqual(15);
  });
});

/**
 * Ajoneuvosijainnit (§27): karttasivu pollaa 5 sekunnin välein, joten reitti on
 * API:n vilkkain. Nämä testit estävät sen, että välimuisti poistettaisiin
 * vahingossa käytöstä tai kustannuskatto löysennettäisiin — ilman välimuistia
 * jokainen avoin karttasivu aiheuttaisi oman 1,8 Mt:n Waltti-kutsunsa.
 */
describe('ajoneuvosijaintien kustannussuojat', () => {
  it('upstream-kutsuja vaimennetaan välimuistilla', () => {
    expect(VEHICLE_CACHE_MS).toBeGreaterThan(0);
    expect(VEHICLE_CACHE_MS).toBeLessThanOrEqual(30_000);
  });

  it('vanhaa snapshotia ei tarjota loputtomiin virhetilanteessa', () => {
    expect(VEHICLE_STALE_MAX_MS).toBeGreaterThan(VEHICLE_CACHE_MS);
    expect(VEHICLE_STALE_MAX_MS).toBeLessThanOrEqual(300_000);
  });

  it('ikäraja pudottaa haamut pois mutta ei tuoreita havaintoja', () => {
    expect(VEHICLE_MAX_AGE_MINUTES).toBeGreaterThan(0);
    expect(VEHICLE_MAX_AGE_MINUTES).toBeLessThanOrEqual(15);
  });

  it('Lambdan varattu concurrency on pieni', () => {
    expect(VEHICLE_RESERVED_CONCURRENCY).toBeGreaterThan(0);
    expect(VEHICLE_RESERVED_CONCURRENCY).toBeLessThanOrEqual(3);
  });

  it('upstream-timeout on selvästi Lambdan timeoutia lyhyempi', () => {
    expect(VEHICLE_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
    expect(VEHICLE_UPSTREAM_TIMEOUT_MS).toBeLessThan(10_000);
  });
});

/**
 * Pysäkit ja pysäkkimonitori (§28): kaksi hyvin erilaista välimuistia samassa
 * Lambdassa. Nämä testit estävät sen, että reaaliaikainen TTL (15 s) ja
 * staattinen TTL (tunteja) sekoittuisivat toisiinsa — tai että kustannuskatto
 * poistettaisiin. Ilman välimuisteja jokainen avattu selain aiheuttaisi oman
 * 17 Mt:n GTFS-latauksen ja oman Waltti StopMonitoring -kutsunsa.
 */
describe('pysäkkien kustannussuojat', () => {
  it('reaaliaikainen lähtötieto on 15 sekunnin välimuistissa', () => {
    expect(STOP_CACHE_MS).toBeGreaterThanOrEqual(5_000);
    expect(STOP_CACHE_MS).toBeLessThanOrEqual(30_000);
  });

  it('vanhaa lähtölistaa ei tarjota loputtomiin virhetilanteessa', () => {
    expect(STOP_STALE_MAX_MS).toBeGreaterThan(STOP_CACHE_MS);
    expect(STOP_STALE_MAX_MS).toBeLessThanOrEqual(300_000);
  });

  it('staattinen pysäkkirekisteri on tunteja välimuistissa ja selvästi eri TTL:llä', () => {
    expect(GTFS_STOPS_CACHE_MS).toBeGreaterThanOrEqual(3_600_000);
    expect(GTFS_STOPS_CACHE_MS).toBeGreaterThan(STOP_CACHE_MS * 100);
    expect(GTFS_STOPS_STALE_MAX_MS).toBeGreaterThan(GTFS_STOPS_CACHE_MS);
  });

  it('GTFS-lataus ja upstream-kutsu ehtivät valmistua ennen Lambdan timeoutia (25 s)', () => {
    expect(GTFS_STOPS_TIMEOUT_MS).toBeLessThan(25_000);
    expect(STOP_UPSTREAM_TIMEOUT_MS).toBeLessThan(GTFS_STOPS_TIMEOUT_MS);
  });

  it('Lambdan varattu concurrency on pieni', () => {
    expect(STOP_RESERVED_CONCURRENCY).toBeGreaterThan(0);
    expect(STOP_RESERVED_CONCURRENCY).toBeLessThanOrEqual(3);
  });

  it('lähtölista on rajattu ja esikatseluväli tunnin mittainen', () => {
    expect(STOP_DEPARTURE_LIMIT).toBeGreaterThan(0);
    expect(STOP_DEPARTURE_LIMIT).toBeLessThanOrEqual(50);
    expect(STOP_PREVIEW_MINUTES).toBeGreaterThanOrEqual(15);
    expect(STOP_PREVIEW_MINUTES).toBeLessThanOrEqual(120);
  });

  it('GTFS-lähde on Tampereen GTFS-static-paketti ja salattu yhteys', () => {
    expect(GTFS_STOPS_URL.startsWith('https://')).toBe(true);
    expect(GTFS_STOPS_URL).toContain('gtfs_tampere');
  });
});

/**
 * Liikenteen mittausasemat (§30): kolme välimuistia samassa Lambdassa, koska
 * data päivittyy kolmella eri nopeudella (reaaliaika ~1 min, metatiedot
 * käytännössä harvoin, tilastot tunneittain). Nämä testit estävät sen, että
 * reaaliaikainen TTL ja pitkä TTL sekoittuisivat keskenään — tai että
 * kustannuskatto poistettaisiin. Ilman välimuistia jokainen avattu selain
 * aiheuttaisi oman 3,4 Mt:n Digitraffic-vastauksen ja ~20 metatietopyyntöä.
 */
describe('mittausasemien kustannussuojat', () => {
  it('reaaliaikasnapshot on minuutin välimuistissa', () => {
    expect(TMS_STATIONS_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    expect(TMS_STATIONS_CACHE_MS).toBeLessThanOrEqual(180_000);
  });

  it('vanhaa snapshotia ei tarjota loputtomiin virhetilanteessa', () => {
    expect(TMS_STATIONS_STALE_MAX_MS).toBeGreaterThan(TMS_STATIONS_CACHE_MS);
    expect(TMS_STATIONS_STALE_MAX_MS).toBeLessThanOrEqual(900_000);
  });

  it('metatiedoilla on selvästi pidempi TTL kuin reaaliaikadatalle', () => {
    expect(TMS_METADATA_CACHE_MS).toBeGreaterThanOrEqual(3_600_000);
    expect(TMS_METADATA_CACHE_MS).toBeGreaterThan(TMS_STATIONS_CACHE_MS * 100);
    expect(TMS_METADATA_STALE_MAX_MS).toBeGreaterThan(TMS_METADATA_CACHE_MS);
  });

  it('historia on tunteja välimuistissa ja selvästi eri TTL:llä', () => {
    expect(TMS_HISTORY_CACHE_MS).toBeGreaterThanOrEqual(3_600_000);
    expect(TMS_HISTORY_CACHE_MS).toBeGreaterThan(TMS_STATIONS_CACHE_MS * 10);
    expect(TMS_HISTORY_STALE_MAX_MS).toBeGreaterThan(TMS_HISTORY_CACHE_MS);
    // Historia-avaimia kertyy asema × tyyppi × jakso → muisti on rajattava.
    expect(TMS_HISTORY_CACHE_MAX_ENTRIES).toBeGreaterThanOrEqual(50);
    expect(TMS_HISTORY_CACHE_MAX_ENTRIES).toBeLessThanOrEqual(1000);
  });

  it('upstream-timeoutit ehtivät valmistua ennen Lambdan timeoutia (20 s)', () => {
    expect(TMS_UPSTREAM_TIMEOUT_MS).toBeLessThan(20_000);
    expect(TMS_HISTORY_TIMEOUT_MS).toBeLessThan(20_000);
    expect(TMS_UPSTREAM_TIMEOUT_MS).toBeLessThan(TMS_HISTORY_TIMEOUT_MS);
  });

  it('uusintayrityksen kokonaisaika mahtuu Lambdan timeoutiin', () => {
    // Pahin tapaus: attempts × timeout + tauot < Lambdan 20 s. Muuten Lambda
    // ehtisi kuolla kesken uusinnan ja käyttäjä näkisi API Gatewayn 503:n.
    const worstCaseMs =
      TMS_HISTORY_RETRY_ATTEMPTS * TMS_HISTORY_TIMEOUT_MS +
      (TMS_HISTORY_RETRY_ATTEMPTS - 1) * TMS_HISTORY_RETRY_BACKOFF_MS;
    expect(worstCaseMs).toBeLessThan(20_000);
    expect(TMS_HISTORY_RETRY_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(TMS_HISTORY_RETRY_ATTEMPTS).toBeLessThanOrEqual(3);
    expect(TMS_HISTORY_RETRY_BACKOFF_MS).toBeGreaterThanOrEqual(100);
    expect(TMS_HISTORY_RETRY_BACKOFF_MS).toBeLessThanOrEqual(2_000);
  });

  it('historia-timeout on mitatun hitaimman vastauksen (7,6 s) yläpuolella', () => {
    // 27.9.2026: sama kutsu 45 ms … 7 597 ms. Tämän alle jäävä timeout tuottaisi
    // käyttäjälle näkyviä virheitä satunnaisesti (siksi myös uusintayritys).
    expect(TMS_HISTORY_TIMEOUT_MS).toBeGreaterThan(7_600);
  });

  it('Lambdan varattu concurrency on pieni ja erillään muista reiteistä', () => {
    // 3 eikä 2: sivun ensimmäinen lataus tekee enimmillään neljä rinnakkaista
    // kutsua, ja kahden kontin katto tuotti käyttäjälle 503:n kylmänä (ks.
    // docs/architecture/tms-stations.md). Katto pysyy silti pienenä.
    expect(TMS_RESERVED_CONCURRENCY).toBeGreaterThan(0);
    expect(TMS_RESERVED_CONCURRENCY).toBeLessThanOrEqual(3);
  });

  it('vuorokausisarjan oletusjakso on järkevä (1–31 päivää)', () => {
    expect(TMS_HISTORY_DAYS).toBeGreaterThanOrEqual(7);
    expect(TMS_HISTORY_DAYS).toBeLessThanOrEqual(31);
  });
});

/**
 * Sään kustannussuojat (§31): FMI:n avoimella WFS:llä on pyyntörajat
 * (10 000/vrk, yhteensä 600 / 5 min), joten palvelimen välimuisti on pakollinen.
 */
describe('sään kustannussuojat', () => {
  it('havainto on noin viiden minuutin välimuistissa (FMI päivittyy ~10 min)', () => {
    expect(WEATHER_CACHE_MS).toBeGreaterThanOrEqual(60_000);
    expect(WEATHER_CACHE_MS).toBeLessThanOrEqual(600_000);
  });

  it('vanhaa havaintoa ei tarjota loputtomiin virhetilanteessa', () => {
    expect(WEATHER_STALE_MAX_MS).toBeGreaterThan(WEATHER_CACHE_MS);
    expect(WEATHER_STALE_MAX_MS).toBeLessThanOrEqual(3_600_000);
  });

  it('upstream-timeout on selvästi Lambdan timeoutia (10 s) lyhyempi', () => {
    expect(WEATHER_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WEATHER_UPSTREAM_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('Lambdan varattu concurrency on pieni ja erillään muista reiteistä', () => {
    expect(WEATHER_RESERVED_CONCURRENCY).toBeGreaterThan(0);
    expect(WEATHER_RESERVED_CONCURRENCY).toBeLessThanOrEqual(3);
  });

  it('hakuväli kattaa useita havaintoja (viimeisin löytyy, vaikka tuore puuttuisi)', () => {
    expect(WEATHER_OBSERVATION_HOURS).toBeGreaterThanOrEqual(1);
    expect(WEATHER_OBSERVATION_HOURS).toBeLessThanOrEqual(12);
  });
});

/**
 * Saunojen kustannussuojat (§33): saunahaku.fi on julkinen rajapinta, mutta
 * välimuisti on silti pakollinen — ilman sitä jokainen avattu Saunat-sivu
 * aiheuttaisi oman upstream-kutsunsa. TTL on minuutteja (aukioloajat ja hinnat
 * muuttuvat harvoin) ja varafallback selvästi sitä pidempi.
 */
describe('saunojen kustannussuojat', () => {
  it('lähde on HTTPS-rajapinta (ei avainta)', () => {
    expect(SAUNA_LIST_URL.startsWith('https://')).toBe(true);
  });

  it('saunalista on minuuttien välimuistissa', () => {
    expect(SAUNA_CACHE_MS).toBeGreaterThanOrEqual(60_000);
    expect(SAUNA_CACHE_MS).toBeLessThanOrEqual(3_600_000);
  });

  it('vanhaa listaa ei tarjota loputtomiin virhetilanteessa', () => {
    expect(SAUNA_STALE_MAX_MS).toBeGreaterThan(SAUNA_CACHE_MS);
    expect(SAUNA_STALE_MAX_MS).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it('upstream-timeout ja uusinnat mahtuvat Lambdan timeoutiin (10 s)', () => {
    expect(SAUNA_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
    // 2 × timeout + tauko < Lambdan 10 s.
    const budget = SAUNA_RETRY_ATTEMPTS * SAUNA_UPSTREAM_TIMEOUT_MS + SAUNA_RETRY_BACKOFF_MS;
    expect(budget).toBeLessThan(10_000);
  });

  it('Lambdan varattu concurrency on pieni ja erillään muista reiteistä', () => {
    expect(SAUNA_RESERVED_CONCURRENCY).toBeGreaterThan(0);
    expect(SAUNA_RESERVED_CONCURRENCY).toBeLessThanOrEqual(3);
  });
});

/**
 * Veden lämpötilan kustannussuojat (§34): SYKE:n Hydrologiarajapinta on
 * julkinen (CC BY 4.0), mutta **5 minuutin välimuisti on vaatimus** — ilman sitä
 * jokainen avattu Saunat-sivu aiheuttaisi oman OData-kutsunsa.
 */
describe('veden lämpötilan kustannussuojat', () => {
  it('lähde on HTTPS ja asemana Näsijärvi', () => {
    expect(WATER_TEMPERATURE_URL.startsWith('https://')).toBe(true);
    expect(WATER_TEMPERATURE_STATION_NAME).toContain('Näsijärvi');
    expect(WATER_TEMPERATURE_PAIKKA_ID).toBeGreaterThan(0);
  });

  it('välimuisti on 5 minuuttia (vaatimus)', () => {
    expect(WATER_TEMPERATURE_CACHE_MS).toBe(5 * 60_000);
  });

  it('vanhaa lukemaa tarjotaan selvästi TTL:ää pidempään virhetilanteessa', () => {
    expect(WATER_TEMPERATURE_STALE_MAX_MS).toBeGreaterThan(WATER_TEMPERATURE_CACHE_MS);
    expect(WATER_TEMPERATURE_STALE_MAX_MS).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it('upstream-timeout mahtuu Lambdan timeoutiin (10 s)', () => {
    expect(WATER_TEMPERATURE_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WATER_TEMPERATURE_UPSTREAM_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('Lambdan varattu concurrency on pieni ja erillään muista reiteistä', () => {
    expect(WATER_TEMPERATURE_RESERVED_CONCURRENCY).toBeGreaterThan(0);
    expect(WATER_TEMPERATURE_RESERVED_CONCURRENCY).toBeLessThanOrEqual(3);
  });
});
