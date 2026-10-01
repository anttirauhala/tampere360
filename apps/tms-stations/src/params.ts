/**
 * Parametrien validointi (`GET /v1/tms/stations/{tmsNumber}/history`, §30).
 *
 * Kaikki parametrit validoidaan ennen upstream-kutsua, koska ne päätyvät
 * Digitrafficin kyselymerkkijonoon. Virheellinen arvo on **HTTP 400**, ei
 * hiljainen tyhjä vastaus: muuten kirjoitusvirhe (`typ=daily`) näkyisi
 * käyttäjälle "ei tietoja" -tilana, jota olisi mahdotonta erottaa oikeasta
 * tyhjästä datasta (sama periaate kuin `/v1/vehicles?mode=`).
 */

export const HISTORY_TYPES = ['daily', 'hourly', 'speed', 'all'] as const;
export type HistoryType = (typeof HISTORY_TYPES)[number];

/** TMS-numero on 1–4 numeroa (Tampereella 438, valtakunnallisesti 1–9999). */
export const TMS_NUMBER_PATTERN = /^\d{1,4}$/;

/** Vakiojakso: viimeiset 14 täyttä vuorokautta. */
export const DEFAULT_HISTORY_DAYS = 14;
export const MAX_HISTORY_DAYS = 31;

/** Aseman `tmsNumber` polusta, tai `null` jos muoto on virheellinen. */
export function parseTmsNumber(raw: string | null | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!TMS_NUMBER_PATTERN.test(value)) return null;
  const number = Number(value);
  return number >= 1 && number <= 9999 ? number : null;
}

/** Historian tyyppi; puuttuva arvo tarkoittaa oletusta (`daily`). */
export function parseHistoryType(raw: string | null | undefined): HistoryType | null {
  if (raw === undefined || raw === null || raw === '') return 'daily';
  const value = raw.trim().toLowerCase();
  return (HISTORY_TYPES as readonly string[]).includes(value) ? (value as HistoryType) : null;
}

/** Päivien määrä: 1…`MAX_HISTORY_DAYS`; kelvoton arvo → `null`. */
export function parseDays(
  raw: string | null | undefined,
  fallback: number = DEFAULT_HISTORY_DAYS,
): number | null {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^\d{1,2}$/.test(raw.trim())) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_HISTORY_DAYS ? value : null;
}

/** `YYYY-MM-DD` (kelvollinen kalenteripäivä), tai `null`. */
export function parseIsoDate(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [, year, month, day] = match;
  if (!year || !month || !day) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Karkaa kuukauden/päivän ulkopuolelle (esim. 2026-02-31) → ei kelpaa.
  return date.toISOString().slice(0, 10) === value ? value : null;
}

/** `YYYY-MM` (kelvollinen kuukausi), tai `null`. */
export function parseMonth(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = raw.trim();
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month] = match;
  if (!year || !month) return null;
  const monthNumber = Number(month);
  return monthNumber >= 1 && monthNumber <= 12 ? `${year}-${month}` : null;
}

/** ISO-päivä `offsetDays` päivää taaksepäin annetusta hetkestä (UTC). */
export function isoDateOffset(nowMs: number, offsetDays: number): string {
  return new Date(nowMs - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Oletusarvo tuntijakaumalle: **eilen**.
 *
 * Tämä on tarkoituksellinen valinta: kuluvan vuorokauden tuntijakauma on
 * kesken, ja sen näyttäminen täytenä päivänä johtaisi siihen, että illalla
 * näkyisi "nolla" tulevilta tunneilta. Täysi vuorokausi on rehellinen.
 */
export function defaultHourlyDate(nowMs: number): string {
  return isoDateOffset(nowMs, 1);
}

/** Oletusjakso vuorokausisarjalle: `days` täyttä vuorokautta päättyen eiliseen. */
export function defaultDateRange(nowMs: number, days: number): { from: string; to: string } {
  return { from: isoDateOffset(nowMs, days), to: isoDateOffset(nowMs, 1) };
}

/** Kuluva kuukausi muodossa `YYYY-MM`. */
export function currentMonth(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/** Ratkaistu historiapyyntö: kaikki jaksot valmiina upstream-kutsuja varten. */
export interface HistoryQuery {
  type: HistoryType;
  days: number;
  /** Vuorokausisarjan aikaväli (`type=daily` ja `all`). */
  from: string;
  to: string;
  /** Tuntijakauman päivä (`type=hourly` ja `all`). */
  date: string;
  /** Keskinopeuksien kuukausi (`type=speed` ja `all`). */
  month: string;
}

export type HistoryQueryResult =
  | { ok: true; query: HistoryQuery }
  | { ok: false; error: string; allowed?: readonly string[]; max?: number };

/**
 * Validoi ja ratkaisee historiapyynnön parametrit.
 *
 * Yksi funktio, koska `type=all` tarvitsee **kaikki** jaksot kerralla: jos
 * jokainen tyyppi validoisi omansa, `all`-polku toistaisi saman logiikan
 * kolmesti ja olisi helppo saada epäjohdonmukaiseksi.
 */
export function resolveHistoryQuery(
  rawType: string | null | undefined,
  params: { days?: string; date?: string; month?: string },
  nowMs: number,
  defaultDays: number = DEFAULT_HISTORY_DAYS,
): HistoryQueryResult {
  const type = parseHistoryType(rawType);
  if (type === null) {
    return { ok: false, error: 'INVALID_TYPE', allowed: HISTORY_TYPES };
  }

  const needsDaily = type === 'daily' || type === 'all';
  const needsHourly = type === 'hourly' || type === 'all';
  const needsSpeed = type === 'speed' || type === 'all';

  let days = defaultDays;
  if (needsDaily) {
    const parsedDays = parseDays(params.days, defaultDays);
    if (parsedDays === null) return { ok: false, error: 'INVALID_DAYS', max: MAX_HISTORY_DAYS };
    days = parsedDays;
  }

  let date = defaultHourlyDate(nowMs);
  if (needsHourly && params.date !== undefined && params.date !== '') {
    const parsedDate = parseIsoDate(params.date);
    if (parsedDate === null) return { ok: false, error: 'INVALID_DATE' };
    date = parsedDate;
  }

  let month = currentMonth(nowMs);
  if (needsSpeed && params.month !== undefined && params.month !== '') {
    const parsedMonth = parseMonth(params.month);
    if (parsedMonth === null) return { ok: false, error: 'INVALID_MONTH' };
    month = parsedMonth;
  }

  const range = defaultDateRange(nowMs, days);
  return { ok: true, query: { type, days, from: range.from, to: range.to, date, month } };
}
