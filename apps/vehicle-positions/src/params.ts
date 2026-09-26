/**
 * Kyselyparametrien käsittely (`GET /v1/vehicles?mode=TRAM|BUS`).
 */

import type { VehicleMode } from './types';

/** Sallitut `mode`-arvot. */
export const VEHICLE_MODES: VehicleMode[] = ['TRAM', 'BUS'];

/**
 * Parsii `mode`-parametrin.
 *
 * - `undefined` = parametria ei annettu → palautetaan kaikki ajoneuvot
 *   (kätevä esim. selaimella tarkistettaessa)
 * - `null` = parametri annettiin mutta arvo on virheellinen → kutsuja
 *   palauttaa HTTP 400, jotta kirjoitusvirhe ei näy hiljaisena tyhjänä karttana
 * - `TRAM` | `BUS` = suodatetaan tähän muotoon
 */
export function parseMode(raw: string | null | undefined): VehicleMode | undefined | null {
  const value = (raw ?? '').trim().toUpperCase();
  if (value === '') return undefined;
  return VEHICLE_MODES.includes(value as VehicleMode) ? (value as VehicleMode) : null;
}
