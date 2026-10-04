/**
 * HTML-sanitointi (§14: lähteistä saatava HTML puhdistetaan ennen esittämistä).
 *
 * RSS-kuvaukset voivat sisältää HTML:ää. Emme koskaan käytä
 * dangerouslySetInnerHTML:ää — poistamme tagit ja purkamme yleiset
 * HTML-entiteetit, jolloin teksti renderöidään turvallisesti Reactin kautta.
 */

/**
 * Palvelun aikavyöhyke: kaikki kellonajat näytetään Suomen ajassa.
 *
 * Kellonajan näyttäminen selaimen omalla aikavyöhykkeellä olisi tässä
 * palvelussa virhe: data on suomalaista (liikenne, sää, kamerat), ja
 * esimerkiksi UTC:llä ajettava selain tai ulkomailla oleva käyttäjä näkisi
 * ajat väärin. Kiinnittämällä vyöhyke myös kesä- ja talviaika hoituvat
 * automaattisesti.
 */
export const HELSINKI_TIME_ZONE = 'Europe/Helsinki';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&auml;': 'ä',
  '&ouml;': 'ö',
  '&Auml;': 'Ä',
  '&Ouml;': 'Ö',
};

/** Poistaa HTML-tagit ja normalisoi välilyönnit. */
export function sanitizeText(input: string | undefined | null): string {
  if (!input) return '';

  let text = String(input);

  // Kaksinkertaisesti koodatut entiteetit (&amp;lt;p&amp;gt;)
  for (let i = 0; i < 2; i += 1) {
    text = text.replace(/&[a-zA-Z]+;|&#\d+;/g, (match) => ENTITIES[match] ?? match);
  }

  // Poista tagit
  text = text.replace(/<[^>]*>/g, ' ');

  // Normalisoi välilyönnit ja rivinvaihdot
  return text.replace(/\s+/g, ' ').trim();
}

/** Ajankohdan muotoiluvalinnat. */
export interface TimeFormatOptions {
  /**
   * Näytä viikonpäivä lyhenteenä ajankohdan edessä, esim. `la 3.10.2026 klo 07.00`.
   * Lyhenne on pienellä alkukirjaimella (fi-FI: `ma`, `ti`, `ke` …).
   * Oletus: ei viikonpäivää (`3.10.2026 klo 07.00`).
   */
  weekday?: boolean;
}

/**
 * Muotoilee ISO-aikaleiman suomenkieliseksi ajankohdaksi.
 * Mukana päivä, kuukausi JA vuosi (esim. "6.9.2026 klo 7.32").
 * `options.weekday` lisää viikonpäivälyhenteen eteen (esim. "la 3.10.2026 klo 07.00").
 *
 * Aikavyöhyke on aina Suomen aika (ks. `HELSINKI_TIME_ZONE`): tapahtumat,
 * varoitukset ja kamerakuvat ovat suomalaisia, joten käyttäjän selaimen
 * aikavyöhyke ei saa muuttaa näytettyä kellonaikaa. Ilman tätä asetusta
 * esimerkiksi UTC:llä ajettava selain (tai ulkomailla oleva käyttäjä) näkisi
 * kellonajan 3 tuntia pielessä.
 */
export function formatTime(iso: string | undefined | null, options?: TimeFormatOptions): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('fi-FI', {
    timeZone: HELSINKI_TIME_ZONE,
    ...(options?.weekday ? { weekday: 'short' as const } : {}),
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Muotoilee "kuinka kauan sitten" -tekstin. */
export function formatAge(iso: string | undefined | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'juuri nyt';
  if (minutes < 60) return `${minutes} min sitten`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h sitten`;
  return `${Math.floor(hours / 24)} vrk sitten`;
}

/**
 * Infoteksti vain jos se tuo lisätietoa.
 *
 * RSS-syötteissä `<description>` on usein sama teksti kuin otsikko —
 * poliisin syötteessä aina (<p>otsikko</p>). Silloin teksti näkyisi
 * käyttäjälle turhana toistona, joten se jätetään pois. Tämä koskee myös
 * vanhoja rivejä, joissa toisto on jo tallennettu kantaan.
 */
export function distinctDescription(title: string, description: string | null | undefined): string {
  const text = description ?? '';
  if (!text) return '';
  return text === title ? '' : text;
}

/**
 * Lähteen lisätietolinkki (esim. poliisin tiedote poliisi.fi:ssä) turvallisesti
 * renderoitavaksi.
 *
 * Palauttaa `null`, jos osoite puuttuu tai ei ole http(s) — esimerkiksi
 * `javascript:`-osoitetta ei koskaan renderöidä linkkinä. Otsikko on
 * verkkotunnus ilman `www.`-etuliitettä (esim. "poliisi.fi").
 */
export function sourceLink(url: string | null | undefined): { href: string; label: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const label = parsed.hostname.replace(/^www\./, '');
    return label ? { href: parsed.toString(), label } : null;
  } catch {
    return null;
  }
}

/** Tilanteen aikakentät sellaisina kuin API ne palauttaa. */
export interface SituationTimes {
  startsAt?: string | null;
  publishedAt?: string | null;
  firstSeenAt?: string | null;
}

/**
 * Lyhyt aikateksti koostekortille.
 *
 * Palauttaa "Alkaa 20.9.2026 klo 08.53", jos lähteen oma alkuaika on
 * **tulevaisuudessa**, muuten "Alkoi …". Jos alkuaikaa ei ole, palautetaan
 * "Julkaistu 17.9.2026 klo 10.56". Sana kertoo aina, kumpi aika on kyseessä,
 * jotta julkaisuaika ei näytä tapahtuman alkuajalta (§20). Säävaroituksen
 * alkuaika on usein tulevaisuudessa, joten "Alkoi" olisi siinä harhaanjohtava.
 *
 * `options.weekday` lisää viikonpäivän ajankohdan eteen (esim. Nyt-sivun
 * kortit: "la 3.10.2026 klo 07.00").
 */
export function formatCompactTime(times: SituationTimes, options?: TimeFormatOptions): string {
  const startsAt = times.startsAt ?? null;
  if (startsAt) {
    const label = isFuture(startsAt) ? 'Alkaa' : 'Alkoi';
    return `${label} ${formatTime(startsAt, options)}`;
  }

  const publishedAt = times.publishedAt ?? null;
  if (publishedAt) return `Julkaistu ${formatTime(publishedAt, options)}`;

  return '';
}

/** Onko aikaleima tulevaisuudessa suhteessa nykyhetkeen. */
function isFuture(iso: string): boolean {
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms > Date.now();
}
