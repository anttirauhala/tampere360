import { describe, expect, it } from 'vitest';

import { formatMeasurementDate, formatWaterTemperature } from './water';

describe('formatWaterTemperature', () => {
  it('näyttää lämpötilan suomalaisella pilkulla', () => {
    expect(formatWaterTemperature(11.9)).toBe('11,9 °C');
    expect(formatWaterTemperature(12)).toBe('12,0 °C');
    expect(formatWaterTemperature(-0.4)).toBe('-0,4 °C');
  });

  it('palauttaa tyhjän puuttuvalle arvolle (§20)', () => {
    expect(formatWaterTemperature(null)).toBe('');
    expect(formatWaterTemperature(undefined)).toBe('');
    expect(formatWaterTemperature(Number.NaN)).toBe('');
  });
});

describe('formatMeasurementDate', () => {
  it('muotoilee päivämäärän lukematta aikavyöhykettä', () => {
    expect(formatMeasurementDate('2026-09-30T00:00:00')).toBe('30.9.2026');
    expect(formatMeasurementDate('2026-01-05T00:00:00')).toBe('5.1.2026');
  });

  it('palauttaa tyhjän puuttuvalle tai kelvottomalle arvolle', () => {
    expect(formatMeasurementDate(null)).toBe('');
    expect(formatMeasurementDate('')).toBe('');
    expect(formatMeasurementDate('eilen')).toBe('');
  });
});
