/**
 * Kelvollinen esimerkki-Tampere360Event testien ja kehityksen tueksi.
 */

import type { Tampere360Event } from './event';
import { SCHEMA_VERSION } from './event';

export function createSampleEvent(overrides: Partial<Tampere360Event> = {}): Tampere360Event {
  const base: Tampere360Event = {
    schemaVersion: SCHEMA_VERSION,
    id: '01J7Z8V2K4SAMPLEEVENT0001',
    canonicalKey: 'weather:fmi-cap:2.49.0.1.246.0.0.2026.example',
    processingKey: 'FMI_CAP:urn:oid:2.49.0.1.246.0.0.2026.example:a1b2c3d4e5f60718',
    source: {
      system: 'FMI_CAP',
      sourceId: 'urn:oid:2.49.0.1.246.0.0.2026.example',
      url: 'https://alerts.fmi.fi/cap/2026/09-06/08-46-15Z/example.xml',
      license: 'CC BY 4.0',
      fetchedAt: '2026-09-06T08:50:00.000Z',
    },
    type: 'WEATHER_WARNING',
    category: 'WEATHER',
    severity: 'MAJOR',
    status: 'ACTIVE',
    lifecycle: 'ACTIVE',
    title: {
      fi: 'Keltainen tuulivaroitus maa-alueille: Pirkanmaa',
    },
    description: {
      fi: 'Tuulivaroitus maa-alueille: voimakkaan lounaistuulen todennäköisyys on suuri.',
    },
    location: {
      municipality: 'Tampere',
      district: null,
      address: null,
      latitude: 61.4978,
      longitude: 23.761,
      geometry: null,
      areaCodes: ['TAMPERE', 'PIRKANMAA'],
      geohash: 'udc5j2',
    },
    validity: {
      startsAt: '2026-09-06T09:00:00.000Z',
      endsAt: '2026-09-06T18:00:00.000Z',
    },
    publishedAt: '2026-09-06T08:46:15.000Z',
    updatedAt: '2026-09-06T08:46:15.000Z',
    tags: ['tuuli', 'varoitus'],
    attribution: {
      name: 'Ilmatieteen laitos',
      url: 'https://www.ilmatieteenlaitos.fi/varoitukset',
      required: true,
    },
    contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };

  return { ...base, ...overrides };
}
