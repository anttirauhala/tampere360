import { describe, expect, it } from 'vitest';

import type { StopDeparture, StopFeature, StopFeatureCollection } from '../api/types';
import {
  NO_REALTIME_COVERAGE_TEXT,
  buildStopIndex,
  departureMinutes,
  departureTone,
  formatClockTime,
  formatDepartureIn,
  hasEstimates,
  stopDeparturesNotice,
  stopFromFeature,
} from './stops';

const FEATURE: StopFeature = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [23.76152, 61.49754] },
  properties: { id: '0015', name: 'Keskustori D' },
};

const COLLECTION: StopFeatureCollection = {
  type: 'FeatureCollection',
  source: 'NYSSE_GTFS',
  fetchedAt: '2026-09-27T10:00:00.000Z',
  stale: false,
  count: 1,
  features: [FEATURE],
};

function departure(overrides: Partial<StopDeparture> = {}): StopDeparture {
  return {
    routeShortName: '3',
    destination: 'Hervanta',
    scheduledTime: '2026-09-27T10:02:00.000Z',
    expectedTime: '2026-09-27T10:02:00.000Z',
    delaySeconds: 0,
    realtime: true,
    ...overrides,
  };
}

const NOW = Date.parse('2026-09-27T10:00:00.000Z');

describe('stopFromFeature', () => {
  it('muuntaa GeoJSON-koordinaatit [lon, lat] oikein päin', () => {
    expect(stopFromFeature(FEATURE)).toEqual({
      id: '0015',
      name: 'Keskustori D',
      latitude: 61.49754,
      longitude: 23.76152,
    });
  });
});

describe('buildStopIndex', () => {
  it('indeksoi pysäkit tunnisteen mukaan', () => {
    const index = buildStopIndex(COLLECTION);
    expect(index.get('0015')?.name).toBe('Keskustori D');
    expect(index.get('tuntematon')).toBeUndefined();
  });

  it('kestää puuttuvan aineiston (pysäkit eivät ole päällä)', () => {
    expect(buildStopIndex(null).size).toBe(0);
    expect(buildStopIndex(undefined).size).toBe(0);
  });
});

describe('departureMinutes ja formatDepartureIn', () => {
  it('näyttää minuutit reaaliaikaisesta vuorosta', () => {
    const next = departure({ expectedTime: '2026-09-27T10:02:00.000Z' });
    expect(departureMinutes(next, NOW)).toBe(2);
    expect(formatDepartureIn(next, NOW)).toBe('2 min');
  });

  it('näyttää "nyt", kun vuoro on lähtövalmis', () => {
    expect(formatDepartureIn(departure({ expectedTime: '2026-09-27T10:00:00.000Z' }), NOW)).toBe(
      'nyt',
    );
    expect(formatDepartureIn(departure({ expectedTime: '2026-09-27T09:59:30.000Z' }), NOW)).toBe(
      'nyt',
    );
  });

  it('merkitsee aikatauluarvion ≈-etuliitteellä', () => {
    const estimate = departure({
      realtime: false,
      expectedTime: null,
      scheduledTime: '2026-09-27T10:14:00.000Z',
    });
    expect(formatDepartureIn(estimate, NOW)).toBe('≈ 14 min');
    expect(
      formatDepartureIn(
        { ...estimate, realtime: false, scheduledTime: '2026-09-27T09:59:00.000Z' },
        NOW,
      ),
    ).toBe('≈ nyt');
  });

  it('käyttää aikataulua, jos ennustetta ei ole', () => {
    const scheduledOnly = departure({ expectedTime: null });
    expect(departureMinutes(scheduledOnly, NOW)).toBe(2);
  });

  it('näyttää "–", kun aikaa ei tiedetä (aikaleimoja ei arvata, §20)', () => {
    const unknown = departure({ expectedTime: null, scheduledTime: null });
    expect(departureMinutes(unknown, NOW)).toBeNull();
    expect(formatDepartureIn(unknown, NOW)).toBe('–');
    expect(departureTone(unknown, NOW)).toBe('now');
  });
});

describe('departureTone', () => {
  it('jakaa sävyn minuuttien mukaan (sama kynnys kuin teksti)', () => {
    expect(departureTone(departure({ expectedTime: '2026-09-27T10:00:00.000Z' }), NOW)).toBe('now');
    expect(departureTone(departure({ expectedTime: '2026-09-27T10:02:00.000Z' }), NOW)).toBe(
      'soon',
    );
    expect(departureTone(departure({ expectedTime: '2026-09-27T10:03:00.000Z' }), NOW)).toBe(
      'soon',
    );
    expect(departureTone(departure({ expectedTime: '2026-09-27T10:04:00.000Z' }), NOW)).toBe(
      'later',
    );
  });
});

describe('formatClockTime', () => {
  it('näyttää kellonajan Suomen ajassa riippumatta selaimen vyöhykkeestä', () => {
    // 09:34:20Z = 12.34.20 Suomen kesäajassa.
    expect(formatClockTime('2026-09-27T09:34:20.000Z')).toBe('12.34.20');
  });

  it('palauttaa tyhjän, jos aikaa ei ole', () => {
    expect(formatClockTime(null)).toBe('');
    expect(formatClockTime('ei-aika')).toBe('');
  });
});

describe('hasEstimates', () => {
  it('kertoo, onko listalla aikataulun mukaisia arvioita', () => {
    expect(hasEstimates([departure()])).toBe(false);
    expect(hasEstimates([departure(), departure({ realtime: false })])).toBe(true);
    expect(hasEstimates([])).toBe(false);
  });

  describe('stopDeparturesNotice', () => {
    it('näyttää 5xx-virheen rauhallisena huomautuksena ilman teknistä virhekoodia', () => {
      // Regressiosuoja: käyttäjä näki aiemmin tekstin "API-virhe 502
      // (/v1/stops/6154/departures)", kun Waltti vastasi 500:lla.
      for (const status of [500, 502, 503]) {
        const notice = stopDeparturesNotice(status);
        expect(notice.tone).toBe('error');
        expect(notice.text).toContain('Lähtötietoja ei juuri nyt saada tälle pysäkille');
        expect(notice.text).toContain('Yritämme uudelleen automaattisesti');
        expect(notice.text).not.toContain('API-virhe');
        expect(notice.text).not.toContain(String(status));
      }
    });

    it('kertoo tuntemattomasta pysäkistä selkeästi', () => {
      const notice = stopDeparturesNotice(404);
      expect(notice.tone).toBe('error');
      expect(notice.text).toBe('Tälle pysäkille ei löytynyt lähtötietoja.');
    });

    it('näyttää muun 4xx-virheen tilakoodin kanssa', () => {
      const notice = stopDeparturesNotice(400);
      expect(notice.tone).toBe('error');
      expect(notice.text).toContain('virhe 400');
    });

    it('kertoo verkkoyhteydestä, kun virhe ei tullut API:sta', () => {
      const notice = stopDeparturesNotice(null);
      expect(notice.tone).toBe('error');
      expect(notice.text).toContain('tarkista verkkoyhteytesi');
    });
  });

  describe('NO_REALTIME_COVERAGE_TEXT', () => {
    it('kertoo, ettei lähde tarjoa pysäkille lähtötietoja', () => {
      expect(NO_REALTIME_COVERAGE_TEXT).toContain('Waltti ei tarjoa tälle pysäkille');
    });
  });
});
