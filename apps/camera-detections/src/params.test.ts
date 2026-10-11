import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  isValidCameraId,
  parseCursor,
  parseLimit,
  resolveListQuery,
} from './params';

describe('parseLimit', () => {
  it('palauttaa oletuksen, kun parametria ei ole', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('')).toBe(DEFAULT_LIMIT);
  });

  it('hyväksyy 1…MAX_LIMIT', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('12')).toBe(12);
    expect(parseLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
  });

  it('hylkää rajan ylittävät ja kelvottomat arvot (→ HTTP 400)', () => {
    // Kirjoitusvirhe ei saa näkyä hiljaisena tyhjänä listana.
    expect(parseLimit(String(MAX_LIMIT + 1))).toBeNull();
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('-5')).toBeNull();
    expect(parseLimit('abc')).toBeNull();
    expect(parseLimit('1.5')).toBeNull();
    expect(parseLimit('1000')).toBeNull();
  });
});

describe('parseCursor', () => {
  it('hyväksyy base64-muotoisen sivutusmerkin', () => {
    expect(parseCursor('eyJjYXB0dXJlZEF0RXBvY2giOjF9')).toBe('eyJjYXB0dXJlZEF0RXBvY2giOjF9');
    // base64 voi sisältää +, / ja = — ne enkoodataan URLSearchParamsilla.
    expect(parseCursor('a+b/c=')).toBe('a+b/c=');
  });

  it('palauttaa null, kun merkkiä ei ole', () => {
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor('')).toBeNull();
  });

  it('hylkää kelvottoman merkin (välilyönti, liian pitkä)', () => {
    expect(parseCursor('abc def')).toBeNull();
    expect(parseCursor('a'.repeat(1025))).toBeNull();
  });
});

describe('resolveListQuery', () => {
  it('ratkaisee oletuspyynnön', () => {
    expect(resolveListQuery({})).toEqual({
      ok: true,
      query: { limit: DEFAULT_LIMIT, cursor: null },
    });
  });

  it('kertoo virheestä ja ylärajasta', () => {
    expect(resolveListQuery({ limit: '99' })).toEqual({
      ok: false,
      error: 'INVALID_LIMIT',
      max: MAX_LIMIT,
    });
  });

  it('hylkää kelvottoman sivutusmerkin', () => {
    expect(resolveListQuery({ cursor: 'ei kelpaa' })).toEqual({
      ok: false,
      error: 'INVALID_CURSOR',
    });
  });

  it('ei hyväksy aikaikkunaparametria (vanhempia havaintoja ei voi pyytää)', () => {
    // Rajapinnassa ei ole `days`-parametria lainkaan: tuntematon parametri
    // jätetään huomiotta eikä se laajenna ikkunaa.
    const result = resolveListQuery({ days: '365' } as { limit?: string });
    expect(result).toEqual({ ok: true, query: { limit: DEFAULT_LIMIT, cursor: null } });
  });
});

describe('isValidCameraId', () => {
  it('hyväksyy lähdepalvelun tunnisteen (asema:preset)', () => {
    expect(isValidCameraId('C04546:C0454601')).toBe(true);
    expect(isValidCameraId('C04568')).toBe(true);
  });

  it('hylkää polku-injektion ja tyhjän', () => {
    // Tunniste menee suoraan upstream-polkuun (raakana, ks. analyzer.ts).
    expect(isValidCameraId('C04546/../admin')).toBe(false);
    expect(isValidCameraId('C04546 C0454601')).toBe(false);
    expect(isValidCameraId('')).toBe(false);
    expect(isValidCameraId(null)).toBe(false);
  });
});
