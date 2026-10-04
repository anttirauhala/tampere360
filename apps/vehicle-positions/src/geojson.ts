/**
 * SIRI-ajoneuvojen muunnos GeoJSON-FeatureCollectioniksi (arkkitehtuuri §27).
 *
 * Frontend renderöi ajoneuvot **yhdestä** GeoJSON-lähteestä, joten suodatus,
 * järjestys ja karsinta tehdään täällä — selain saa valmiin aineiston.
 */

import { deriveVehicleMode } from './mode';
import type { SiriVehicle, VehicleFeature, VehicleFeatureCollection, VehicleMode } from './types';

/**
 * Uskottavuusrajat (WGS84). Nysse liikennöi Tampereen, Nokian, Ylöjärven,
 * Kangasalan, Lempäälän, Pirkkalan, Vesilahden ja Oriveden alueella; rajat on
 * jätetty reilusti väljemmiksi. Rajojen ulkopuoliset pisteet ovat lähteen
 * virheitä (tyypillisesti 0,0) eikä niitä näytetä kartalla.
 */
export const PLAUSIBLE_BBOX = {
  minLat: 60.5,
  maxLat: 62.5,
  minLon: 22.5,
  maxLon: 25.5,
} as const;

export function isPlausibleCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= PLAUSIBLE_BBOX.minLat &&
    latitude <= PLAUSIBLE_BBOX.maxLat &&
    longitude >= PLAUSIBLE_BBOX.minLon &&
    longitude <= PLAUSIBLE_BBOX.maxLon
  );
}

export interface BuildOptions {
  /** Milloin tämä palvelu haki tiedot (UTC-ISO). */
  fetchedAt: string;
  /** Walttin tuotantoaika (UTC-ISO) tai null. */
  generatedAt: string | null;
  /** Nykyhetki millisekunteina (annetaan parametrina, jotta testi on deterministinen). */
  now: number;
  /** Havaintoaikaa vanhemmat ajoneuvot pudotetaan pois ("haamut"). */
  maxAgeMs: number;
}

/**
 * Rakentaa FeatureCollectionin SIRI-ajoneuvoista:
 *  1. pudottaa epäuskottavat koordinaatit ja liian vanhat havainnot
 *  2. poistaa duplikaatit ajoneuvotunnisteittain (uusin havainto voittaa)
 *  3. laskee määrät muodoittain (ennen `mode`-suodatusta) ja järjestää rivit
 */
export function buildVehicleFeatureCollection(
  vehicles: SiriVehicle[],
  options: BuildOptions,
): VehicleFeatureCollection {
  const newest = new Map<string, SiriVehicle>();

  for (const vehicle of vehicles) {
    if (!isPlausibleCoordinate(vehicle.latitude, vehicle.longitude)) continue;
    const age = options.now - Date.parse(vehicle.recordedAt);
    if (!Number.isFinite(age) || age > options.maxAgeMs) continue;

    const existing = newest.get(vehicle.vehicleId);
    if (!existing || existing.recordedAt < vehicle.recordedAt)
      newest.set(vehicle.vehicleId, vehicle);
  }

  const counts: Record<VehicleMode, number> = { TRAM: 0, BUS: 0 };
  const features: VehicleFeature[] = [...newest.values()]
    .sort(
      (a, b) =>
        a.line.localeCompare(b.line, 'fi', { numeric: true }) ||
        a.vehicleId.localeCompare(b.vehicleId),
    )
    .map((vehicle) => {
      const mode = deriveVehicleMode(vehicle.operatorRef, vehicle.line);
      counts[mode] += 1;
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [vehicle.longitude, vehicle.latitude] as [number, number],
        },
        properties: {
          vehicleId: vehicle.vehicleId,
          line: vehicle.line,
          mode,
          destination: vehicle.destination,
          origin: vehicle.origin,
          direction: vehicle.direction,
          bearing: vehicle.bearing,
          delaySeconds: vehicle.delaySeconds,
          recordedAt: vehicle.recordedAt,
        },
      };
    });

  return {
    type: 'FeatureCollection',
    source: 'NYSSE_SIRI',
    generatedAt: options.generatedAt,
    fetchedAt: options.fetchedAt,
    stale: false,
    counts,
    count: features.length,
    features,
  };
}

/**
 * Suodattaa kokoelman muodon mukaan. `mode` puuttuessa palautetaan kaikki
 * ajoneuvot, mutta `counts` säilyy ennallaan (UI voi näyttää molempien määrät).
 */
export function filterVehicleFeatures(
  collection: VehicleFeatureCollection,
  mode: VehicleMode | undefined,
): VehicleFeatureCollection {
  if (!mode) return { ...collection, count: collection.features.length };
  const features = collection.features.filter((feature) => feature.properties.mode === mode);
  return { ...collection, count: features.length, features };
}
