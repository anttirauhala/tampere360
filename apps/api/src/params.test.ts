import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMIT, MAX_LIMIT, parseLimit } from './params';

describe('parseLimit', () => {
  it('palauttaa oletuksen, kun parametria ei ole', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('')).toBe(DEFAULT_LIMIT);
  });

  it('palauttaa oletuksen virheelliselle arvolle', () => {
    expect(parseLimit('abc')).toBe(DEFAULT_LIMIT);
    expect(parseLimit('0')).toBe(DEFAULT_LIMIT);
    // Negatiivinen arvo hylättäisiin DynamoDB:ssä → käytetään oletusta.
    expect(parseLimit('-5')).toBe(DEFAULT_LIMIT);
  });

  it('hyväksyy normaalin arvon', () => {
    expect(parseLimit('50')).toBe(50);
  });

  it('rajaa ylärajaan', () => {
    expect(parseLimit('100000')).toBe(MAX_LIMIT);
  });

  it('pyöristää desimaalit alaspäin', () => {
    expect(parseLimit('12.9')).toBe(12);
  });

  it('oletus on pieni (kustannussuoja: DynamoDB-lukemat)', () => {
    expect(DEFAULT_LIMIT).toBeLessThanOrEqual(20);
  });
});
