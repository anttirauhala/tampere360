import { describe, expect, it } from 'vitest';

import { sourceStatus } from './event-status';

describe('sourceStatus', () => {
  it('FMI: peruutettu varoitus → CANCELLED', () => {
    expect(sourceStatus('FMI_CAP', { status: 'CANCELLED' })).toBe('CANCELLED');
    expect(sourceStatus('FMI_CAP', { status: 'cancelled' })).toBe('CANCELLED');
  });

  it('FMI: päättynyt varoitus → ENDED', () => {
    expect(sourceStatus('FMI_CAP', { status: 'ENDED' })).toBe('ENDED');
  });

  it('FMI: aktiivinen tai tuntematon tila → ACTIVE', () => {
    expect(sourceStatus('FMI_CAP', { status: 'ACTIVE' })).toBe('ACTIVE');
    expect(sourceStatus('FMI_CAP', { status: 'jotain muuta' })).toBe('ACTIVE');
    expect(sourceStatus('FMI_CAP', {})).toBe('ACTIVE');
    expect(sourceStatus('FMI_CAP', undefined)).toBe('ACTIVE');
  });

  it('muiden lähteiden status-kenttää ei tulkita elinkaareksi', () => {
    // Regressiosuoja: esim. tiejakson oma status ei saa merkitä tapahtumaa päättyneeksi.
    expect(sourceStatus('TAMPERE_TRAFFIC', { status: 'ENDED' })).toBe('ACTIVE');
    expect(sourceStatus('POLICE_RSS', { status: 'CANCELLED' })).toBe('ACTIVE');
    expect(sourceStatus('NYSSE_ALERTS', { status: 'ENDED' })).toBe('ACTIVE');
  });
});
