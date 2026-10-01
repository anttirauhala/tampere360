import { describe, expect, it } from 'vitest';

import {
  currentMonth,
  defaultDateRange,
  defaultHourlyDate,
  isoDateOffset,
  parseDays,
  parseHistoryType,
  parseIsoDate,
  parseMonth,
  parseTmsNumber,
  resolveHistoryQuery,
} from './params';

describe('parseTmsNumber', () => {
  it('hyväksyy aseman tmsNumberin (1–9999)', () => {
    expect(parseTmsNumber('438')).toBe(438);
    expect(parseTmsNumber(' 438 ')).toBe(438);
    expect(parseTmsNumber('1')).toBe(1);
  });

  it('hylkää virheelliset tunnisteet', () => {
    // 23438 on aseman `id`, ei `tmsNumber` — historia-rajapinta hylkäisi sen.
    expect(parseTmsNumber('23438')).toBeNull();
    expect(parseTmsNumber('0')).toBeNull();
    expect(parseTmsNumber('10000')).toBeNull();
    expect(parseTmsNumber('438a')).toBeNull();
    expect(parseTmsNumber('-1')).toBeNull();
    expect(parseTmsNumber('')).toBeNull();
    expect(parseTmsNumber(undefined)).toBeNull();
  });
});

describe('parseHistoryType', () => {
  it('oletus on daily', () => {
    expect(parseHistoryType(undefined)).toBe('daily');
    expect(parseHistoryType('')).toBe('daily');
  });

  it('hyväksyy tunnetut tyypit kirjainkoosta riippumatta', () => {
    expect(parseHistoryType('daily')).toBe('daily');
    expect(parseHistoryType('HOURLY')).toBe('hourly');
    expect(parseHistoryType('speed')).toBe('speed');
  });

  it('hylkää tuntemattoman tyypin (ei hiljaista oletusta)', () => {
    expect(parseHistoryType('typ')).toBeNull();
    expect(parseHistoryType('week')).toBeNull();
  });
});

describe('parseDays', () => {
  it('oletus 14 päivää', () => {
    expect(parseDays(undefined)).toBe(14);
    expect(parseDays('')).toBe(14);
  });

  it('hyväksyy 1–31 päivää', () => {
    expect(parseDays('1')).toBe(1);
    expect(parseDays('31')).toBe(31);
  });

  it('hylkää rajojen ulkopuoliset ja kelvottomat arvot', () => {
    expect(parseDays('0')).toBeNull();
    expect(parseDays('32')).toBeNull();
    expect(parseDays('abc')).toBeNull();
    expect(parseDays('-3')).toBeNull();
  });
});

