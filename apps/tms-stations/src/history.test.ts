import { describe, expect, it } from 'vitest';

import {
  compactDateToIso,
  numberCell,
  parseCsv,
  parseDailySeries,
  parseHourlySeries,
  parseSpeedByDirection,
  textCell,
} from './history';

/**
 * Testit käyttävät **aitoa CSV-muotoa**, joka on kopioitu Digitrafficin
 * historia-rajapinnasta 27.9.2026 (asema 438, vt12_Tre_Paasikiventie):
 * puolipiste-erotin, UTF-8 BOM ja tyhjät solut puuttuvina arvoina.
 */
const HOURLY_HEADER =
  'pistetunnus;sijainti;pvm;suunta;suuntaselite;kaista;jaottelu;ajoneuvoluokka;' +
  '00_01;01_02;02_03;03_04;04_05;05_06;06_07;07_08;08_09;09_10;10_11;11_12;' +
  '12_13;13_14;14_15;15_16;16_17;17_18;18_19;19_20;20_21;21_22;22_23;23_24;yhteensa';

const DAILY_HEADER =
  'pistetunnus;sijainti;pvm;suunta;suuntaselite;kaista;kaikki;kevyet;raskaat;' +
  '1_ha_pa;2_kaip;3_la;4_kapp;5_katp;6_hapk;7_haav;8_mp;9_hct';

const SPEED_HEADER =
  'pistetunnus;sijainti;vuosi;kuukausi;suunta;suuntaselite;nopeusrajoitus;' +
  'kaikki;kevyet;raskaat;keskinopeus_kaikki;keskinopeus_kevyet;keskinopeus_raskaat';

/** 24 tuntiarvoa: 100, 110, … */
function hourValues(first = 100, step = 10): string[] {
  return Array.from({ length: 24 }, (_, index) => String(first + index * step));
}

describe('parseCsv', () => {
  it('poistaa BOM-merkin ja pilkkoo puolipisteillä', () => {
    const { header, rows } = parseCsv(`\uFEFFa;b;c\n1;2;3\n4;5;6`);
    expect(header).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('ohittaa tyhjät rivit ja toistetun otsikkorivin', () => {
    const { rows } = parseCsv(`a;b\n1;2\n\npistetunnus;sijainti;x\n`);
    expect(rows).toEqual([['1', '2']]);
  });

  it('palauttaa tyhjän tuloksen, kun vastaus on vain otsikko', () => {
    const { header, rows } = parseCsv(HOURLY_HEADER);
    expect(header.length).toBe(33);
    expect(rows).toEqual([]);
  });

  it('kestää tyhjän ja puuttuvan syötteen', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] });
    expect(parseCsv(null)).toEqual({ header: [], rows: [] });
    expect(parseCsv(undefined)).toEqual({ header: [], rows: [] });
  });
});

describe('solujen jäsennys', () => {
  it('tyhjä solu on null, ei nolla', () => {
    expect(numberCell('')).toBeNull();
    expect(numberCell('   ')).toBeNull();
    expect(numberCell('0')).toBe(0);
    expect(numberCell('65.1')).toBe(65.1);
    expect(numberCell('65,1')).toBe(65.1);
    expect(numberCell('ei luku')).toBeNull();
    expect(numberCell(undefined)).toBeNull();
  });

  it('textCell normalisoi välilyönnit ja tyhjyyden', () => {
    expect(textCell('  Kaikki ')).toBe('Kaikki');
    expect(textCell('   ')).toBeNull();
    expect(textCell(undefined)).toBeNull();
  });

  it('compactDateToIso muuntaa lähdemuodon eikä arvaa kelvotonta', () => {
    expect(compactDateToIso('20260926')).toBe('2026-09-26');
    expect(compactDateToIso('2026-09-26')).toBeNull();
    expect(compactDateToIso('2026099')).toBeNull();
    expect(compactDateToIso(undefined)).toBeNull();
  });
});

