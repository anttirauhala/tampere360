/**
 * Tyypit: SYKE Hydrologiarajapinnan (OData) raakamuoto ja oman API:n vastaus (§34).
 *
 * **Miksi oma Lambda eikä suora selainhaku:** sama rakenne kuin muilla
 * reittikohtaisilla Lambdoilla (§27–33). Yksi paikka hakea ja normalisoida data,
 * muistivälimuisti (5 min) ja oma varattu concurrency, joka erottaa reitin
 * query-Lambdan (5) sekä muiden reittien kustannuskatosta.
 *
 * Data ei tule DynamoDB:stä eikä kuluta lukukapasiteettia: pintaveden lämpötila
 * on yksittäinen mittausarvo, kuten sää (§32).
 */

/** Mittauspaikka (SYKE `Paikka`). */
export interface WaterStationRef {
  /** SYKE `Paikka_Id`. */
  id: number;
  /** Paikan nimi, esim. `Näsijärvi, Kyrönlahti`. */
  name: string;
  /** Järven nimi, esim. `Näsijärvi` (voi olla tyhjä). */
  lake: string;
  /** Kunta, esim. `Ylöjärvi`. */
  municipality: string;
  latitude: number | null;
  longitude: number | null;
}

/** Yksi pintaveden lämpötilahavainto (normalisoituna). */
export interface WaterTemperatureReading {
  temperatureC: number | null;
  /** Havainnon aika lähteestä (ISO-muotoinen, tyypillisesti päivän alku) tai null. */
  measuredAt: string | null;
  station: WaterStationRef;
}

/** `GET /v1/water/temperature` -vastaus. */
export interface WaterTemperatureResponse extends WaterTemperatureReading {
  /** Hakuhetki palvelimella (ISO 8601, UTC). */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui, arvo voi olla vanhentunut. */
  stale: boolean;
  source: { system: string; name: string; url: string; license: string };
}