describe('parseIsoDate', () => {
  it('hyväksyy kelvollisen päivämäärän', () => {
    expect(parseIsoDate('2026-09-26')).toBe('2026-09-26');
  });

  it('hylkää väärän muodon ja olematoman päivän', () => {
    expect(parseIsoDate('20260926')).toBeNull();
    expect(parseIsoDate('2026-02-31')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
  });
});

describe('parseMonth', () => {
  it('hyväksyy kuukauden ja hylkää virheelliset', () => {
    expect(parseMonth('2026-09')).toBe('2026-09');
    expect(parseMonth('2026-13')).toBeNull();
    expect(parseMonth('2026-9')).toBeNull();
    expect(parseMonth('2026-09-26')).toBeNull();
    expect(parseMonth(undefined)).toBeNull();
  });
});

describe('oletusjaksot (lähteen päättyneet vuorokaudet)', () => {
  // 27.9.2026 klo 18.00 Suomen aikaa (15.00 UTC).
  const nowMs = Date.parse('2026-09-27T15:00:00Z');

  it('isoDateOffset laskee päiviä taaksepäin', () => {
    expect(isoDateOffset(nowMs, 1)).toBe('2026-09-26');
    expect(isoDateOffset(nowMs, 14)).toBe('2026-09-13');
    expect(isoDateOffset(nowMs, 0)).toBe('2026-09-27');
  });

  it('tuntijakauman oletus on eilen (täysi vuorokausi)', () => {
    expect(defaultHourlyDate(nowMs)).toBe('2026-09-26');
  });

  it('vuorokausisarjan oletus on 14 täyttä vuorokautta päättyen eiliseen', () => {
    expect(defaultDateRange(nowMs, 14)).toEqual({ from: '2026-09-13', to: '2026-09-26' });
  });

  it('kuluva kuukausi muodossa YYYY-MM', () => {
    expect(currentMonth(nowMs)).toBe('2026-09');
  });
});

/**
 * `resolveHistoryQuery` ratkaisee kaikki jaksot kerralla — myös `type=all`,
 * joka on sivun käyttämä tyyppi (yksi pyyntö kolmen sijaan, ks.
 * docs/architecture/tms-stations.md).
 */
describe('resolveHistoryQuery', () => {
  const nowMs = Date.parse('2026-09-27T15:00:00Z');

  it('ratkaisee oletukset (daily, 14 vrk, eilinen, kuluva kuukausi)', () => {
    const result = resolveHistoryQuery(undefined, {}, nowMs);
    expect(result).toEqual({
      ok: true,
      query: {
        type: 'daily',
        days: 14,
        from: '2026-09-13',
        to: '2026-09-26',
        date: '2026-09-26',
        month: '2026-09',
      },
    });
  });

  it('kunnioittaa days-parametria vain kun sitä tarvitaan', () => {
    const daily = resolveHistoryQuery('daily', { days: '7' }, nowMs);
    expect(daily.ok && daily.query.from).toBe('2026-09-20');

    // hourly ei tarvitse päiviä, joten kelvoton arvo ei kaada pyyntöä.
    const hourly = resolveHistoryQuery('hourly', { days: 'rikki' }, nowMs);
    expect(hourly.ok).toBe(true);
  });

  it('validoi annetun päivän ja kuukauden', () => {
    const bad = resolveHistoryQuery('hourly', { date: '2026-02-31' }, nowMs);
    expect(bad).toEqual({ ok: false, error: 'INVALID_DATE' });

    const badMonth = resolveHistoryQuery('speed', { month: '2026-13' }, nowMs);
    expect(badMonth).toEqual({ ok: false, error: 'INVALID_MONTH' });

    const good = resolveHistoryQuery('hourly', { date: '2026-09-20' }, nowMs);
    expect(good.ok && good.query.date).toBe('2026-09-20');

    const goodMonth = resolveHistoryQuery('speed', { month: '2026-08' }, nowMs);
    expect(goodMonth.ok && goodMonth.query.month).toBe('2026-08');
  });

  it('hylkää tuntemattoman tyypin ja luettelee sallitut', () => {
    const result = resolveHistoryQuery('typ', {}, nowMs);
    expect(result).toEqual({
      ok: false,
      error: 'INVALID_TYPE',
      allowed: ['daily', 'hourly', 'speed', 'all'],
    });
  });

  it('hylkää liian suuren days-arvon', () => {
    expect(resolveHistoryQuery('daily', { days: '99' }, nowMs)).toEqual({
      ok: false,
      error: 'INVALID_DAYS',
      max: 31,
    });
  });

  it('all palauttaa kaikki kolme jaksoa samalla kutsulla', () => {
    const result = resolveHistoryQuery('all', {}, nowMs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query).toEqual({
      type: 'all',
      days: 14,
      from: '2026-09-13',
      to: '2026-09-26',
      date: '2026-09-26',
      month: '2026-09',
    });
  });

  it('all validoi kaikki antamansa parametrit', () => {
    expect(resolveHistoryQuery('all', { days: '0' }, nowMs)).toMatchObject({
      error: 'INVALID_DAYS',
    });
    expect(resolveHistoryQuery('all', { date: 'x' }, nowMs)).toMatchObject({
      error: 'INVALID_DATE',
    });
    expect(resolveHistoryQuery('all', { month: 'x' }, nowMs)).toMatchObject({
      error: 'INVALID_MONTH',
    });
  });
});
