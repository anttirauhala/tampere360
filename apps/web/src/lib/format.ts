/**
 * HTML-sanitointi (§14: lähteistä saatava HTML puhdistetaan ennen esittämistä).
 *
 * RSS-kuvaukset voivat sisältää HTML:ää. Emme koskaan käytä
 * dangerouslySetInnerHTML:ää — poistamme tagit ja purkamme yleiset
 * HTML-entiteetit, jolloin teksti renderöidään turvallisesti Reactin kautta.
 */

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

/**
 * Muotoilee ISO-aikaleiman suomenkieliseksi ajankohdaksi.
 * Mukana päivä, kuukausi JA vuosi (esim. "6.9.2026 klo 7.32").
 */
export function formatTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('fi-FI', {
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

/** Tilanteen aikakentät sellaisina kuin API ne palauttaa. */
export interface SituationTimes {
  startsAt?: string | null;
  publishedAt?: string | null;
  firstSeenAt?: string | null;
}

export interface TimeDescription {
  /** Pääteksti: "alkoi 20.9.2026 klo 08.53" tai "alkuaika ei tiedossa". */
  primary: string;
  /** Lisätieto: suhteellinen ikä ja/tai julkaisu-/havaintoaika. */
  detail: string;
  /** Onko tapahtuman oma alkuaika tiedossa. */
  isStartKnown: boolean;
}

/**
 * Kuvaa tilanteen ajankohdan käyttäjälle rehellisesti (§5).
 *
 * Jos lähde ei kerro tapahtuman alkuaikaa, sitä EI näytetä arvattuna:
 * päätekstinä on "alkuaika ei tiedossa" ja lisätietona lähteen julkaisuaika
 * ja/tai tekninen havaintoaika.
 */
export function describeSituationTime(times: SituationTimes): TimeDescription {
  const startsAt = times.startsAt ?? null;
  const publishedAt = times.publishedAt ?? null;
  const firstSeenAt = times.firstSeenAt ?? null;

  if (startsAt) {
    return {
      primary: `alkoi ${formatTime(startsAt)}`,
      detail: formatAge(startsAt),
      isStartKnown: true,
    };
  }

  const seenPart = firstSeenAt ? `havaittu ${formatAge(firstSeenAt)}` : '';
  const detail = publishedAt
    ? [`julkaistu ${formatTime(publishedAt)}`, seenPart].filter(Boolean).join(' · ')
    : seenPart;

  return { primary: 'alkuaika ei tiedossa', detail, isStartKnown: false };
}
