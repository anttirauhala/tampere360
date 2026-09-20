/**
 * Lähteen raakadatan kenttien poiminta normalisointia varten.
 *
 * **Poliisin RSS:** jokaisella tiedotteella on `<link>`, joka vie tiedotteen
 * koko tekstiin poliisi.fi:ssä. Se on käyttäjälle arvokkain lisätieto, koska
 * syötteen `<description>` on vain otsikko uudelleen (`<p>otsikko</p>`).
 * Linkki viedään mallin `source.url`-kenttään — **ei infotekstiin** — jolloin
 * käyttöliittymä voi näyttää sen klikattavana ("Lue koko tiedote: poliisi.fi").
 * Infoteksti puolestaan jätetään pois, kun se toistaisi otsikon.
 */

/** Poistaa HTML-tagit ja ylimääräiset välilyönnit. */
export function stripHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sallitaan vain http(s)-linkit (ei esim. javascript:-URL:eja). */
export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Lähteen lisätietolinkki: RSS:n `link` tai valmiiksi normalisoitu `url`.
 * Palauttaa `undefined`, jos kelvollista http(s)-osoitetta ei ole.
 */
export function extractSourceUrl(raw: Record<string, unknown> | undefined): string | undefined {
  const candidate = raw?.['link'] ?? raw?.['url'];
  return isSafeHttpUrl(candidate) ? candidate.trim() : undefined;
}

/**
 * Kuvaus vain jos se tuo lisätietoa.
 *
 * RSS-syötteiden `<description>` on usein sama teksti kuin otsikko — poliisin
 * syötteessä **aina** (mahdollisesti `<p>`-tagien sisällä). Sellainen toisto
 * ei tuo käyttäjälle mitään, joten se jätetään pois.
 */
export function descriptionIfDistinct(
  raw: Record<string, unknown> | undefined,
  title: string,
): string | undefined {
  const description = stripHtml(raw?.['description']);
  if (!description) return undefined;
  return description === title.trim() ? undefined : description;
}
