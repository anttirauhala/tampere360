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
    expect(formatTime('ei-aikaleima')).toBe('');
  });

  it('muotoilee kelvollisen ISO-aikaleiman', () => {
    expect(formatTime('2026-09-06T07:32:00Z')).not.toBe('');
  });
});

describe('formatAge', () => {
  it('palauttaa tyhjän puuttuvalle aikaleimalle', () => {
    expect(formatAge(null)).toBe('');
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
