/**
 * Nysse-adapterin tarkistuspisteen (IngestionState) muodostus.
 *
 * **Miksi oma moduuli:** adapteri palasi aiemmin *ennen* tarkistuspisteen
 * kirjoitusta, kun Waltti-avain puuttui, häiriöitä ei ollut tai jäsennys
 * epäonnistui. Silloin lähteelle ei syntynyt riviä IngestionState-tauluun —
 * ja koska `/v1/health/sources` skannaa juuri sitä taulua, lähde ei näkynyt
 * valvonnassa lainkaan (näytti siltä, ettei lähdettä ole olemassa, vaikka
 * scheduleri pyöri minuutin välein). Tämä korjattiin 20.9.2026: **jokainen
 * ajopolku kirjoittaa tilan**, joten konfiguraatiovirhe (esim. puuttuva
 * API-avain) näkyy heti `Lähteiden tila` -näkymässä.
 */

import type { IngestionStatus } from '@tampere360/event-contracts';

/** Yhden ajokerran lopputulos. */
export type NysseOutcome =
  | 'SUCCESS'
  | 'NO_ALERTS'
  | 'API_KEY_MISSING'
  | 'FETCH_FAILED'
  | 'PARSE_FAILED';

export interface NysseCheckpoint {
  status: IngestionStatus;
  itemsReceived: number;
  /** Asetetaan vain onnistuneesta hausta — myös 0 häiriötä on onnistunut haku. */
  lastSuccessfulFetch?: string;
  /** Kuvaava virhekoodi; UI näyttää tämän Lähteiden tila -näkymässä. */
  error?: string;
}

/** Virhetilanteiden koodit. Koodi kertoo operaattorille syyn, ei pelkkää "ERROR". */
export const NYSSE_ERROR_CODES: Partial<Record<NysseOutcome, string>> = {
  API_KEY_MISSING:
    'API_KEY_MISSING: Waltti-avain puuttuu SSM:stä (/tampere360/<env>/sources/nysse/api-key)',
  FETCH_FAILED: 'FETCH_FAILED: kaikki Waltti-URL-kokeilut epäonnistuivat',
  PARSE_FAILED: 'PARSE_FAILED: GTFS-RT-protobufin jäsennys epäonnistui',
};

/**
 * Muodostaa tarkistuspisteen ajon lopputuloksesta.
 *
 * Huom: `STALE`-tilaa ei kirjoiteta koskaan — sen laskee API
 * `lastSuccessfulFetch`-aikaleimasta (yli 30 min vanha).
 */
export function buildNysseCheckpoint(
  outcome: NysseOutcome,
  itemsReceived: number,
  now: string = new Date().toISOString(),
): NysseCheckpoint {
  const error = NYSSE_ERROR_CODES[outcome];
  if (error) {
    return { status: 'ERROR', itemsReceived: 0, error };
  }
  // SUCCESS ja NO_ALERTS ovat molemmat onnistuneita hakuja: syöte vastasi.
  return { status: 'OK', itemsReceived, lastSuccessfulFetch: now };
}
