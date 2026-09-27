import { describe, expect, it } from 'vitest';

import { DEPARTURE_LIMIT, buildStopDepartures, departureTimeMs } from './departures';
import type { SiriStopVisit } from './types';

/** Nykyhetki kiinnitetty, jotta testit eivät riipu kellonajasta. */
const NOW = Date.parse('2026-09-27T10:00:00Z');

function visit(overrides: Partial<SiriStopVisit> = {}): SiriStopVisit {
  return {
    recordedAt: '2026-09-27T09:59:50.000Z',
    stopId: '0015',
    line: '3',
    destination: 'Hervanta',
    origin: 'Keskustori',
    stopName: 'Keskustori D',
    realtime: true,
    delaySeconds: 0,
    aimedArrivalTime: '2026-09-27T10:02:00.000Z',
    aimedDepartureTime: '2026-09-27T10:02:00.000Z',
    expectedArrivalTime: '2026-09-27T10:02:00.000Z',
    expectedDepartureTime: '2026-09-27T10:02:00.000Z',
    vehicleAtStop: false,
    ...overrides,
  };
}

describe('departureTimeMs', () => {
  it('suosii ennustetta, sitten aikataulua ja viimeisenä saapumisaikaa', () => {
    expect(departureTimeMs(visit())).toBe(Date.parse('2026-09-27T10:02:00Z'));
    expect(departureTimeMs(visit({ expectedDepartureTime: null }))).toBe(
      Date.parse('2026-09-27T10:02:00Z'),
    );
    expect(
      departureTimeMs(
        visit({ expectedDepartureTime: null, aimedDepartureTime: null, expectedArrivalTime: null }),
      ),
    ).toBe(Date.parse('2026-09-27T10:02:00Z'));
  });

  it('palauttaa null, jos mitään aikaa ei ole', () => {
    const visitWithoutTimes = visit({
      expectedDepartureTime: null,
      aimedDepartureTime: null,
      expectedArrivalTime: null,
      aimedArrivalTime: null,
    });
    expect(departureTimeMs(visitWithoutTimes)).toBeNull();
  });
});

describe('buildStopDepartures', () => {
  it('järjestää lähdöt lähtöajan mukaan', () => {
    const visits = [
      visit({ line: '8', expectedDepartureTime: '2026-09-27T10:07:00.000Z' }),
      visit({ line: '3', expectedDepartureTime: '2026-09-27T10:02:00.000Z' }),
      visit({ line: '5', expectedDepartureTime: '2026-09-27T10:14:00.000Z' }),
    ];
    expect(buildStopDepartures(visits, { now: NOW }).map((d) => d.routeShortName)).toEqual([
      '3',
      '8',
      '5',
    ]);
  });

  it('muotoilee rivin API-mallin mukaan', () => {
    const [departure] = buildStopDepartures([visit({ delaySeconds: 120 })], { now: NOW });
    expect(departure).toEqual({
      routeShortName: '3',
      destination: 'Hervanta',
      scheduledTime: '2026-09-27T10:02:00.000Z',
      expectedTime: '2026-09-27T10:02:00.000Z',
      delaySeconds: 120,
      realtime: true,
    });
  });

  it('pudottaa menneet lähdöt pois armovälin jälkeen', () => {
    const visits = [
      visit({ line: '1', expectedDepartureTime: '2026-09-27T09:50:00.000Z' }), // 10 min sitten
      visit({ line: '2', expectedDepartureTime: '2026-09-27T09:59:50.000Z' }), // juuri lähtenyt
      visit({ line: '3', expectedDepartureTime: '2026-09-27T10:05:00.000Z' }),
    ];
    expect(buildStopDepartures(visits, { now: NOW }).map((d) => d.routeShortName)).toEqual([
      '2',
      '3',
    ]);
  });

  it('pitää pysäkillä olevan vuoron listalla, vaikka aika olisi mennyt', () => {
    const visits = [
      visit({ line: '9', expectedDepartureTime: '2026-09-27T09:40:00.000Z', vehicleAtStop: true }),
    ];
    expect(buildStopDepartures(visits, { now: NOW })).toHaveLength(1);
  });

  it('näyttää poikkeaman vain reaaliaikaisesta vuorosta', () => {
    const visits = [
      visit({ line: '3', realtime: false, delaySeconds: 0 }),
      visit({ line: '4', realtime: true, delaySeconds: -60 }),
    ];
    const [scheduled, realtime] = buildStopDepartures(visits, { now: NOW });
    expect(scheduled.delaySeconds).toBeNull();
    expect(realtime.delaySeconds).toBe(-60);
  });

  it('ohittaa vuoron, jolta puuttuu kaikki ajat', () => {
    const visits = [
      visit({
        expectedDepartureTime: null,
        aimedDepartureTime: null,
        expectedArrivalTime: null,
        aimedArrivalTime: null,
      }),
    ];
    expect(buildStopDepartures(visits, { now: NOW })).toEqual([]);
  });

  it('katkaisee listan enimmäispituuteen ja tukee omaa rajaa', () => {
    const visits = Array.from({ length: 30 }, (_, index) =>
      visit({
        line: String(index + 1),
        expectedDepartureTime: new Date(NOW + (index + 1) * 60_000).toISOString(),
      }),
    );
    expect(buildStopDepartures(visits, { now: NOW })).toHaveLength(DEPARTURE_LIMIT);
    expect(buildStopDepartures(visits, { now: NOW, limit: 5 })).toHaveLength(5);
  });

  it('käyttää armovälinä annettua arvoa', () => {
    // Vuoro lähti 2 minuuttia sitten (09:58, nyt 10:00).
    const visits = [visit({ expectedDepartureTime: '2026-09-27T09:58:00.000Z' })];
    expect(buildStopDepartures(visits, { now: NOW, graceMs: 180_000 })).toHaveLength(1);
    expect(buildStopDepartures(visits, { now: NOW, graceMs: 60_000 })).toHaveLength(0);
  });
});
