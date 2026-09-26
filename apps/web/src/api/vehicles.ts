/**
 * Ajoneuvosijainnit (`GET /v1/vehicles`, arkkitehtuuri §27).
 *
 * Selain ei kutsu Walttia suoraan, vaikka Waltti sallisi sen CORSilla: Waltti
 * vaatii Basic-auth-avaimen, joka ei saa päätyä julkiseen frontendiin. Siksi
 * kutsu menee oman API:n kautta (ks. `apps/vehicle-positions`), joka pitää
 * avaimen SSM:ssä ja vaimmentaa upstream-kutsut muistivälimuistilla.
 */

import { apiGet } from './client';
import type { VehicleFeatureCollection, VehicleMode } from './types';

/**
 * Pollausväli. Waltti päivittää sijainnit sekunnin välein, mutta 5 sekuntia on
 * kartalle riittävä ja pitää API-kuorman pienenä (Lambdan 5 sekunnin välimuisti
 * huolehtii siitä, ettei useampi selain lisää Waltti-kutsuja).
 */
export const VEHICLE_POLL_MS = 5_000;

const MODES: VehicleMode[] = ['TRAM', 'BUS'];

export function isVehicleMode(value: string): value is VehicleMode {
  return (MODES as string[]).includes(value);
}

export async function fetchVehicles(mode: VehicleMode): Promise<VehicleFeatureCollection> {
  const response = await apiGet<VehicleFeatureCollection>('/v1/vehicles', { mode });
  if (!Array.isArray(response.features)) {
    throw new Error('Ajoneuvovastauksen muoto oli odottamaton');
  }
  return response;
}
