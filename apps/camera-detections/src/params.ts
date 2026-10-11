/**
 * Parametrien validointi (`GET /v1/camera-detections`, §43).
 *
 * Kaikki parametrit validoidaan ennen upstream-kutsua. Virheellinen arvo on
 * **HTTP 400**, ei hiljainen tyhjä vastaus: muuten kirjoitusvirhe (`limit=abc`)
 * näkyisi käyttäjälle "ei havaintoja" -tilana, jota olisi mahdotonta erottaa
 * oikeasta tyhjästä tuloksesta (sama periaate kuin `/v1/tms/stations`issa ja
 * `/v1/vehicles?mode=`issa).
 */

/** Oletusmäärä: kuinka monta havaintoa yhdellä sivulla näytetään. */
export const DEFAULT_LIMIT = 12;

/**
 * Yläraja omalle reitille.
 *
 * Jokainen havainto maksaa kaksi upstream-kutsua (detalji + presigned-URL) ja
 * yhden kuvan selaimessa (~212 kt), joten 30 on tarkoituksellisesti pieni.
 * Upstreamin oma raja on 100.
 */
export const MAX_LIMIT = 30;

/** Upstreamin `/detections`-rajapinta hyväksyy enintään 100 riviä. */
export const UPSTREAM_MAX_LIMIT = 100;

/**
 * Näytettävä aikaikkuna vuorokausina — **kiinteä 60**.
 *
 * Tämä ei ole oletus vaan raja: **vanhempia havaintoja ei näytetä eikä niitä voi
 * pyytää** (ei `days`-parametria). Perustelu on lähdepalvelun elinkaari:
 * raw-bucket siirtää kuvat 90 päivän jälkeen Glacier-luokkaan, jolloin kuvan GET
 * palauttaa 403 (mitattu 11.10.2026: 22.2.2026 → 403, sama päivä → 206).
 * 60 vrk jää selvästi sen alle, joten näkymän jokaisella kortilla on
 * lähtökohtaisesti alkuperäinen kuva — ja alkuperäinen kuva on näkymän pointti.
 *
 * Arvo voidaan asettaa ympäristömuuttujalla (`DETECTION_WINDOW_DAYS`, ks.
 * infra/lib/config.ts), mutta käyttäjä ei voi laajentaa sitä.
 */
export const DEFAULT_WINDOW_DAYS = 60;

/** Kameratunniste on muotoa `C04546:C0454601` (asema:preset). */
export const CAMERA_ID_PATTERN = /^[A-Za-z0-9:_-]{1,32}$/;

/** Onko tunniste turvallinen polkuun (estää polku-injektion detaljikutsussa). */
export function isValidCameraId(raw: string | null | undefined): boolean {
  return CAMERA_ID_PATTERN.test((raw ?? '').trim());
}

/** Sivun koko: 1…`MAX_LIMIT`; kelvoton arvo → `null` (→ HTTP 400). */
export function parseLimit(
  raw: string | null | undefined,
  fallback: number = DEFAULT_LIMIT,
): number | null {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_LIMIT ? value : null;
}

/**
 * Sivutusmerkki on upstreamin läpinäkymätön `nextToken`.
 *
 * Emme tulkitse sitä, mutta rajaamme pituuden ja merkkivalikoiman, koska se
 * välitetään eteenpäin kyselymerkkijonossa. `+`, `/` ja `=` ovat sallittuja
 * (base64) ja ne enkoodataan URLSearchParamsilla.
 */
export function parseCursor(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = raw.trim();
  return /^[A-Za-z0-9+/=_-]{1,1024}$/.test(value) ? value : null;
}

/** Ratkaistu listapyyntö. */
export interface ListQuery {
  limit: number;
  cursor: string | null;
}

export type ListQueryResult =
  { ok: true; query: ListQuery } | { ok: false; error: string; max?: number };

/** Validoi `limit`- ja `cursor`-parametrit. */
export function resolveListQuery(params: {
  limit?: string | null;
  cursor?: string | null;
}): ListQueryResult {
  const limit = parseLimit(params.limit);
  if (limit === null) return { ok: false, error: 'INVALID_LIMIT', max: MAX_LIMIT };

  const cursor = parseCursor(params.cursor);
  if (
    params.cursor !== undefined &&
    params.cursor !== null &&
    params.cursor !== '' &&
    cursor === null
  ) {
    return { ok: false, error: 'INVALID_CURSOR' };
  }

  return { ok: true, query: { limit, cursor } };
}
