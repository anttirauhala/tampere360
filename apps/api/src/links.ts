/**
 * Tilanteen lisätietolinkin ratkaisu API-vastaukseen.
 *
 * Ensisijainen lähde on `event.source.url` (normalisoija asettaa sen lähteen
 * linkistä). **Poliisin RSS:ssä `sourceId` on tiedotteen URL** (`guid` on
 * `https://poliisi.fi/-/...`), joten se kelpaa linkiksi myös niille riveille,
 * jotka on kirjoitettu ennen kuin `source.url` otettiin käyttöön — näin
 * vanhoja tiedotteita ei tarvitse käsitellä uudelleen.
 *
 * Vain http(s)-osoitteet hyväksytään, jotta esim. `javascript:`-URL ei koskaan
 * päädy käyttöliittymän linkiksi.
 */

/** Palauttaa arvon vain jos se on kelvollinen http(s)-osoite. */
export function asHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Tapahtuman lisätietolinkki: `source.url` → `sourceId` (jos URL) → null. */
export function situationSourceUrl(event: unknown): string | null {
  const source = (event as { source?: { url?: unknown; sourceId?: unknown } } | undefined)?.source;
  return asHttpUrl(source?.url) ?? asHttpUrl(source?.sourceId);
}
