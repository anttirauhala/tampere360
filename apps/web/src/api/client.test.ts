import { describe, expect, it } from 'vitest';

import { ApiError, apiErrorStatus } from './client';

describe('apiErrorStatus', () => {
  it('palauttaa tilakoodin ApiError-oliosta', () => {
    expect(apiErrorStatus(new ApiError(503, '/v1/stops/6154/departures'))).toBe(503);
  });

  it('kaivaa tilakoodin myös pelkästä virhetekstistä', () => {
    // Sama teksti syntyy edelleen, jos virheolio tulee toisesta
    // moduuli-instanssista (instanceof ei silloin täsmää).
    expect(apiErrorStatus(new Error('API-virhe 502 (/v1/stops/6154/departures)'))).toBe(502);
  });

  it('palauttaa null, jos virhe ei tullut API:sta', () => {
    expect(apiErrorStatus(new TypeError('fetch failed'))).toBeNull();
    expect(apiErrorStatus('ei virhe')).toBeNull();
    expect(apiErrorStatus(null)).toBeNull();
  });
});

describe('ApiError', () => {
  it('säilyttää tilakoodin ja polun sekä luettavan viestin', () => {
    const error = new ApiError(500, '/v1/stops/0015/departures');

    expect(error.status).toBe(500);
    expect(error.path).toBe('/v1/stops/0015/departures');
    expect(error.message).toBe('API-virhe 500 (/v1/stops/0015/departures)');
    expect(error.name).toBe('ApiError');
    expect(error).toBeInstanceOf(Error);
  });
});
