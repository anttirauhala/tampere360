import { describe, expect, it } from 'vitest';

import {
  describeSituationTime,
  formatAge,
  formatTime,
  sanitizeText,
} from './format';

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

describe('describeSituationTime', () => {
  // Paikalliset ajat → testit eivät riipu aikavyöhykkeestä.
  const startsAt = new Date(2026, 8, 20, 8, 53).toISOString();
  const publishedAt = new Date(2026, 8, 17, 7, 56).toISOString();
  const firstSeenAt = new Date(2026, 8, 18, 22, 48).toISOString();

  it('näyttää alkuaian, kun lähde antaa sen', () => {
    const result = describeSituationTime({ startsAt, publishedAt, firstSeenAt });
    expect(result.isStartKnown).toBe(true);
    expect(result.primary).toBe('alkoi 20.9.2026 klo 08.53');
    // Suhteellinen ikä riippuu kellonajasta → tarkistetaan muoto, ei arvoa.
    expect(result.detail).toMatch(/^(juuri nyt|.+ sitten)$/);
  });

  it('ilmoittaa "alkuaika ei tiedossa" kun lähteellä ei ole alkuaikaa', () => {
    const result = describeSituationTime({ startsAt: null, publishedAt, firstSeenAt });
    expect(result.isStartKnown).toBe(false);
    expect(result.primary).toBe('alkuaika ei tiedossa');
  });

  it('ei korvaa puuttuvaa alkuaikaa julkaisuajalla (regressiosuoja)', () => {
    // Julkaisuaika näytetään erikseen lisätietona, EI alkuaikana.
    const result = describeSituationTime({ startsAt: null, publishedAt, firstSeenAt });
    expect(result.primary).not.toContain('17.9.2026');
    expect(result.detail).toContain('julkaistu 17.9.2026 klo 07.56');
  });

  it('näyttää julkaisuajan ja havaintoajan lisätietona', () => {
    const result = describeSituationTime({ startsAt: null, publishedAt, firstSeenAt });
    expect(result.detail).toContain('julkaistu');
    expect(result.detail).toContain('havaittu');
  });

  it('näyttää pelkän havaintoajan, jos julkaisuaikaa ei ole', () => {
    const result = describeSituationTime({ startsAt: null, firstSeenAt });
    expect(result.detail).toMatch(/^havaittu /);
  });

  it('kestää täysin puuttuvat ajat', () => {
    const result = describeSituationTime({});
    expect(result.primary).toBe('alkuaika ei tiedossa');
    expect(result.detail).toBe('');
    expect(result.isStartKnown).toBe(false);
  });
});
