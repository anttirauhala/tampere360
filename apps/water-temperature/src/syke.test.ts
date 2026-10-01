import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SykeError,
  buildLatestTemperatureUrl,
  fetchSurfaceWaterTemperature,
  parseDdmmss,
  parseLatestTemperature,
} from './syke';
import type { WaterStationRef } from './types';

const BASE = 'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata';

const FALLBACK: WaterStationRef = {
  id: 1694,
  name: 'Näsijärvi, Kyrönlahti',
  lake: 'Näsijärvi',
  municipality: 'Ylöjärvi',
  latitude: null,
  longitude: null,
};

/** Aidon vastauksen kaltainen OData-vastaus (1.10.2026). */
function odataResponse(value: unknown): unknown {
  return { 'odata.metadata': `${BASE}/$metadata#LampoPintavesi`, value };
}

const LATEST_ROW = {
  Paikka_Id: 1694,
  Aika: '2026-09-30T00:00:00',
  Arvo: '11.9',
  Paikka: {
    Paikka_Id: 1694,
    KuntaNimi: 'Ylöjärvi',
    Nimi: 'Näsijärvi, Kyrönlahti',
    JarviNimi: 'Näsijärvi (N60 95.40)x1',
    KoordLat: '614242',
    KoordLong: '233317',
  },
};

describe('buildLatestTemperatureUrl', () => {
  it('rakentaa OData-kyselyn: uusin ensin, yksi rivi, paikkatiedot mukaan', () => {
    const url = buildLatestTemperatureUrl(BASE, 1694);
    expect(url.startsWith(`${BASE}/LampoPintavesi?`)).toBe(true);
    expect(url).toContain('$filter=Paikka_Id%20eq%201694');
    expect(url).toContain('$orderby=Aika%20desc');
    expect(url).toContain('$top=1');
    expect(url).toContain('$expand=Paikka');
    // $format ei ole sallittu tässä rajapinnassa — muoto valitaan Accept-otsikolla.
    expect(url).not.toContain('$format');
  });
});

describe('parseDdmmss', () => {
  it('muuntaa DDMMSS-koordinaatin desimaaliasteiksi', () => {
    expect(parseDdmmss('614242')).toBeCloseTo(61.7117, 3);
    expect(parseDdmmss('233317')).toBeCloseTo(23.5547, 3);
  });

  it('palauttaa null, jos muoto ei täsmää', () => {
    expect(parseDdmmss('')).toBeNull();
    expect(parseDdmmss('abc')).toBeNull();
    expect(parseDdmmss(null)).toBeNull();
  });
});

describe('parseLatestTemperature', () => {
  it('poimii arvon, havaintoajan ja paikkatiedot', () => {
    const reading = parseLatestTemperature(odataResponse([LATEST_ROW]), FALLBACK);
    expect(reading.temperatureC).toBe(11.9);
    expect(reading.measuredAt).toBe('2026-09-30T00:00:00');
    expect(reading.station.name).toBe('Näsijärvi, Kyrönlahti');
    expect(reading.station.lake).toBe('Näsijärvi (N60 95.40)x1');
    expect(reading.station.municipality).toBe('Ylöjärvi');
    expect(reading.station.latitude).toBeCloseTo(61.7117, 3);
  });

  it('palauttaa null-arvon ja varapaikan, jos havaintoja ei ole', () => {
    const reading = parseLatestTemperature(odataResponse([]), FALLBACK);
    expect(reading.temperatureC).toBeNull();
    expect(reading.measuredAt).toBeNull();
    expect(reading.station).toEqual(FALLBACK);
  });

  it('kestää puuttuvan Paikan (varapaikka käyttöön)', () => {
    const reading = parseLatestTemperature(
      odataResponse([{ Paikka_Id: 1694, Aika: '2026-09-30T00:00:00', Arvo: '9.5' }]),
      FALLBACK,
    );
    expect(reading.temperatureC).toBe(9.5);
    expect(reading.station).toEqual(FALLBACK);
  });

  it('käsittelee kelvottoman vastauksen varapaikkana', () => {
    const reading = parseLatestTemperature(null, FALLBACK);
    expect(reading.temperatureC).toBeNull();
    expect(reading.station).toEqual(FALLBACK);
  });
});

describe('fetchSurfaceWaterTemperature', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hakee JSONin Accept-otsikolla ja jäsentää uusimman arvon', async () => {
    const fetchMock = vi.fn(async () => Response.json(odataResponse([LATEST_ROW])));
    vi.stubGlobal('fetch', fetchMock);

    const reading = await fetchSurfaceWaterTemperature(BASE, 1694, FALLBACK, 5000);

    expect(reading.temperatureC).toBe(11.9);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/LampoPintavesi?');
    expect((init.headers as Record<string, string>)['accept']).toBe('application/json');
  });

  it('heittää SykeErrorin tilakoodilla, kun vastaus ei ole 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );

    await expect(fetchSurfaceWaterTemperature(BASE, 1694, FALLBACK, 5000)).rejects.toMatchObject({
      name: 'SykeError',
      status: 500,
    });
    await expect(fetchSurfaceWaterTemperature(BASE, 1694, FALLBACK, 5000)).rejects.toBeInstanceOf(
      SykeError,
    );
  });
});
