import { describe, expect, it } from 'vitest';

import { parseMode } from './params';

describe('parseMode', () => {
  it('hyväksyy sallitut muodot', () => {
    expect(parseMode('TRAM')).toBe('TRAM');
    expect(parseMode('BUS')).toBe('BUS');
  });

  it('ei välitä kirjainkoosta eikä ympäröivistä välilyönneistä', () => {
    expect(parseMode('tram')).toBe('TRAM');
    expect(parseMode(' bus ')).toBe('BUS');
  });

  it('puuttuva parametri tarkoittaa kaikkia ajoneuvoja', () => {
    expect(parseMode(undefined)).toBeUndefined();
    expect(parseMode(null)).toBeUndefined();
    expect(parseMode('')).toBeUndefined();
  });

  it('virheellinen arvo hylätään (kutsuja palauttaa 400)', () => {
    expect(parseMode('AUTO')).toBeNull();
    expect(parseMode('ratikka')).toBeNull();
  });
});
