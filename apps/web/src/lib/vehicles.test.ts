import { describe, expect, it } from 'vitest';

import {
  MODE_LABELS,
  MODE_LABELS_PARTITIVE,
  MODE_LABELS_PLURAL,
  delayLabel,
  delayTone,
  formatVehicleAge,
  vehicleSummary,
  vehicleTitle,
} from './vehicles';

const NOW = Date.parse('2026-09-26T16:29:00.000Z');

describe('vehicleTitle', () => {
  it('näyttää muodon, linjan ja määränpään', () => {
    expect(vehicleTitle({ mode: 'TRAM', line: '1', destination: 'Hervantajärvi A' })).toBe(
      'Ratikka 1 → Hervantajärvi A',
    );
  });

  it('jättää nuolen pois, jos määränpäätä ei ole', () => {
    expect(vehicleTitle({ mode: 'BUS', line: '80', destination: null })).toBe('Bussi 80');
  });
});

describe('delayLabel', () => {
  it('kertoo myöhästymisen minuutteina', () => {
    expect(delayLabel(84)).toBe('1 min myöhässä');
    expect(delayLabel(600)).toBe('10 min myöhässä');
  });

  it('kertoo etuajassa kulkevan vuoron', () => {
    expect(delayLabel(-120)).toBe('2 min etuajassa');
  });

  it('näyttää alle minuutin heiton "ajassa"', () => {
    expect(delayLabel(0)).toBe('ajassa');
    expect(delayLabel(20)).toBe('ajassa');
  });

  it('kertoo avoimesti, jos viivettä ei ole tiedossa', () => {
    expect(delayLabel(null)).toBe('aikataulusta ei tietoa');
    expect(delayLabel(undefined)).toBe('aikataulusta ei tietoa');
    expect(delayLabel(Number.NaN)).toBe('aikataulusta ei tietoa');
  });
});

describe('delayTone', () => {
  it('antaa ajassa kulkevalle vihreän sävyn', () => {
    expect(delayTone(0)).toBe('ontime');
    expect(delayTone(20)).toBe('ontime');
    expect(delayTone(-29)).toBe('ontime');
  });

  it('erottaa myöhässä ja etuajassa kulkevat', () => {
    expect(delayTone(84)).toBe('late');
    expect(delayTone(-120)).toBe('early');
  });

  it('antaa saman tuloksen kuin delayLabel (kynnys ei voi eriytyä)', () => {
    for (const seconds of [0, 29, 30, 60, 90, 600, -60, -600]) {
      const label = delayLabel(seconds);
      const tone = delayTone(seconds);
      if (label === 'ajassa') expect(tone).toBe('ontime');
      else if (label === 'aikataulusta ei tietoa') expect(tone).toBe('unknown');
      else if (label.includes('myöhässä')) expect(tone).toBe('late');
      else expect(tone).toBe('early');
    }
  });

  it('merkitsee tuntemattoman viiveen omalla sävyllään', () => {
    expect(delayTone(null)).toBe('unknown');
    expect(delayTone(undefined)).toBe('unknown');
    expect(delayTone(Number.NaN)).toBe('unknown');
  });
});

describe('formatVehicleAge', () => {
  it('muotoilee tuoreet havainnot sekunteina', () => {
    expect(formatVehicleAge('2026-09-26T16:28:50.000Z', NOW)).toBe('10 s sitten');
    expect(formatVehicleAge('2026-09-26T16:28:40.000Z', NOW)).toBe('20 s sitten');
  });

  it('näyttää alle 10 sekunnin havainnon "juuri nyt"', () => {
    expect(formatVehicleAge('2026-09-26T16:28:57.000Z', NOW)).toBe('juuri nyt');
    expect(formatVehicleAge('2026-09-26T16:28:55.000Z', NOW)).toBe('juuri nyt');
  });

  it('muotoilee minuutit ja tunnit', () => {
    expect(formatVehicleAge('2026-09-26T16:27:00.000Z', NOW)).toBe('2 min sitten');
    expect(formatVehicleAge('2026-09-26T14:29:00.000Z', NOW)).toBe('2 h sitten');
  });

  it('palauttaa null, jos aikaa ei ole (UI ei näytä ikää)', () => {
    expect(formatVehicleAge(null, NOW)).toBeNull();
    expect(formatVehicleAge(undefined, NOW)).toBeNull();
    expect(formatVehicleAge('ei-aika', NOW)).toBeNull();
  });
});

describe('vehicleSummary', () => {
  it('kokoaa määrän ja päivitysajan', () => {
    expect(vehicleSummary('TRAM', 19, '2026-09-26T16:28:48.000Z', NOW)).toBe(
      '19 ratikkaa · päivitetty 12 s sitten',
    );
  });

  it('jättää iän pois, jos aikaleimaa ei ole', () => {
    expect(vehicleSummary('BUS', 158, null, NOW)).toBe('158 bussia');
  });
});

describe('muotojen nimet', () => {
  it('yksikkö, monikko ja määrämuoto ovat suomeksi', () => {
    expect(MODE_LABELS.TRAM).toBe('Ratikka');
    expect(MODE_LABELS.BUS).toBe('Bussi');
    expect(MODE_LABELS_PLURAL.TRAM).toBe('Ratikat');
    expect(MODE_LABELS_PLURAL.BUS).toBe('Bussit');
    expect(MODE_LABELS_PARTITIVE.TRAM).toBe('ratikkaa');
    expect(MODE_LABELS_PARTITIVE.BUS).toBe('bussia');
  });
});
