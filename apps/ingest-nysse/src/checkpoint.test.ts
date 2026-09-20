import { describe, expect, it } from 'vitest';

import { NYSSE_ERROR_CODES, buildNysseCheckpoint } from './checkpoint';

const NOW = '2026-09-20T16:46:45.000Z';

describe('buildNysseCheckpoint', () => {
  it('onnistunut haku: OK + aikaleima', () => {
    const c = buildNysseCheckpoint('SUCCESS', 14, NOW);
    expect(c.status).toBe('OK');
    expect(c.itemsReceived).toBe(14);
    expect(c.lastSuccessfulFetch).toBe(NOW);
    expect(c.error).toBeUndefined();
  });

  it('ei häiriöitä: onnistunut haku (0 tietuetta), EI virhe', () => {
    const c = buildNysseCheckpoint('NO_ALERTS', 0, NOW);
    expect(c.status).toBe('OK');
    expect(c.itemsReceived).toBe(0);
    expect(c.lastSuccessfulFetch).toBe(NOW);
    expect(c.error).toBeUndefined();
  });

  it('puuttuva API-avain: ERROR + syy, ei aikaleimaa', () => {
    const c = buildNysseCheckpoint('API_KEY_MISSING', 0, NOW);
    expect(c.status).toBe('ERROR');
    expect(c.error).toContain('API_KEY_MISSING');
    // Regressiosuoja: virhe ei saa päivittää onnistuneen haun aikaleimaa.
    expect(c.lastSuccessfulFetch).toBeUndefined();
    expect(c.itemsReceived).toBe(0);
  });

  it('haku ja jäsennys epäonnistuivat: ERROR + syy', () => {
    expect(buildNysseCheckpoint('FETCH_FAILED', 0, NOW).error).toContain('FETCH_FAILED');
    expect(buildNysseCheckpoint('PARSE_FAILED', 0, NOW).error).toContain('PARSE_FAILED');
    expect(buildNysseCheckpoint('FETCH_FAILED', 0, NOW).status).toBe('ERROR');
  });

  it('jokaisella virhetilanteella on kuvaava koodi', () => {
    for (const outcome of ['API_KEY_MISSING', 'FETCH_FAILED', 'PARSE_FAILED'] as const) {
      expect(NYSSE_ERROR_CODES[outcome]).toBeTruthy();
    }
  });

  it('ei koskaan palauta STALE-tilaa (sen laskee API aikaleimasta)', () => {
    for (const outcome of ['SUCCESS', 'NO_ALERTS', 'API_KEY_MISSING', 'FETCH_FAILED', 'PARSE_FAILED'] as const) {
      expect(buildNysseCheckpoint(outcome, 0, NOW).status).not.toBe('STALE');
    }
  });
});
