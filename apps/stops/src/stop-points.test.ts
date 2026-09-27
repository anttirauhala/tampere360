import { describe, expect, it } from 'vitest';

import {
  COORDINATE_DECIMALS,
  buildStopFeatureCollection,
  findStop,
  roundCoordinate,
  stopFromName,
} from './stop-points';
import type { GtfsStop } from './types';

const STOPS: GtfsStop[] = [
  { id: '0504', name: 'Rautatieasema', latitude: 61.4980736, longitude: 23.773102 },
  { id: '0015', name: 'Keskustori D', latitude: 61.49753845, longitude: 23.76152239 },
];

describe('roundCoordinate', () => {
  it('pyöristää viiteen desimaaliin (~1 m)', () => {
    expect(COORDINATE_DECIMALS).toBe(5);
    expect(roundCoordinate(61.49753845)).toBe(61.49754);
    expect(roundCoordinate(23.76152239)).toBe(23.76152);
  });
});

describe('buildStopFeatureCollection', () => {
  const collection = buildStopFeatureCollection(STOPS, {
    fetchedAt: '2026-09-27T10:00:00.000Z',
    stale: false,
  });

  it('tuottaa GeoJSON-FeatureCollectionin, jossa koordinaatit ovat [lon, lat]', () => {
    expect(collection.type).toBe('FeatureCollection');
    expect(collection.source).toBe('NYSSE_GTFS');
    expect(collection.fetchedAt).toBe('2026-09-27T10:00:00.000Z');
    expect(collection.stale).toBe(false);
    expect(collection.count).toBe(2);
    expect(collection.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [23.76152, 61.49754] },
      properties: { id: '0015', name: 'Keskustori D' },
    });
  });

  it('järjestää pysäkit tunnisteen mukaan numerona', () => {
    const ids = buildStopFeatureCollection(
      [
        { id: '10', name: 'Kymmenen', latitude: 61.5, longitude: 23.7 },
        { id: '9', name: 'Yhdeksän', latitude: 61.5, longitude: 23.7 },
        { id: '0504', name: 'Rautatieasema', latitude: 61.5, longitude: 23.7 },
      ],
      { fetchedAt: '2026-09-27T10:00:00.000Z', stale: true },
    ).features.map((feature) => feature.properties.id);

    expect(ids).toEqual(['9', '10', '0504']);
  });

  it('merkitsee vanhan rekisterin stale:true', () => {
    const stale = buildStopFeatureCollection(STOPS, {
      fetchedAt: '2026-09-27T10:00:00.000Z',
      stale: true,
    });
    expect(stale.stale).toBe(true);
  });

  it('käsittelee tyhjän rekisterin', () => {
    const empty = buildStopFeatureCollection([], {
      fetchedAt: '2026-09-27T10:00:00.000Z',
      stale: false,
    });
    expect(empty.count).toBe(0);
    expect(empty.features).toEqual([]);
  });
});

describe('findStop', () => {
  it('palauttaa pysäkin koko tarkkuudella', () => {
    expect(findStop(STOPS, '0015')).toEqual({
      id: '0015',
      name: 'Keskustori D',
      latitude: 61.49753845,
      longitude: 23.76152239,
    });
  });

  it('palauttaa null tuntemattomalle tunnisteelle tai puuttuvalle rekisterille', () => {
    expect(findStop(STOPS, '9999')).toBeNull();
    expect(findStop(null, '0015')).toBeNull();
    expect(findStop(undefined, '0015')).toBeNull();
  });
});

describe('stopFromName', () => {
  it('rakentaa pysäkin pelkällä nimellä (SIRI:n StopVisitNote)', () => {
    expect(stopFromName('0015', 'Keskustori D')).toEqual({
      id: '0015',
      name: 'Keskustori D',
      latitude: null,
      longitude: null,
    });
  });

  it('palauttaa null ilman nimeä — tunniste yksin ei riitä näytettäväksi', () => {
    expect(stopFromName('0015', null)).toBeNull();
    expect(stopFromName('0015', '')).toBeNull();
  });
});
