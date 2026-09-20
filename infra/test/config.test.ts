import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_DOMAINS, frontendDomainNames, frontendOrigins } from '../lib/config';

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
