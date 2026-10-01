/**
 * Näsijärven pintaveden lämpötila (`GET /v1/water/temperature`, §34).
 *
 * Data tulee **oman API:n kautta**, joka hakee sen SYKE:n
 * Hydrologiarajapinnasta (OData, CC BY 4.0) ja pitää upstream-kutsut kurissa
 * **5 minuutin välimuistilla** (ks. apps/water-temperature). Selain saa pienen
 * JSONin eikä ODataa.
 *
 * **Puuttuva arvo on `null`** — myös lämpötila ja havaintoaika (§20: ei
 * arvausta).
 */

import { apiGet } from './client';

export interface WaterStationRef {
  id: number;
  /** Paikan nimi, esim. `Näsijärvi, Kyrönlahti`. */
  name: string;
  lake: string;
  municipality: string;
  latitude: number | null;
  longitude: number | null;
}

export interface WaterTemperature {
  station: WaterStationRef;
  temperatureC: number | null;
  /** Havainnon aika lähteestä (ISO, tyypillisesti päivän alku) tai null. */
  measuredAt: string | null;
  fetchedAt: string;
  stale: boolean;
  source: { system: string; name: string; url: string; license: string };
}

/**
 * Pollausväli: havainto on päivittäinen ja Lambdan välimuisti 5 min, joten
 * tiuhempi pollaus ei toisi tuoreempaa tietoa mutta kertautuisi jokaisen avoimen
 * selaimen myötä. Taustavälilehti ei pollaa.
 */
export const WATER_TEMPERATURE_POLL_MS = 300_000;

export function fetchWaterTemperature(): Promise<WaterTemperature> {
  return apiGet<WaterTemperature>('/v1/water/temperature');
}
