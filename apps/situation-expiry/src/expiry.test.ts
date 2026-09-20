import { describe, expect, it } from 'vitest';

import { type SituationRow, planExpirations } from './expiry';

const NOW = Date.parse('2026-09-20T17:00:00Z');

function row(overrides: Partial<SituationRow> = {}): SituationRow {
  return {
    situationId: 'sid-1',
    status: 'ACTIVE',
    canonicalKey: 'FMI_CAP:alert-1',
    endsAt: null,
    ...overrides,
  };
}

describe('planExpirations', () => {
  it('sulkee tilanteen, jonka endsAt on ohitettu (VALIDITY_ENDED)', () => {
    // Dev-tapaus 20.9.2026: varoitus päättyi 10:00, siivous ajettiin 17:00.
    const result = planExpirations([row({ endsAt: '2026-09-20T10:00:00.000Z' })], NOW);
    expect(result).toEqual([
      { situationId: 'sid-1', status: 'ENDED', reason: 'VALIDITY_ENDED' },
    ]);
  });

  it('ei sulje tilannetta, jonka endsAt on tulevaisuudessa', () => {
    expect(planExpirations([row({ endsAt: '2026-09-20T20:00:00.000Z' })], NOW)).toEqual([]);
  });

  it('ei sulje tilannetta ilman endsAt-aikaa (alkuaikaakaan ei arvata)', () => {
    expect(planExpirations([row({ endsAt: null })], NOW)).toEqual([]);
    expect(planExpirations([row({ endsAt: 'ei-aikaleima' })], NOW)).toEqual([]);
    expect(planExpirations([row({ endsAt: undefined })], NOW)).toEqual([]);
  });

  it('sulkee ACTIVE-sisaruksen, kun samalla canonicalKeyllä on CANCELLED-rivi', () => {
    const result = planExpirations(
      [
        row({ situationId: 'vanha', endsAt: '2026-09-21T10:00:00.000Z' }),
        row({ situationId: 'peruutus', status: 'CANCELLED', endsAt: null }),
      ],
      NOW,
    );
    expect(result).toEqual([
      { situationId: 'vanha', status: 'CANCELLED', reason: 'SOURCE_CANCELLED' },
    ]);
  });

  it('sulkee ACTIVE-sisaruksen myös ENDED-rivin perusteella', () => {
    const result = planExpirations(
      [row({ situationId: 'vanha' }), row({ situationId: 'loppu', status: 'ENDED' })],
      NOW,
    );
    expect(result).toEqual([{ situationId: 'vanha', status: 'ENDED', reason: 'SOURCE_ENDED' }]);
  });

  it('CANCELLED voittaa ENDEDin, jos molemmat ovat samalla avaimella', () => {
    const result = planExpirations(
      [
        row({ situationId: 'vanha' }),
        row({ situationId: 'loppu', status: 'ENDED' }),
        row({ situationId: 'peruutus', status: 'CANCELLED' }),
      ],
      NOW,
    );
    expect(result).toEqual([
      { situationId: 'vanha', status: 'CANCELLED', reason: 'SOURCE_CANCELLED' },
    ]);
  });

  it('ei kosketa terminaalitilaisiin riveihin eikä eri avaimen tilanteisiin', () => {
    const result = planExpirations(
      [
        row({ situationId: 'jo-loppunut', status: 'ENDED', endsAt: '2026-09-01T00:00:00.000Z' }),
        row({ situationId: 'eri', canonicalKey: 'FMI_CAP:alert-2', endsAt: '2026-09-20T20:00:00.000Z' }),
      ],
      NOW,
    );
    expect(result).toEqual([]);
  });

  it('siivous on idempotentti: jo suljettu rivi ei enää kelpaa kandidaatiksi', () => {
    const first = planExpirations([row({ endsAt: '2026-09-20T10:00:00.000Z' })], NOW);
    expect(first).toHaveLength(1);
    // Sama rivi on nyt ENDED (kuten UpdateCommand asettaisi) → ei uutta työtä.
    const afterUpdate = planExpirations(
      [row({ status: 'ENDED', endsAt: '2026-09-20T10:00:00.000Z' })],
      NOW,
    );
    expect(afterUpdate).toEqual([]);
  });

  it('tyhjä taulu ei tuota töitä', () => {
    expect(planExpirations([], NOW)).toEqual([]);
  });
});