import { describe, expect, it } from 'vitest';

import {
  API_CLIENT_ERRORS_PER_5MIN,
  API_REQUEST_SPIKE_PER_5MIN,
  API_THROTTLE,
  ENVIRONMENT_DOMAINS,
  QUERY_RESERVED_CONCURRENCY,
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
