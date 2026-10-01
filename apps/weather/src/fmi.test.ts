import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildObservationUrl, FMI_WFS_URL, FmiError, fetchObservationXml } from './fmi';

describe('buildObservationUrl', () => {
  it('rakentaa WFS-pyynnön asemalle ja parametreille', () => {
    const url = new URL(
      buildObservationUrl({
        fmisid: '101118',
        parameters: ['temperature', 'windspeedms'],
        hours: 3,
        now: new Date('2026-10-01T16:00:00Z'),
      }),
    );

    expect(url.origin + url.pathname).toBe(FMI_WFS_URL);
    expect(url.searchParams.get('storedquery_id')).toBe(
      'fmi::observations::weather::timevaluepair',
    );
    expect(url.searchParams.get('fmisid')).toBe('101118');
    expect(url.searchParams.get('parameters')).toBe('temperature,windspeedms');
    // 3 h taaksepäin annetusta "nykyhetkestä".
    expect(url.searchParams.get('starttime')).toBe('2026-10-01T13:00:00.000Z');
  });
});

/** Vastaus, joka matkii sekä onnistunutta että virheellistä runkoa. */
function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml' } });
}

describe('fetchObservationXml', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('palauttaa rungon onnistuneesta vastauksesta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('<wfs:FeatureCollection/>')),
    );
    await expect(fetchObservationXml('https://example.com/wfs', 1000)).resolves.toContain(
      'FeatureCollection',
    );
  });

  it('nostaa FmiErrorin HTTP-virhekoodista', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('virhe', 500)),
    );
    await expect(fetchObservationXml('https://example.com/wfs', 1000)).rejects.toBeInstanceOf(
      FmiError,
    );
  });

  it('tulkitsee ExceptionReport-rungon virheeksi (esim. tuntematon parametri)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('<ExceptionReport><Exception/></ExceptionReport>')),
    );
    await expect(fetchObservationXml('https://example.com/wfs', 1000)).rejects.toThrow(
      'ExceptionReport',
    );
  });
});
