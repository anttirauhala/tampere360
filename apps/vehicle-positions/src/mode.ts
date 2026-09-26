/**
 * Ajoneuvon liikennöintimuodon päättely (ratikka vs. bussi).
 *
 * Tunnistus tehdään **operaattorista**, koska se ei riipu linjanumeroinnista:
 *
 *   56920 = Tampereen ratikka (verifioitu 26.9.2026 SIRI-syötteestä: 19
 *           ajoneuvoa, linjat 1 ja 3, päätepisteet Sorin aukio / Hervantajärvi /
 *           Kaupin kampus / Pyhällönpuisto)
 *   6990, 6921, 47374, 6852, 3012, 10299 = bussioperaattorit
 *
 * `TRAM_LINES` on varasääntö: jos lähde joskus jättää `OperatorRef`n pois,
 * ratikaksi tulkitaan ratikkalinjat 1 ja 3. Operaattoritieto on aina
 * ensisijainen — muuten bussioperaattorin ratikkalinjaa liikennöivä vuoro
 * näkyisi ratikkana.
 */

import type { VehicleMode } from './types';

/** Ratikkaa liikennöivät Waltti-operaattoritunnukset. */
export const TRAM_OPERATORS = ['56920'];

/** Ratikkalinjat (varasääntö operaattoritiedon puuttuessa). */
export const TRAM_LINES = ['1', '3'];

/** Palauttaa ajoneuvon muodon: TRAM tai BUS. */
export function deriveVehicleMode(
  operatorRef: string | null | undefined,
  line: string,
): VehicleMode {
  const operator = (operatorRef ?? '').trim();
  if (operator) return TRAM_OPERATORS.includes(operator) ? 'TRAM' : 'BUS';
  return TRAM_LINES.includes(line.trim()) ? 'TRAM' : 'BUS';
}
