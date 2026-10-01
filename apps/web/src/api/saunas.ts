/**
 * Saunat (`GET /v1/saunas`, arkkitehtuuri §33).
 *
 * Data tulee **oman API:n kautta**, joka hakee sen saunahaku.fi-rajapinnasta ja
 * pitää upstream-kutsut kurissa välimuistilla (ks. apps/saunas). Selain saa
 * valmiiksi normalisoidun JSONin.
 *
 * **Hinnat ovat aukiolojakson sisällä:** jokainen `openingHours`-jakso kantaa
 * omat `prices`-merkintänsä, joten "hinnat tänään" luetaan päivän jaksosta
 * (`lib/saunas.ts`). Puuttuvaa tietoa ei arvata (§20).
 */

import { apiGet } from './client';

/** Yksi hintamerkintä (hinta ja sen luokka, esim. `ADULT`). */
export interface SaunaPrice {
  priceType: string;
  price: number;
}

/**
 * Yksi aukiolojakso. Viikonpäivä on lähteen enum (`MONDAY` … `SUNDAY`) ja
 * kellonajat muodossa `HH:MM:SS`; muotoilu tehdään `lib/saunas.ts`:ssä.
 */
export interface SaunaOpeningHours {
  weekday: string;
  openingTime: string;
  closingTime: string;
  prices: SaunaPrice[];
}

/** Yksi sauna. */
export interface Sauna {
  id: string;
  name: string;
  streetAddress: string;
  postalCode: string;
  city: string;
  openingHours: SaunaOpeningHours[];
  phone: string;
  webPage: string;
  /** Vapaa lisätietoteksti (voi mainita esim. poikkeusaukioloajat). */
  info: string;
  kiosk: boolean;
  restaurant: boolean;
  isNew: boolean;
}

/** `GET /v1/saunas` -vastaus. */
export interface SaunaListResponse {
  saunas: Sauna[];
  count: number;
  fetchedAt: string;
  /** true = upstream-haku epäonnistui, lista voi olla vanhentunut. */
  stale: boolean;
}

/**
 * Saunaluettelo ei ole reaaliaikaista: aukioloajat ja hinnat muuttuvat harvoin,
 * joten tieto haetaan kerran istunnossa ja päivitetään käyttäjän "Päivitä
 * tiedot" -painikkeella. Siksi pitkä `staleTime` eikä automaattipollausta.
 */
export const SAUNAS_STALE_TIME_MS = 30 * 60_000;

export async function fetchSaunas(): Promise<SaunaListResponse> {
  const response = await apiGet<SaunaListResponse>('/v1/saunas');
  if (!Array.isArray(response.saunas)) {
    throw new Error('Saunavastauksen muoto oli odottamaton');
  }
  return response;
}