describe('parseHourlySeries', () => {
  it('poimii kaikkien ajoneuvojen summarivin ja 24 tuntia', () => {
    const csv = [
      HOURLY_HEADER,
      `438;vt12_Tre_Paasikiventie;20260926;*;;*;Ajoneuvoluokka;HA - PA;${hourValues(700, 5).join(';')};38633`,
      `438;vt12_Tre_Paasikiventie;20260926;*;;*;Kaikki;kaikki;${hourValues().join(';')};39904`,
    ].join('\n');

    const { hours, total } = parseHourlySeries(csv);
    expect(hours).toHaveLength(24);
    expect(hours[0]).toEqual({ hour: 0, value: 100 });
    expect(hours[23]).toEqual({ hour: 23, value: 330 });
    expect(total).toBe(39904);
  });

  it('jättää puuttuvan tunnin arvoksi null (ei nollaa)', () => {
    const values = hourValues();
    values[3] = '';
    const csv = [
      HOURLY_HEADER,
      `438;vt12_Tre_Paasikiventie;20260926;*;;*;Kaikki;kaikki;${values.join(';')};39904`,
    ].join('\n');

    const { hours } = parseHourlySeries(csv);
    expect(hours[3]).toEqual({ hour: 3, value: null });
    expect(hours.every((point) => point.value === null || point.value > 0)).toBe(true);
  });

  it('palauttaa 24 tyhjää tuntia, kun dataa ei ole lainkaan', () => {
    const { hours, total } = parseHourlySeries(HOURLY_HEADER);
    expect(hours).toHaveLength(24);
    expect(hours.every((point) => point.value === null)).toBe(true);
    expect(total).toBeNull();
  });

  it('hyväksyy myös rivin, jossa luokka on `kaikki` ilman jaottelusaraketta', () => {
    const header = HOURLY_HEADER.replace('jaottelu;', '');
    const csv = [
      header,
      `438;vt12_Tre_Paasikiventie;20260926;*;;*;kaikki;${hourValues().join(';')};39904`,
    ].join('\n');

    const { hours } = parseHourlySeries(csv);
    expect(hours[0]?.value).toBe(100);
  });
});

describe('parseDailySeries', () => {
  it('palauttaa päivät aikajärjestyksessä ja suodattaa suunnat', () => {
    const csv = [
      DAILY_HEADER,
      '438;vt12_Tre_Paasikiventie;20260919;1;Lahti;*;19935;19796;139;19595;72;46;2;19;186;15;;',
      '438;vt12_Tre_Paasikiventie;20260913;*;;*;36768;36597;171;36224;66;68;9;28;347;26;;',
      '438;vt12_Tre_Paasikiventie;20260914;*;;*;48409;47728;681;47342;491;72;39;79;341;45;;',
    ].join('\n');

    const days = parseDailySeries(csv);
    expect(days.map((day) => day.date)).toEqual(['2026-09-13', '2026-09-14']);
    expect(days[0]).toEqual({
      date: '2026-09-13',
      total: 36768,
      light: 36597,
      heavy: 171,
    });
    expect(days[1]?.total).toBe(48409);
  });

  it('ohittaa rivit, joilta puuttuu kelvollinen päivä', () => {
    const csv = [DAILY_HEADER, '438;vt12_Tre_Paasikiventie;;*;;*;1;1;0'].join('\n');
    expect(parseDailySeries(csv)).toEqual([]);
  });
});

describe('parseSpeedByDirection', () => {
  it('poimii suunnan nimen, rajoituksen ja keskinopeudet', () => {
    const csv = [
      SPEED_HEADER,
      '438;vt12_Tre_Paasikiventie;2026;09;1;Lahti;70/70;25646;25292;354;65.1;65.2;61.0',
      '438;vt12_Tre_Paasikiventie;2026;09;2;Rauma;60/60;25133;24776;357;68.0;68.0;66.2',
    ].join('\n');

    const directions = parseSpeedByDirection(csv);
    expect(directions).toHaveLength(2);
    expect(directions[0]).toEqual({
      direction: '1',
      municipality: 'Lahti',
      speedLimit: '70/70',
      total: 25646,
      light: 25292,
      heavy: 354,
      avgSpeed: 65.1,
      avgSpeedLight: 65.2,
      avgSpeedHeavy: 61,
    });
    expect(directions[1]?.municipality).toBe('Rauma');
  });

  it('palauttaa tyhjän listan, kun dataa ei ole', () => {
    expect(parseSpeedByDirection(SPEED_HEADER)).toEqual([]);
  });
});
