/**
 * weather — API-vastauksen tyypit (arkkitehtuuri §31).
 *
 * Sama muoto palvellaan frontendille `/v1/weather/current`-reitiltä.
 * **Perusperiaate (§20): puuttuva arvo on `null`, ei koskaan arvaus tai nolla.**
 */

/** Havaintoasema, jolta nykyinen sää luetaan. */
export interface WeatherStationRef {
  /** FMI:n asematunniste (fmisid). */
  fmisid: string;
  /** Aseman nimi sellaisena kuin lähde sen ilmoittaa. */
  name: string;
  latitude: number | null;
  longitude: number | null;
}

/** Yhden aseman nykyinen sää. */
export interface CurrentWeatherResponse {
  station: WeatherStationRef;
  /** Viimeisimmän havainnon aika (UTC ISO) tai null, jos lähde ei anna sitä. */
  observedAt: string | null;
  /** Ilman lämpötila °C. */
  temperatureC: number | null;
  /** Suhteellinen kosteus %. */
  humidityPct: number | null;
  /** Tuulen nopeus m/s. */
  windSpeedMs: number | null;
  /** Puuska m/s. */
  windGustMs: number | null;
  /** Tuulen suunta asteina (0 = pohjoinen). */
  windDirectionDeg: number | null;
  /** Ilmanpaine merenpinnan tasolle redusoituna hPa. */
  pressureHpa: number | null;
  /** Tunnin sademäärä mm. */
  precipitation1hMm: number | null;
  /** Pilvisyys oktina (0–8) — FMI:n `n_man`. */
  cloudCoverOktas: number | null;
  /** Milloin Tampere 247 haki tiedot (aina asetettu). */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui ja tarjolla on vanhempi arvo. */
  stale: boolean;
  /** Lähde ja lisenssi (attribuutio vaaditaan, CC BY 4.0). */
  source: {
    system: 'FMI_OBSERVATION';
    url: string;
    license: 'CC BY 4.0';
  };
}
