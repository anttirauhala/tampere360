import { describe, expect, it } from 'vitest';

import type { StationMeta } from './metadata';
import { ageMinutes, buildStationsResponse, liveValues, toStationSnapshot } from './snapshot';
import type { DigitrafficSensorValue, DigitrafficStationData } from './types';

/** Anturiarvo, kuten Digitraffic sen palauttaa. */
function sensor(name: string, value: number, unit = 'km/h'): DigitrafficSensorValue {
  return { id: 1, stationId: 23438, name, value, unit };
}

/** Aito 23438-snapshot tiivistettynä (vain tarvittavat anturit). */
function stationData(overrides: Partial<DigitrafficStationData> = {}): DigitrafficStationData {
  return {
    id: 23438,
    tmsNumber: 438,
    dataUpdatedTime: '2026-09-27T15:01:57Z',
    sensorValues: [
      sensor('KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1', 67),
      sensor('KESKINOPEUS_5MIN_LIUKUVA_SUUNTA2', 71),
      sensor('OHITUKSET_5MIN_LIUKUVA_SUUNTA1', 1380, 'kpl/h'),
      sensor('OHITUKSET_5MIN_LIUKUVA_SUUNTA2', 1560, 'kpl/h'),
    ],
    ...overrides,
  };
}

const META: StationMeta = {
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
  direction1Municipality: 'Lahti',
  direction2Municipality: 'Rauma',
  freeFlowSpeed1: 55,
  freeFlowSpeed2: 55,
};

describe('liveValues', () => {
  it('poimii suuntien nopeudet ja liikennemäärät', () => {
    const values = liveValues(stationData());
    expect(values).toEqual({
      speed1: 67,
      speed2: 71,
      volume1: 1380,
      volume2: 1560,
      measuredAt: '2026-09-27T15:01:57Z',
    });
  });

  it('suosii liukuvaa 5 min arvoa kiinteän sijaan', () => {
    const values = liveValues(
      stationData({
        sensorValues: [
          sensor('KESKINOPEUS_5MIN_KIINTEA_SUUNTA1', 65),
          sensor('KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1', 67),
        ],
      }),
    );
    expect(values.speed1).toBe(67);
  });

  it('käyttää kiinteää arvoa, jos liukuvaa ei ole', () => {
    const values = liveValues(
      stationData({ sensorValues: [sensor('OHITUKSET_5MIN_KIINTEA_SUUNTA2', 900, 'kpl/h')] }),
    );
    expect(values.volume2).toBe(900);
    expect(values.speed2).toBeNull();
  });

  it('palauttaa nullit, kun dataa ei ole', () => {
    expect(liveValues(null)).toEqual({
      speed1: null,
      speed2: null,
      volume1: null,
      volume2: null,
      measuredAt: null,
    });
    expect(liveValues(undefined).measuredAt).toBeNull();
  });
});

describe('ageMinutes', () => {
  const nowMs = Date.parse('2026-09-27T15:06:57Z');

  it('laskee mittausten iän minuutteina', () => {
    expect(ageMinutes('2026-09-27T15:01:57Z', nowMs)).toBe(5);
  });

  it('ei palauta negatiivista ikää tulevaisuuden aikaleimalle', () => {
    expect(ageMinutes('2026-09-27T15:10:00Z', nowMs)).toBe(0);
  });

  it('palauttaa null, jos aikaleimaa ei ole tai se on kelvoton', () => {
    expect(ageMinutes(null, nowMs)).toBeNull();
    expect(ageMinutes('ei-aika', nowMs)).toBeNull();
  });
});

describe('toStationSnapshot', () => {
  it('laskee sujuvuuden molemmille suunnille', () => {
    const snapshot = toStationSnapshot(META, stationData(), Date.parse('2026-09-27T15:03:00Z'));
    expect(snapshot.title).toBe('Tie 12 Tampere Uittotunneli');
    expect(snapshot.road).toBe('vt12');
    expect(snapshot.directions[0]).toEqual({
      direction: 1,
      municipality: 'Lahti',
      freeFlowSpeed: 55,
      speed: 67,
      volume: 1380,
      speedRatio: 1.22,
      level: 'SUJUVAA',
    });
    expect(snapshot.directions[1]?.level).toBe('SUJUVAA');
    expect(snapshot.measuredAt).toBe('2026-09-27T15:01:57Z');
    expect(snapshot.ageMinutes).toBe(1);
  });

  it('merkitsee sujuvuuden tuntemattomaksi, jos mittauksia ei ole', () => {
    const snapshot = toStationSnapshot(META, null, Date.now());
    expect(snapshot.directions[0]?.level).toBe('TUNTEMATON');
    expect(snapshot.directions[0]?.speed).toBeNull();
    expect(snapshot.measuredAt).toBeNull();
    expect(snapshot.ageMinutes).toBeNull();
  });

  it('ei väitä ruuhkaa, kun liikennemäärä on hyvin pieni', () => {
    const snapshot = toStationSnapshot(
      META,
      stationData({
        sensorValues: [
          sensor('KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1', 12),
          sensor('OHITUKSET_5MIN_LIUKUVA_SUUNTA1', 6, 'kpl/h'),
        ],
      }),
      Date.now(),
    );
    expect(snapshot.directions[0]?.level).toBe('TUNTEMATON');
  });
});

describe('buildStationsResponse', () => {
  const second: StationMeta = {
    ...META,
    id: 23471,
    tmsNumber: 471,
    name: 'vt3_Tampere_Multisilta',
    title: 'Tie 3 Tampere Multisilta',
    road: 'vt3',
    direction1Municipality: 'Helsinki',
    direction2Municipality: 'Vaasa',
  };

  it('järjestää asemat otsikon mukaan ja laskee tunnusluvut', () => {
    const response = buildStationsResponse({
      metas: [second, META],
      liveById: new Map([
        [23438, stationData()],
        [
          23471,
          stationData({
            id: 23471,
            tmsNumber: 471,
            sensorValues: [
              sensor('KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1', 20),
              sensor('OHITUKSET_5MIN_LIUKUVA_SUUNTA1', 1200, 'kpl/h'),
            ],
          }),
        ],
      ]),
      generatedAt: '2026-09-27T15:01:57Z',
      fetchedAt: '2026-09-27T15:02:00Z',
      nowMs: Date.parse('2026-09-27T15:02:00Z'),
      stale: false,
    });

    expect(response.stations.map((station) => station.title)).toEqual([
      'Tie 12 Tampere Uittotunneli',
      'Tie 3 Tampere Multisilta',
    ]);
    expect(response.counts).toEqual({ stations: 2, congested: 1, unknown: 0 });
    expect(response.generatedAt).toBe('2026-09-27T15:01:57Z');
    expect(response.stale).toBe(false);
  });

  it('laskee sujuvuudeltaan tuntemattomat asemat erikseen', () => {
    const response = buildStationsResponse({
      metas: [META, second],
      liveById: new Map(),
      generatedAt: null,
      fetchedAt: '2026-09-27T15:02:00Z',
      nowMs: Date.now(),
      stale: true,
    });

    expect(response.counts).toEqual({ stations: 2, congested: 0, unknown: 2 });
    expect(response.generatedAt).toBeNull();
    expect(response.stale).toBe(true);
  });

  it('palauttaa tyhjän listan ilman asemia', () => {
    const response = buildStationsResponse({
      metas: [],
      liveById: new Map(),
      generatedAt: null,
      fetchedAt: '2026-09-27T15:02:00Z',
      nowMs: Date.now(),
      stale: false,
    });
    expect(response.stations).toEqual([]);
    expect(response.counts.stations).toBe(0);
  });
});
