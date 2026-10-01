import { describe, expect, it } from 'vitest';

import {
  CONGESTION_HEAVY_MAX,
  CONGESTION_LIGHT_MAX,
  MIN_VOLUME_FOR_FLOW,
  flowLevel,
  roundRatio,
  speedRatio,
} from './flow';

/**
 * Sujuvuusarvion testit. Esimerkkiarvot ovat aitoja (27.9.2026):
 * asema 23438 `vt12_Tre_Paasikiventie`, vapaa nopeus 55 km/h, mitattu nopeus
 * 67/71 km/h ja liikennemäärä 1380/1560 kpl/h → sujuvaa.
 */
describe('speedRatio', () => {
  it('laskee suhteen nopeuden ja vapaan nopeuden välillä', () => {
    expect(speedRatio(55, 55)).toBe(1);
    expect(speedRatio(41.25, 55)).toBeCloseTo(0.75, 5);
    expect(speedRatio(27.5, 55)).toBeCloseTo(0.5, 5);
  });

  it('palauttaa null, jos jompikumpi puuttuu tai on kelvoton', () => {
    expect(speedRatio(null, 55)).toBeNull();
    expect(speedRatio(55, null)).toBeNull();
    expect(speedRatio(0, 0)).toBeNull();
    expect(speedRatio(Number.NaN, 55)).toBeNull();
  });
});

describe('flowLevel', () => {
  it('arvioi sujuvaksi, kun nopeus on lähellä vapaata nopeutta', () => {
    expect(flowLevel(67, 55, 1380)).toBe('SUJUVAA');
    expect(flowLevel(41.25, 55, 1000)).toBe('SUJUVAA');
  });

  it('arvioi hidastuneeksi välillä 50–75 % vapaasta nopeudesta', () => {
    expect(flowLevel(35, 55, 800)).toBe('HIDASTUNUT');
    expect(flowLevel(27.5, 55, 800)).toBe('HIDASTUNUT');
  });

  it('arvioi ruuhkautuneeksi alle 50 % vapaasta nopeudesta', () => {
    expect(flowLevel(20, 55, 900)).toBe('RUUHKAUTUNUT');
    expect(flowLevel(0, 55, 900)).toBe('RUUHKAUTUNUT');
  });

  it('ei arvioi sujuvuutta matalalla liikennemäärällä (yöllinen yksittäinen auto)', () => {
    expect(flowLevel(10, 55, 0)).toBe('TUNTEMATON');
    expect(flowLevel(10, 55, MIN_VOLUME_FOR_FLOW - 1)).toBe('TUNTEMATON');
    expect(flowLevel(10, 55, null)).toBe('TUNTEMATON');
  });

  it('arvioi heti, kun liikennemäärä ylittää kynnyksen', () => {
    expect(flowLevel(10, 55, MIN_VOLUME_FOR_FLOW)).toBe('RUUHKAUTUNUT');
  });

  it('palauttaa TUNTEMATON, jos nopeus tai vapaa nopeus puuttuu', () => {
    expect(flowLevel(null, 55, 1000)).toBe('TUNTEMATON');
    expect(flowLevel(50, null, 1000)).toBe('TUNTEMATON');
  });

  it('rajat ovat tarkat (>= 0,75 sujuvaa, >= 0,5 hidastunutta)', () => {
    const freeFlow = 100;
    expect(flowLevel(CONGESTION_LIGHT_MAX * freeFlow, freeFlow, 500)).toBe('SUJUVAA');
    expect(flowLevel(CONGESTION_HEAVY_MAX * freeFlow, freeFlow, 500)).toBe('HIDASTUNUT');
  });
});

describe('roundRatio', () => {
  it('pyöristää kahteen desimaaliin ja säilyttää nullin', () => {
    expect(roundRatio(0.8234567)).toBe(0.82);
    expect(roundRatio(1)).toBe(1);
    expect(roundRatio(null)).toBeNull();
  });
});
