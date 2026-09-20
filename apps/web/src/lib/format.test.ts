import { describe, expect, it } from 'vitest';

import { formatAge, formatTime, sanitizeText } from './format';

describe('sanitizeText', () => {
  it('palauttaa tyhjän merkkijonolle, jonka arvo puuttuu', () => {
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText('')).toBe('');
  });

  it('poistaa HTML-tagit', () => {
    expect(sanitizeText('<p>Liikenne<strong>onnettomuus</strong> Rantaväylällä</p>')).toBe(
      'Liikenne onnettomuus Rantaväylällä',
    );
  });

  it('poistaa script-tagin sisältöä ympäröivät tagit', () => {
    expect(sanitizeText('<script>alert("x")</script>Teksti')).toBe('alert("x") Teksti');
  });

  it('purkaa HTML-entiteetit', () => {
    expect(sanitizeText('Hämeenkatu&nbsp;&amp;&nbsp;Itsenäisyydenkatu')).toBe(
      'Hämeenkatu & Itsenäisyydenkatu',
    );
  });

  it('purkaa kaksinkertaisesti koodatut entiteetit', () => {
    expect(sanitizeText('&amp;lt;p&amp;gt;Teksti&amp;lt;/p&amp;gt;')).toBe('Teksti');
  });

  it('normalisoi välilyönnit ja rivinvaihdot', () => {
    expect(sanitizeText('  Rivi 1\n\n   Rivi 2  ')).toBe('Rivi 1 Rivi 2');
  });
});

describe('formatTime', () => {
  it('palauttaa tyhjän virheelliselle aikaleimalle', () => {
    expect(formatTime(undefined)).toBe('');
    expect(formatTime(null)).toBe('');
    expect(formatTime('ei-aikaleima')).toBe('');
  });

  it('näyttää päivän, kuukauden ja vuoden', () => {
    // Paikallinen aika 6.9.2026 klo 7.32 → "6.9.2026 klo 7.32"
    const local = new Date(2026, 8, 6, 7, 32).toISOString();
    expect(formatTime(local)).toContain('6.9.2026');
  });

  it('näyttää vuoden myös muilla vuosikymmenillä', () => {
    expect(formatTime(new Date(2019, 5, 15, 12, 0).toISOString())).toContain('2019');
    expect(formatTime(new Date(2031, 0, 2, 12, 0).toISOString())).toContain('2031');
  });

  it('ei jätä vuotta pois (regressiosuoja)', () => {
    const formatted = formatTime(new Date(2026, 8, 6, 7, 32).toISOString());
    expect(formatted).toMatch(/\d\.\d\.\d{4}\b/);
    expect(formatted).toContain('klo');
  });
});

describe('formatAge', () => {
  it('palauttaa tyhjän puuttuvalle aikaleimalle', () => {
    expect(formatAge(null)).toBe('');
    expect(formatAge(undefined)).toBe('');
    expect(formatAge('ei-aikaleima')).toBe('');
  });

  it('tunnistaa tuoreen aikaleiman', () => {
    expect(formatAge(new Date(Date.now() - 5_000).toISOString())).toBe('juuri nyt');
  });

  it('ilmoittaa minuutit ja tunnit', () => {
    expect(formatAge(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 min sitten');
    expect(formatAge(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3 h sitten');
    expect(formatAge(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2 vrk sitten');
  });
});
