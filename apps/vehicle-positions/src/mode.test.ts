import { describe, expect, it } from 'vitest';

import { TRAM_LINES, TRAM_OPERATORS, deriveVehicleMode } from './mode';

/**
 * Ratikan tunnistus: operaattoritieto on ensisijainen, linjanumerot ovat
 * varasääntö. Nämä testit lukitsevat logiikan, jotta muoto ei vaihdu
 * vahingossa (kartalla ratikat ja bussit piirretään eri ikonein).
 */
describe('deriveVehicleMode', () => {
  it('tunnistaa ratikan operaattorista', () => {
    expect(deriveVehicleMode('56920', '1')).toBe('TRAM');
    expect(deriveVehicleMode('56920', '3')).toBe('TRAM');
  });

  it('tunnistaa bussin operaattorista', () => {
    expect(deriveVehicleMode('6990', '80')).toBe('BUS');
    expect(deriveVehicleMode('6921', '7')).toBe('BUS');
  });

  it('käyttää linjanumeroa varasääntönä, jos operaattori puuttuu', () => {
    for (const line of TRAM_LINES) {
      expect(deriveVehicleMode(null, line)).toBe('TRAM');
    }
    expect(deriveVehicleMode(null, '80')).toBe('BUS');
    expect(deriveVehicleMode(undefined, '80')).toBe('BUS');
    expect(deriveVehicleMode('  ', '3')).toBe('TRAM');
  });

  it('antaa operaattoritiedolle etusijan linjanumeroon nähden', () => {
    // Bussioperaattori ratikkalinjalla ei ole ratikka (ja päinvastoin).
    expect(deriveVehicleMode('6990', '1')).toBe('BUS');
    expect(deriveVehicleMode('56920', '99')).toBe('TRAM');
  });

  it('ratikkaoperaattorit on määritetty', () => {
    expect(TRAM_OPERATORS).toContain('56920');
  });
});
