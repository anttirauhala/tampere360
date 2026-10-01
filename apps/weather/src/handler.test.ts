import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Handler-testit: moduulin vakiot ja välimuisti luetaan import-hetkellä, joten
 * jokainen testi lataa moduulin uudelleen (`vi.resetModules`) ympäristön
 * asettamisen jälkeen — muuten testit jakaisivat saman välimuistin.
 */
const SAMPLE_XML =
  '<wfs:FeatureCollection>' +
  '<wfs:member><omso:PointTimeSeriesObservation>' +
  '<om:observedProperty xlink:href="https://opendata.fmi.fi/meta?param=temperature"/>' +
  '<om:featureOfInterest><sam:SF_SpatialSamplingFeature>' +
  '<sam:sampledFeature><ompr:LocationCollection><wfs:member><ompr:Location>' +
  '<gml:identifier codeSpace="http://xml.fmi.fi/namespace/stationcode/fmisid">101118</gml:identifier>' +
  '<gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">Pirkkala Tampere-Pirkkala lentoasema</gml:name>' +
  '</ompr:Location></wfs:member></ompr:LocationCollection></sam:sampledFeature>' +
  '<sam:shape><gml:Point><gml:pos>61.41940 23.62256</gml:pos></gml:Point></sam:shape>' +
  '</sam:SF_SpatialSamplingFeature></om:featureOfInterest>' +
  '<om:result><wml2:MeasurementTimeseries><wml2:point><wml2:MeasurementTVP>' +
  '<wml2:time>2026-10-01T16:50:00Z</wml2:time><wml2:value>11.8</wml2:value>' +
  '</wml2:MeasurementTVP></wml2:point></wml2:MeasurementTimeseries></om:result>' +
  '</omso:PointTimeSeriesObservation></wfs:member>' +
  '</wfs:FeatureCollection>';

function setEnv(): void {
  process.env['ENVIRONMENT'] = 'test';
  process.env['WEATHER_FMISID'] = '101118';
  process.env['WEATHER_STATION_NAME'] = 'Tampere-Pirkkala lentoasema';
  process.env['WEATHER_CACHE_MS'] = '300000';
  process.env['WEATHER_STALE_MAX_MS'] = '1800000';
  process.env['WEATHER_UPSTREAM_TIMEOUT_MS'] = '6000';
  process.env['WEATHER_OBSERVATION_HOURS'] = '3';
}

async function loadHandler(): Promise<typeof import('./handler')> {
  vi.resetModules();
  setEnv();
  return import('./handler');
}

function request(path: string): APIGatewayProxyEventV2 {
  return { rawPath: path, queryStringParameters: {} } as unknown as APIGatewayProxyEventV2;
}

function bodyOf(result: { body?: string }): Record<string, unknown> {
  return JSON.parse(result.body ?? '{}') as Record<string, unknown>;
}

describe('weather handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('palauttaa 404 tuntemattomalle polulle', async () => {
    const { handler } = await loadHandler();
    const result = await handler(request('/v1/something-else'));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('palauttaa 200 ja jäsennetyt arvot onnistuneesta FMI-vastauksesta', async () => {
    const fetchMock = vi.fn(async () => new Response(SAMPLE_XML, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await loadHandler();
    const result = await handler(request('/v1/weather/current'));
    const body = bodyOf(result);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(body['temperatureC']).toBe(11.8);
    expect(body['observedAt']).toBe('2026-10-01T16:50:00Z');
    expect(body['station']).toMatchObject({
      fmisid: '101118',
      name: 'Pirkkala Tampere-Pirkkala lentoasema',
    });
    // Asematiedot luetaan syvältä SF_SpatialSamplingFeatureista (ks. parse.ts).
    expect((body['station'] as Record<string, unknown>)['latitude']).toBeCloseTo(61.4194, 4);
    expect((body['station'] as Record<string, unknown>)['longitude']).toBeCloseTo(23.62256, 4);
    expect(body['source']).toMatchObject({ system: 'FMI_OBSERVATION', license: 'CC BY 4.0' });
    // Puuttuvat arvot ovat null — ei koskaan nolla tai arvaus (§20).
    expect(body['windSpeedMs']).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('palauttaa 503, kun FMI-haku epäonnistuu eikä vanhaa arvoa ole', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('verkkovirhe');
      }),
    );

    const { handler } = await loadHandler();
    const result = await handler(request('/v1/weather/current'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('palauttaa 503, kun FMI vastaa ExceptionReportin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<ExceptionReport/>', { status: 200 })),
    );

    const { handler } = await loadHandler();
    const result = await handler(request('/v1/weather/current'));
    expect(result).toMatchObject({ statusCode: 503 });
  });
});
