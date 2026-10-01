import { describe, expect, it } from 'vitest';

import type { DirectionSnapshot, StationSnapshot } from '../api/tms';
import {
  MISSING_VALUE,
  barHeights,
  dayLabel,
  describeDirection,
  flowLevelClass,
  flowLevelLabel,
  formatNumber,
  formatSpeed,
  formatSpeedRatio,
  formatVolume,
  hourLabel,
  isCongested,
  measuredAgeText,
  monthLabel,
  stationLocationText,
} from './tms';

/** Aito suunta (asema 23438, 27.9.2026): 67 km/h, vapaa 55 km/h, 1380 kpl/h. */
const direction: DirectionSnapshot = {
  direction: 1,
  municipality: 'Lahti',
  freeFlowSpeed: 55,
  speed: 67,
  volume: 1380,
  speedRatio: 1.22,
  level: 'SUJUVAA',
};

const station: StationSnapshot = {
  id: 23438,
  tmsNumber: 438,
  name: 'vt12_Tre_Paasikiventie',
  title: 'Tie 12 Tampere Uittotunneli',
  road: 'vt12',
  municipality: 'Tampere',
  province: 'Pirkanmaa',
  latitude: 61.508408,
  longitude: 23.697679,
  bearing: 100,
  directions: [direction, { ...direction, direction: 2, level: 'RUUHKAUTUNUT' }],
  measuredAt: '2026-09-27T15:01:57Z',
  ageMinutes: 1,
};

describe('sujuvuusluokan esitys', () => {
  it('kääntää luokat suomeksi', () => {
    expect(flowLevelLabel('SUJUVAA')).toBe('Sujuvaa');
    expect(flowLevelLabel('HIDASTUNUT')).toBe('Hidastunutta');
    expect(flowLevelLabel('RUUHKAUTUNUT')).toBe('Ruuhkautunut');
    expect(flowLevelLabel('TUNTEMATON')).toBe('Ei tietoa');
  });

  it('tuottaa CSS-luokan pienillä kirjaimilla', () => {
    expect(flowLevelClass('RUUHKAUTUNUT')).toBe('tms-level--ruuhkautunut');
    expect(flowLevelClass('TUNTEMATON')).toBe('tms-level--tuntematon');
  });

  it('kertoo ruuhkautuneen suunnan asemalta', () => {
    expect(isCongested(station)).toBe(true);
    expect(
      isCongested({ ...station, directions: [direction, { ...direction, direction: 2 }] }),
    ).toBe(false);
  });
});

describe('lukujen muotoilu', () => {
  /**
   * `Intl.NumberFormat('fi-FI')` käyttää sitovaa välilyöntiä tuhaterottimena.
   * Sen tarkka koodipiste vaihtelee ICU-versioiden välillä (U+00A0 / U+202F),
   * joten testi normalisoi sen tavalliseksi välilyönniksi.
   */
  const plain = (value: string) => value.replace(/[\u00a0\u202f\u2009]/g, ' ');

  it('käyttää suomalaista tuhaterotinta', () => {
    expect(plain(formatNumber(39904))).toBe('39 904');
    expect(formatNumber(0)).toBe('0');
  });

  it('näyttää puuttuvan tiedon viivana, ei nollana', () => {
    expect(formatNumber(null)).toBe(MISSING_VALUE);
    expect(formatNumber(undefined)).toBe(MISSING_VALUE);
    expect(formatNumber(Number.NaN)).toBe(MISSING_VALUE);
    expect(formatSpeed(null)).toBe(MISSING_VALUE);
    expect(formatVolume(null)).toBe(MISSING_VALUE);
    expect(formatSpeedRatio(null)).toBe(MISSING_VALUE);
  });

  it('muotoilee nopeuden ja liikennemäärän', () => {
    expect(formatSpeed(67)).toBe('67 km/h');
    expect(formatSpeed(65.1)).toBe('65,1 km/h');
    expect(plain(formatVolume(1380))).toBe('1 380 ajoneuvoa/h');
    expect(formatSpeedRatio(1.22)).toBe('122 % vapaasta nopeudesta');
  });
});

describe('suunnan kuvaus', () => {
  it('näyttää määränpääkunnan, jos se on tiedossa', () => {
    expect(describeDirection(direction)).toBe('Suunta 1 · Lahti');
  });

  it('näyttää pelkän suuntanumeron, jos kuntaa ei ole', () => {
    expect(describeDirection({ ...direction, municipality: null })).toBe('Suunta 1');
  });
});

describe('kuvaajien apurit', () => {
  it('skaalaa palkit suurimman arvon mukaan', () => {
    expect(barHeights([100, 50, 0])).toEqual([100, 50, 0]);
  });

  it('jättää nullin nollakorkeudeksi eikä keksi arvoa', () => {
    expect(barHeights([null, 200, null])).toEqual([0, 100, 0]);
  });

  it('antaa pienimmän näkyvän korkeuden nollasta poikkeavalle arvolle', () => {
    expect(barHeights([10000, 10])).toEqual([100, 2]);
  });

  it('palauttaa nollat, kun kaikki arvot puuttuvat', () => {
    expect(barHeights([null, null])).toEqual([0, 0]);
    expect(barHeights([])).toEqual([]);
  });

  it('muotoilee tuntivälin ja päivän', () => {
    expect(hourLabel(0)).toBe('00–01');
    expect(hourLabel(8)).toBe('08–09');
    expect(hourLabel(23)).toBe('23–00');
  });

  it('muotoilee päivän ja kuukauden lyhyesti', () => {
    expect(dayLabel('2026-09-13')).toBe('13.9.');
    expect(dayLabel('rikki')).toBe('rikki');
    expect(monthLabel('2026-09')).toBe('syyskuu 2026');
    expect(monthLabel('2026-01')).toBe('tammikuu 2026');
    expect(monthLabel('2026-99')).toBe('2026-99');
  });
});

describe('aseman ja mittauksen kuvaus', () => {
  it('yhdistää kunnan ja tienumeron', () => {
    expect(stationLocationText(station)).toBe('Tampere · tie 12');
  });

  it('näyttää viivan, jos kumpaakaan ei ole', () => {
    expect(stationLocationText({ ...station, municipality: null, road: null })).toBe(MISSING_VALUE);
  });

  it('kertoo mittauksen iän luettavasti', () => {
    expect(measuredAgeText(0)).toBe('mitattu hetki sitten');
    expect(measuredAgeText(3)).toBe('mitattu 3 min sitten');
    expect(measuredAgeText(80)).toBe('mitattu 1 h 20 min sitten');
    expect(measuredAgeText(120)).toBe('mitattu 2 h sitten');
    expect(measuredAgeText(null)).toBe('mittausaika ei tiedossa');
  });
});
