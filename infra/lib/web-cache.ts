/**
 * Frontendin CloudFront-välimuistipolitiikat (SPA).
 *
 * **Miksi tämä moduuli on olemassa (vika havaittu 27.9.2026):**
 *
 * Jakelun oletusbehavior käytti `CACHING_OPTIMIZED`-policya, jolloin
 * `index.html` jäi CloudFrontin välimuistiin **oletus-TTL:llä (1 vrk)**.
 * Samalla `BucketDeployment` poistaa vanhat Vite-chunkit (`prune: true`) ja
 * jokainen deploy tuottaa uudet hash-nimet. Seuraus: kauan auki ollut
 * välilehti käytti vanhaa `index.html`:ää, jonka lazy-chunkit oli jo poistettu
 * → selain sai SPA-fallbackin (`HTTP 200 + text/html`) ja dynaaminen import
 * kaatui virheeseen *"error loading dynamically imported module"*.
 *
 * Siksi jako on:
 *
 * | Polkukuvio | Policy | Miksi |
 * |---|---|---|
 * | oletus (`/`, `/kartta`, SPA-fallback) | `CACHING_DISABLED` | dokumentti on saatava aina tuoreena — se sisältää chunk-nimet |
 * | `assets/*` | tämä moduuli (1 v) | tiedostonimessä on sisällön hash: sama nimi = sama sisältö, joten pitkä cache on turvallinen |
 * | `config.json` | `CACHING_DISABLED` | API-osoite voi vaihtua deployn yhteydessä |
 *
 * Frontendin puoli samasta ongelmasta (jo avoinna olevat välilehdet) hoidetaan
 * `apps/web/src/lib/chunk-reload.ts`:llä: epäonnistunut dynaaminen import
 * johtaa yhteen uudelleenlataukseen.
 */

import * as cdk from 'aws-cdk-lib';
import type { CachePolicyProps, ResponseCustomHeader } from 'aws-cdk-lib/aws-cloudfront';

/** CloudFrontin polkukuvio Vite-buildin hashatuille asseteille (`dist/assets/*`). */
export const WEB_ASSETS_PATH_PATTERN = 'assets/*';

/**
 * Assettien TTL: **vuosi**. Turvallinen, koska Vite nimeää tiedostot sisällön
 * hashilla (`NysseMapPage-D7Zua3Am.js`) — sisältö ei voi muuttua samalla
 * nimellä. Uusi build = uusi nimi.
 */
export const WEB_ASSETS_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Dokumentin Cache-Control (selaimelle, ei CloudFrontille).
 *
 * Miksi tarvitaan: pelkkä `CACHING_DISABLED`-cache policy estää **CloudFrontin**
 * välimuistin, mutta **selain** voi silti käyttää heuristista välimuistia, jos
 * vastauksessa ei ole `Cache-Control`-otsaketta lainkaan (havaittu 1.10.2026:
 * CloudFrontin managed "CachingDisabled" ei lisää otsaketta). Sama
 * "vanha dokumentti + poistetut chunkit" -ongelma syntyisi siis selaimen
 * puolella. `override: true` varmistaa, että arvo tulee perille myös silloin,
 * jos origin joskus lähettäisi oman otsakkeen.
 */
export const WEB_DOCUMENT_CACHE_CONTROL = 'no-cache, no-store, max-age=0, must-revalidate';

/** Assettien Cache-Control selaimelle: hash-nimi sallii pitkän välimuistin. */
export const WEB_ASSETS_CACHE_CONTROL = `public, max-age=${WEB_ASSETS_TTL_SECONDS}, immutable`;

/** Cache-Control-otsake dokumentille (CloudFrontin response headers policy). */
export function documentCacheControlHeaders(): ResponseCustomHeader[] {
  return [{ header: 'Cache-Control', value: WEB_DOCUMENT_CACHE_CONTROL, override: true }];
}

/** Cache-Control-otsake hashatuille asseteille. */
export function assetCacheControlHeaders(): ResponseCustomHeader[] {
  return [{ header: 'Cache-Control', value: WEB_ASSETS_CACHE_CONTROL, override: true }];
}

/**
 * Assettien välimuistipolicy: yhden vuoden TTL kaikilla kolmella rajalla
 * (min/default/max), jotta CloudFront ei lyhennä eikä pidennä sitä
 * origin-otsakkeiden puuttuessa.
 */
export function webAssetsCachePolicyProps(cachePolicyName: string): CachePolicyProps {
  const ttl = cdk.Duration.seconds(WEB_ASSETS_TTL_SECONDS);
  return {
    cachePolicyName,
    comment: 'Tampere360: hashatut Vite-assetit (assets/*) — sisältö ei muutu samalla nimellä',
    minTtl: ttl,
    defaultTtl: ttl,
    maxTtl: ttl,
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
  };
}
