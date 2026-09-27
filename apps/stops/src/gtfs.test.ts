import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { parseCsv, parseStopsCsv, readStopsFromZip } from './gtfs';

/** Ote oikeasta Nyssen GTFS-aineistosta (stops.txt). */
const STOPS_CSV = [
  'stop_id,stop_code,stop_name,stop_lat,stop_lon,zone_id,wheelchair_boarding,municipality_id',
  '0015,0015,Keskustori D,61.49753845,23.76152239,1,1,837',
  '0504,0504,Rautatieasema,61.49807360,23.77310200,1,1,837',
].join('\n');

describe('parseCsv', () => {
  it('jäsentää rivit ja sarakkeet', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('käsittelee lainatut kentät, myös pilkun sisällä', () => {
    expect(parseCsv('a,b\n"Keskustori, laituri D",2')).toEqual([
      ['a', 'b'],
      ['Keskustori, laituri D', '2'],
    ]);
  });

  it('purkaa lainausmerkin escapen ja CRLF-rivinvaihdot', () => {
    expect(parseCsv('a,b\r\n"12"" laiturit",2\r\n')).toEqual([
      ['a', 'b'],
      ['12" laiturit', '2'],
    ]);
  });

  it('poistaa UTF-8-BOM:in ensimmäisestä kentästä', () => {
    expect(parseCsv('\uFEFFstop_id,stop_name\n0015,Keskustori D')).toEqual([
      ['stop_id', 'stop_name'],
      ['0015', 'Keskustori D'],
    ]);
  });

  it('palauttaa tyhjän taulukon tyhjälle syötteelle', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('parseStopsCsv', () => {
  it('poimii tarvittavat kentät GTFS-otsikon mukaan', () => {
    const stops = parseStopsCsv(STOPS_CSV);
    expect(stops).toEqual([
      { id: '0015', name: 'Keskustori D', latitude: 61.49753845, longitude: 23.76152239 },
      { id: '0504', name: 'Rautatieasema', latitude: 61.4980736, longitude: 23.773102 },
    ]);
  });

  it('toimii vaikka sarakkeet olisivat eri järjestyksessä', () => {
    const csv = 'stop_name,stop_lon,stop_id,stop_lat\nKeskustori D,23.76,0015,61.49';
    expect(parseStopsCsv(csv)).toEqual([
      { id: '0015', name: 'Keskustori D', latitude: 61.49, longitude: 23.76 },
    ]);
  });

  it('pudottaa pois puutteelliset rivit', () => {
    const csv = [
      'stop_id,stop_name,stop_lat,stop_lon',
      ',Nimetön,61.5,23.7',
      '0002,,61.5,23.7',
      '0003,Kolmas,,23.7',
      '0004,Neljäs,61.5,',
      '0005,Viides,61.5,23.7',
    ].join('\n');
    expect(parseStopsCsv(csv).map((stop) => stop.id)).toEqual(['0005']);
  });

  it('pudottaa pois epäuskottavat koordinaatit (0,0 = aineistovirhe)', () => {
    const csv = [
      'stop_id,stop_name,stop_lat,stop_lon',
      '0001,Nollapiste,0,0',
      '0002,Atlantti,45.1,23.7',
      '0003,Ok,61.5,23.7',
    ].join('\n');
    expect(parseStopsCsv(csv).map((stop) => stop.id)).toEqual(['0003']);
  });

  it('poistaa duplikaatit tunnisteen mukaan (ensimmäinen voittaa)', () => {
    const csv = [
      'stop_id,stop_name,stop_lat,stop_lon',
      '0015,Keskustori D,61.4975,23.7615',
      '0015,Keskustori D (vanha),61.4975,23.7615',
    ].join('\n');
    expect(parseStopsCsv(csv)).toHaveLength(1);
    expect(parseStopsCsv(csv)[0].name).toBe('Keskustori D');
  });

  it('palauttaa tyhjän listan, jos tarvittavia sarakkeita ei ole', () => {
    expect(parseStopsCsv('stop_id,stop_name\n0015,Keskustori D')).toEqual([]);
    expect(parseStopsCsv('')).toEqual([]);
  });
});

describe('readStopsFromZip', () => {
  /** Paketti, jossa on myös suuri "stop_times.txt", jota ei pidä purkaa. */
  function buildZip(stops: string, extra = ''): Uint8Array {
    return zipSync({
      'stops.txt': strToU8(stops),
      'stop_times.txt': strToU8(extra.padEnd(2000, 'x')),
    });
  }

  it('purkaa stops.txt:n zip-paketista', () => {
    const zip = buildZip(STOPS_CSV);
    expect(readStopsFromZip(zip)).toBe(STOPS_CSV);
    expect(parseStopsCsv(readStopsFromZip(zip))).toHaveLength(2);
  });

  it('löytää tiedoston myös alikansiosta', () => {
    const zip = zipSync({ 'gtfs/stops.txt': strToU8(STOPS_CSV) });
    expect(parseStopsCsv(readStopsFromZip(zip))).toHaveLength(2);
  });

  it('heittää virheen, jos stops.txt puuttuu — hiljainen tyhjä lista olisi pahempi', () => {
    const zip = zipSync({ 'trips.txt': strToU8('route_id\n1') });
    expect(() => readStopsFromZip(zip)).toThrow(/stops\.txt/);
  });
});
