import { describe, expect, it } from 'vitest';

import { isUlid, ulid } from './ids';

describe('ulid', () => {
  it('generoi 26 merkin tunnisteen', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
  });

  it('generoi vain Crockford base32 -merkkejä', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isUlid(ulid())).toBe(true);
    }
  });

  it('on aikajärjestystä säilyttävä (aikaleima alussa)', () => {
    const earlier = ulid(1_000_000);
    const later = ulid(9_999_999_999_999);
    expect(earlier < later).toBe(true);
  });

  it('generoi uniikkeja tunnisteita', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      ids.add(ulid());
    }
    expect(ids.size).toBe(1000);
  });

  it('sama aikaleima, eri satunnaisuus', () => {
    const time = Date.now();
    const a = ulid(time);
    const b = ulid(time);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10)); // sama aikaleima
    expect(a.slice(10)).not.toBe(b.slice(10)); // eri satunnaisuus
  });
});

describe('isUlid', () => {
  it('hylkää virheelliset merkkijonot', () => {
    expect(isUlid('')).toBe(false);
    expect(isUlid('too-short')).toBe(false);
    expect(isUlid('x'.repeat(26))).toBe(false); // x ei kuulu joukkoon
    expect(isUlid('U'.repeat(26))).toBe(false); // U ei kuulu joukkoon
    expect(isUlid('L'.repeat(26))).toBe(false); // L ei kuulu joukkoon
  });
});
