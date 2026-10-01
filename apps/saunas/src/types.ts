/**
 * Tyypit: saunahaku.fi-rajapinnan raakamuoto ja oman API:n vastaus (§33).
 *
 * **Miksi oma Lambda eikä suora selainhaku:** sama rakenne kuin muilla
 * reittikohtaisilla Lambdoilla (§27–30). Selain hakee datan omasta API:sta
 * (`GET /v1/saunas`), ja Lambda pitää upstream-kutsut kurissa välimuistilla
 * (N selainta → 1 kutsu per TTL) sekä antaa yhden paikan virheenkäsittelylle.
 *
 * **Miksi dataa ei normalisoida tapahtumamalliksi:** saunat eivät ole
 * tilanteita eivätkä kuulu DynamoDB:hen — ne ovat staattinen hakemisto kuten
 * pysäkit ja kamerat. Siksi malli on kevyt läpivienti (id + näytettävät kentät).
 */

/** Hintaluokat, joita lähde käyttää. `CONSRIPT` on lähteen kirjoitusasu. */
export type SaunaPriceType =
  'ADULT' | 'CHILD' | 'STUDENT' | 'PENSIONER' | 'UNEMPLOYED' | 'CONSRIPT' | (string & {});

/** Viikonpäivä lähteen enumina (`MONDAY` … `SUNDAY`). */
export type SaunaWeekday =
  'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';

export interface SaunaPrice {
  priceType: string;
  price: number;
}

/** Yksi aukiolojakso: viikonpäivä, kellonajat ja jakson hinnat. */
export interface SaunaOpeningHours {
  weekday: string;
  /** Kellonaika muodossa `HH:MM:SS` (lähde). */
  openingTime: string;
  closingTime: string;
  prices: SaunaPrice[];
}

/** Yksi sauna sellaisena kuin oma API sen palauttaa. */
export interface Sauna {
  id: string;
  name: string;
  streetAddress: string;
  postalCode: string;
  city: string;
  openingHours: SaunaOpeningHours[];
  phone: string;
  webPage: string;
  info: string;
  kiosk: boolean;
  restaurant: boolean;
  isNew: boolean;
}

/** `GET /v1/saunas` -vastaus. */
export interface SaunaListResponse {
  saunas: Sauna[];
  count: number;
  /** Hakuhetki palvelimella (ISO 8601, UTC). */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui, tarjolla on vanhempi lista. */
  stale: boolean;
}
