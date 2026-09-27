/**
 * Pysäkit ja pysäkkimonitori (`GET /v1/stops`, `GET /v1/stops/{id}/departures`,
 * arkkitehtuuri §28).
 *
 * Selain ei hae pysäkkejä eikä lähtöjä suoraan Waltilta:
 *  - Waltti vaatii Basic-auth-avaimen, joka ei saa päätyä julkiseen frontendiin
 *  - GTFS-static-paketti on ~17 Mt, ja sen purku kuuluu palvelimelle
 *  - reaaliaikaiset lähdöt vaimennetaan Lambdan 15 sekunnin välimuistilla
 *
 * Pysäkkirekisteri haetaan **vasta kun käyttäjä valitsee "Näytä pysäkit"**
 * (`enabled`), ja lähdöt vain valitulle pysäkille.
 */

import { apiGet } from './client';
import type { StopDeparture, StopDeparturesResponse, StopFeatureCollection } from './types';

/**
 * Lähtöjen pollausväli. Waltti päivittää StopMonitoringin 30 sekunnin välein ja
 * Lambda pitää 15 sekunnin välimuistia, joten 15 s pitää listan tuoreena
 * aiheuttamatta turhia upstream-kutsuja.
 */
export const STOP_DEPARTURES_POLL_MS = 15_000;

/**
 * Pysäkkirekisterin vanhenemisaika selaimessa (24 h). Rekisteri muuttuu
 * käytännössä päivittäin, joten sitä ei haeta joka kerta kun kerros kytketään
 * päälle — Lambda päivittää oman kopionsa 6 tunnin välein.
 */
export const STOPS_STALE_TIME_MS = 24 * 3_600_000;

export async function fetchStops(): Promise<StopFeatureCollection> {
  const response = await apiGet<StopFeatureCollection>('/v1/stops');
  if (!Array.isArray(response.features)) {
    throw new Error('Pysäkkivastauksen muoto oli odottamaton');
  }
  return response;
}

export async function fetchStopDepartures(stopId: string): Promise<StopDeparturesResponse> {
  const response = await apiGet<StopDeparturesResponse>(
    `/v1/stops/${encodeURIComponent(stopId)}/departures`,
  );
  if (!Array.isArray(response.departures)) {
    throw new Error('Lähtövastauksen muoto oli odottamaton');
  }
  return response;
}

/** Lähtölistan riviavain React-listalle (sama linja voi esiintyä useasti). */
export function departureKey(departure: StopDeparture, index: number): string {
  return `${departure.routeShortName}-${departure.expectedTime ?? departure.scheduledTime ?? index}-${index}`;
}
