import { describe, expect, it } from 'vitest';

import {
  buildVehicleFeatureCollection,
  filterVehicleFeatures,
  isPlausibleCoordinate,
} from './geojson';
import type { SiriVehicle } from './types';

const NOW = Date.parse('2026-09-26T16:29:00.000Z');
const FETCHED_AT = '2026-09-26T16:29:00.000Z';
const GENERATED_AT = '2026-09-26T16:28:34.796Z';
const MAX_AGE_MS = 5 * 60_000;

function vehicle(overrides: Partial<SiriVehicle> = {}): SiriVehicle {
  return {
    vehicleId: '6990_350',
    line: '80',
    operatorRef: '6990',
    destination: 'Keskustori G',
    origin: 'Moisio',
    direction: 1,
    latitude: 61.5704918,
    longitude: 23.581377,
    bearing: 295,
    delaySeconds: 84,
    recordedAt: '2026-09-26T16:28:42.174Z',
    ...overrides,
  };
}

function tram(overrides: Partial<SiriVehicle> = {}): SiriVehicle {
  return vehicle({
    vehicleId: '56920_10',
    line: '1',
    operatorRef: '56920',
    destination: 'Hervantajärvi A',
    origin: 'Sorin aukio A',
    latitude: 61.4491876,
    longitude: 23.7833456,
    bearing: 152,
    delaySeconds: -60,
    ...overrides,
  });
}

const OPTIONS = {
  fetchedAt: FETCHED_AT,
  generatedAt: GENERATED_AT,
  now: NOW,
  maxAgeMs: MAX_AGE_MS,
};

describe('isPlausibleCoordinate', () => {
  it('hyväksyy Tampereen seudun koordinaatit', () => {
    expect(isPlausibleCoordinate(61.4978, 23.761)).toBe(true);
  });

  it('hylkää nollakoordinaatin ja muut epäuskottavat pisteet', () => {
    expect(isPlausibleCoordinate(0, 0)).toBe(false);
    expect(isPlausibleCoordinate(61.4978, 0)).toBe(false);
    expect(isPlausibleCoordinate(59.9, 23.761)).toBe(false);
    expect(isPlausibleCoordinate(Number.NaN, 23.761)).toBe(false);
  });
});

describe('buildVehicleFeatureCollection', () => {
  it('rakentaa FeatureCollectionin ja laskee määrät muodoittain', () => {
    const collection = buildVehicleFeatureCollection([vehicle(), tram()], OPTIONS);

    expect(collection.type).toBe('FeatureCollection');
    expect(collection.source).toBe('NYSSE_SIRI');
    expect(collection.generatedAt).toBe(GENERATED_AT);
    expect(collection.fetchedAt).toBe(FETCHED_AT);
    expect(collection.stale).toBe(false);
    expect(collection.counts).toEqual({ TRAM: 1, BUS: 1 });
    expect(collection.count).toBe(2);

    // Ratikka ensin (järjestys linjanumeron mukaan), koordinaatit [lon, lat].
    expect(collection.features[0]?.properties.mode).toBe('TRAM');
    expect(collection.features[0]?.geometry.coordinates).toEqual([23.7833456, 61.4491876]);
    expect(collection.features[1]?.properties).toEqual({
      vehicleId: '6990_350',
      line: '80',
      mode: 'BUS',
      destination: 'Keskustori G',
      origin: 'Moisio',
      direction: 1,
      bearing: 295,
      delaySeconds: 84,
      recordedAt: '2026-09-26T16:28:42.174Z',
    });
  });

  it('pudottaa epäuskottavan sijainnin (esim. 0,0)', () => {
    const collection = buildVehicleFeatureCollection(
      [vehicle({ latitude: 0, longitude: 0 }), tram()],
      OPTIONS,
    );
    expect(collection.features).toHaveLength(1);
    expect(collection.counts).toEqual({ TRAM: 1, BUS: 0 });
  });

  it('pudottaa liian vanhan havainnon ("haamu")', () => {
    const collection = buildVehicleFeatureCollection(
      [vehicle({ recordedAt: '2026-09-26T16:20:00.000Z' })],
      OPTIONS,
    );
    expect(collection.features).toEqual([]);
  });

  it('poistaa duplikaatit ajoneuvotunnisteittain — uusin havainto voittaa', () => {
    const collection = buildVehicleFeatureCollection(
      [
        vehicle({ recordedAt: '2026-09-26T16:28:00.000Z', latitude: 61.5 }),
        vehicle({ recordedAt: '2026-09-26T16:28:50.000Z', latitude: 61.6 }),
      ],
      OPTIONS,
    );
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.geometry.coordinates[1]).toBe(61.6);
  });
});

describe('filterVehicleFeatures', () => {
  const collection = buildVehicleFeatureCollection([vehicle(), tram()], OPTIONS);

  it('suodattaa ratikat', () => {
    const filtered = filterVehicleFeatures(collection, 'TRAM');
    expect(filtered.features.map((f) => f.properties.line)).toEqual(['1']);
    expect(filtered.count).toBe(1);
    // Määrät säilyvät ennallaan, jotta UI voi näyttää molempien määrät.
    expect(filtered.counts).toEqual({ TRAM: 1, BUS: 1 });
  });

  it('suodattaa bussit', () => {
    expect(filterVehicleFeatures(collection, 'BUS').features.map((f) => f.properties.line)).toEqual(
      ['80'],
    );
  });

  it('ilman muotoa palautetaan kaikki ajoneuvot', () => {
    const filtered = filterVehicleFeatures(collection, undefined);
    expect(filtered.features).toHaveLength(2);
    expect(filtered.count).toBe(2);
  });
});
