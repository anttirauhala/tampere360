/**
 * Nykyinen sää (§31).
 *
 * Data tulee **oman API:n kautta** (`/v1/weather/current`), ei suoraan FMI:ltä:
 * FMI:n WFS vastaa WaterML 2.0 -XML:ää (~28 kt / parametri), joten jäsennys ja
 * välimuisti kuuluvat palvelimelle (ks. apps/weather). Selain saa pienen JSONin.
 *
 * **Puuttuva arvo on `null`** — myös lämpötila ja havaintoaika. Käyttöliittymä
 * ei koskaan näytä nollaa tai arvausta puuttuvan tilalla (§20).
 */

import { apiGet } from './client';

/** Havaintoasema, jolta sää luetaan. */
export interface WeatherStationRef {
  /** FMI:n asematunniste (fmisid). */
  fmisid: string;
  /** Aseman nimi sellaisena kuin lähde sen ilmoittaa. */
  name: string;
  latitude: number | null;
  longitude: number | null;
}

/** Tampereen nykyinen sää. */
export interface CurrentWeather {
  station: WeatherStationRef;
  /** Viimeisimmän havainnon aika (UTC ISO) tai null. */
  observedAt: string | null;
  temperatureC: number | null;
  humidityPct: number | null;
  windSpeedMs: number | null;
  windGustMs: number | null;
  windDirectionDeg: number | null;
  pressureHpa: number | null;
  precipitation1hMm: number | null;
  /** Pilvisyys oktina (0–8). */
  cloudCoverOktas: number | null;
  /** Milloin Tampere 247 haki tiedot. */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui, arvo voi olla vanhentunut. */
  stale: boolean;
  source: { system: string; url: string; license: string };
}

/**
 * Pollausväli: FMI päivittää havainnot noin 10 minuutin välein (ja Lambdan
 * välimuisti on 5 min), joten tiuhempi pollaus ei toisi tuoreempaa tietoa.
 */
export const WEATHER_POLL_MS = 300_000;

export function fetchCurrentWeather(): Promise<CurrentWeather> {
  return apiGet<CurrentWeather>('/v1/weather/current');
}
