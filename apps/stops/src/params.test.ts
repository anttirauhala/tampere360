import { describe, expect, it } from 'vitest';

import { parseStopId } from './params';

/**
 * Tunniste tulee URL-polusta ja upotetaan SIRI-pyynnön XML:ään, joten
 * validoinnin on pakko hylätä kaikki muu kuin tunnistemainen merkkijono.
 */
describe('parseStopId', () => {
  it('hyväksyy GTFS-muotoiset tunnisteet', () => {
    expect(parseStopId('0015')).toBe('0015');
    expect(parseStopId('0504')).toBe('0504');
  });

  it('hyväksyy muut Waltti-tunnistemuodot', () => {
    expect(parseStopId('tampere:1234')).toBe('tampere:1234');
    expect(parseStopId('A-1_x')).toBe('A-1_x');
  });

  it('trimmaa välilyönnit ja purkaa prosenttikoodauksen', () => {
    expect(parseStopId(' 0015 ')).toBe('0015');
    expect(parseStopId('%30%30%31%35')).toBe('0015');
    expect(parseStopId('tampere%3A1234')).toBe('tampere:1234');
  });

  it('hylkää XML-rakenteen (pyyntöön upotettava arvo)', () => {
    expect(parseStopId('0015</MonitoringRef>')).toBeNull();
    expect(parseStopId('<script>')).toBeNull();
    expect(parseStopId('0015&x')).toBeNull();
  });

  it('hylkää tyhjän ja virheellisen syötteen', () => {
    expect(parseStopId('')).toBeNull();
    expect(parseStopId('   ')).toBeNull();
    expect(parseStopId(undefined)).toBeNull();
    expect(parseStopId(null)).toBeNull();
    expect(parseStopId('0015 0001')).toBeNull();
    expect(parseStopId('%zz')).toBeNull();
  });

  it('hylkää liian pitkän tunnisteen', () => {
    expect(parseStopId('1'.repeat(24))).toBe('1'.repeat(24));
    expect(parseStopId('1'.repeat(25))).toBeNull();
  });
});
