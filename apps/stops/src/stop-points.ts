/**
 * Pysäkkirekisterin muunnokset API-vastauksiksi (arkkitehtuuri §28).
 *
 * Frontend renderöi pysäkit **yhdestä** GeoJSON-lähteestä (sama periaate kuin
 * ajoneuvoissa, §27), joten koordinaatit pyöristetään ja kentät karsitaan jo
 * täällä: 3 423 pysäkin vastaus on näin ~250 kt sijaan ~400 kt.
 */

import type { GtfsStop, Stop, StopFeature, StopFeatureCollection } from './types';

/**
 * Koordinaattien tarkkuus vastauksessa. Viisi desimaalia on noin metrin
 * tarkkuus — riittävästi pysäkin sijoittamiseen kartalle, mutta leikkaa
 * turhat merkit pois (GTFS antaa kahdeksan desimaalia).
 */
export const COORDINATE_DECIMALS = 5;

export function roundCoordinate(value: number, decimals: number = COORDINATE_DECIMALS): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export interface BuildStopCollectionOptions {
  /** Milloin aineisto haettiin tai luettiin (UTC-ISO). */
  fetchedAt: string;
  /** true = tarjolla on vanhempi pysäkkirekisteri upstream-virheen takia. */
  stale: boolean;
}

/** Rakentaa `GET /v1/stops` -vastauksen (järjestys tunnisteen mukaan). */
export function buildStopFeatureCollection(
  stops: GtfsStop[],
  options: BuildStopCollectionOptions,
): StopFeatureCollection {
  const features: StopFeature[] = [...stops]
    .sort((a, b) => a.id.localeCompare(b.id, 'fi', { numeric: true }))
    .map((stop) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [roundCoordinate(stop.longitude), roundCoordinate(stop.latitude)] as [
          number,
          number,
        ],
      },
      properties: { id: stop.id, name: stop.name },
    }));

  return {
    type: 'FeatureCollection',
    source: 'NYSSE_GTFS',
    fetchedAt: options.fetchedAt,
    stale: options.stale,
    count: features.length,
    features,
  };
}

/**
 * Etsii pysäkin rekisteristä tunnisteella.
 *
 * Palauttaa `null`, jos rekisteriä ei ole (esim. ei vielä muistissa) tai
 * tunnistetta ei löydy — kutsuja päättää, mitä se silloin näyttää.
 */
export function findStop(stops: GtfsStop[] | null | undefined, id: string): Stop | null {
  const stop = stops?.find((candidate) => candidate.id === id);
  if (!stop) return null;
  return { id: stop.id, name: stop.name, latitude: stop.latitude, longitude: stop.longitude };
}

/**
 * Pysäkki pelkän nimen perusteella (SIRI-vastauksen `StopVisitNote`).
 *
 * Käytetään varana, kun staattinen rekisteri ei ole muistissa: lähtöluettelo ja
 * pysäkin nimi saadaan tällöin SIRI-vastauksesta ilman 17 Mt:n GTFS-latausta.
 */
export function stopFromName(id: string, name: string | null): Stop | null {
  if (!name) return null;
  return { id, name, latitude: null, longitude: null };
}
