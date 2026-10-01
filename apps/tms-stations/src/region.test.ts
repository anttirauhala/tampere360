import { describe, expect, it } from 'vitest';

import { REGION_BOUNDS, inTampereRegion, roadFromName, stationTitle } from './region';

describe('inTampereRegion', () => {
  it('hyväksyy Tampereen seudun pisteet', () => {
    // Keskustori
    expect(inTampereRegion(61.4978, 23.761)).toBe(true);
    // vt3_Tampere_Multisilta
    expect(inTampereRegion(61.492, 23.679)).toBe(true);
    // Rajat ovat mukaan lukien.
    expect(inTampereRegion(REGION_BOUNDS.minLatitude, REGION_BOUNDS.minLongitude)).toBe(true);
    expect(inTampereRegion(REGION_BOUNDS.maxLatitude, REGION_BOUNDS.maxLongitude)).toBe(true);
  });

  it('hylkää alueen ulkopuoliset pisteet', () => {
    expect(inTampereRegion(60.45, 22.27)).toBe(false); // Turku
    expect(inTampereRegion(61.71, 23.76)).toBe(false); // hieman pohjoiseen
    expect(inTampereRegion(61.4978, 24.01)).toBe(false); // hieman itään
  });

  it('hylkää puuttuvat tai kelvottomat koordinaatit', () => {
    expect(inTampereRegion(undefined, 23.76)).toBe(false);
    expect(inTampereRegion(61.498, null)).toBe(false);
    expect(inTampereRegion(Number.NaN, 23.76)).toBe(false);
    expect(inTampereRegion('61.498', '23.76')).toBe(false);
  });
});

describe('roadFromName', () => {
  it('poimii tienumeron Digitrafficin nimestä', () => {
    expect(roadFromName('vt12_Tre_Paasikiventie')).toBe('vt12');
    expect(roadFromName('kt65_Tre_Epilänharju')).toBe('kt65');
    expect(roadFromName('yt3495_Rautaharkko')).toBe('yt3495');
    expect(roadFromName('vt3_Pirkkala_Huovi LAM')).toBe('vt3');
  });

  it('palauttaa null, jos muoto ei vastaa odotusta (ei arvausta)', () => {
    expect(roadFromName('DSL6L')).toBeNull();
    expect(roadFromName('vt12Tre')).toBeNull(); // ei alaviivaa
    expect(roadFromName('')).toBeNull();
    expect(roadFromName(null)).toBeNull();
    expect(roadFromName(undefined)).toBeNull();
  });
});

describe('stationTitle', () => {
  it('suosii suomea ja karsii välilyönnit', () => {
    expect(
      stationTitle(
        { fi: '  Tie 12 Tampere Uittotunneli ', sv: 'Väg 12', en: 'Road 12' },
        'vt12_Tre_Paasikiventie',
      ),
    ).toBe('Tie 12 Tampere Uittotunneli');
  });

  it('putoaa ruotsiin ja englantiin, jos suomea ei ole', () => {
    expect(stationTitle({ sv: 'Väg 12', en: 'Road 12' }, 'x')).toBe('Väg 12');
    expect(stationTitle({ en: 'Road 12' }, 'x')).toBe('Road 12');
  });

  it('käyttää teknistä nimeä, jos käännöksiä ei ole', () => {
    expect(stationTitle(null, 'DSL6L')).toBe('DSL6L');
    expect(stationTitle({ fi: '   ' }, 'DSL6L')).toBe('DSL6L');
    expect(stationTitle(undefined, 'DSL6L')).toBe('DSL6L');
  });
});
