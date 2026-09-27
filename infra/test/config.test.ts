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
  STOP_CACHE_MS,
  STOP_DEPARTURE_LIMIT,
  STOP_PREVIEW_MINUTES,
  STOP_RESERVED_CONCURRENCY,
  STOP_STALE_MAX_MS,
  STOP_UPSTREAM_TIMEOUT_MS,
  VEHICLE_CACHE_MS,
  VEHICLE_MAX_AGE_MINUTES,
  VEHICLE_RESERVED_CONCURRENCY,
  VEHICLE_STALE_MAX_MS,
  VEHICLE_UPSTREAM_TIMEOUT_MS,
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
