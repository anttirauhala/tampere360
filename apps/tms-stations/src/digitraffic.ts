/**
 * Digitraffic-yhteydet (TMS-rajapinnat, arkkitehtuuri §30).
 *
 * Kolme eri rajapintaa, joilla on hyvin erilainen päivitystahti:
 *
 *  1. **Asemaluettelo** (`/api/tms/v1/stations`, 518 asemaa) — metatietoa,
 *     joka muuttuu harvoin. Tästä suodatetaan Tampereen seudun asemat.
 *  2. **Aseman metatiedot** (`/api/tms/v1/stations/{id}`) — tarvitaan, koska
 *     vain tässä muodossa on `municipality`, `names.fi`, suuntien määränpäät ja
 *     **`freeFlowSpeed1/2`** (vapaan ajon nopeus). Ilman vapaan ajon nopeutta
 *     sujuvuutta ei voi laskea.
 *  3. **Mittaustiedot** (`/api/tms/v1/stations/data`) — kaikkien asemien
 *     reaaliaikaiset anturiarvot **yhdellä kutsulla**. Mitattu 27.9.2026:
 *     144 kt gzipattuna / 3,4 Mt purettuna, 0,25 s. Asemakohtainen kutsu olisi
 *     859 tavua mutta vaatisi 20 pyyntöä — yksi kutsu on yksinkertaisempi ja
 *     antaa samalla koko maan snapshotin (suodatus tehdään vasta tässä).
 *  4. **Historia** (`/api/tms/v1/history`) — sama rajapinta, jonka takana
 *     Digitrafficin oma tilastotyökalu (`tie.digitraffic.fi/ui/tms/history`) on.
 *     Palauttaa **CSV:tä** (puolipiste-erotin, BOM alussa), ei JSONia.
 *
 * **`piste`-parametri ei ole asematunnus:** historiassa piste on aseman
 * `tmsNumber` (esim. 438), kun taas TMS-rajapinnoissa käytetään `id`:tä
 * (esim. 23438). Kytkentä on virallinen kenttä, ei arvaus — testattu
 * 27.9.2026: 20/21 Tampereen seudun asemaa täsmäsi nimen perusteella.
 */

import type {
  DigitrafficStationData,
  DigitrafficStationDetail,
  DigitrafficStationsDataResponse,
  DigitrafficStationsResponse,
} from './types';

/**
 * Digitraffic edellyttää sovelluksen tunnistamista (`Digitraffic-User`).
 * Sama arvo kuin kelikameroissa (apps/web/src/api/cameras.ts).
 */
export const DIGITRAFFIC_USER = 'Tampere247';

export const STATIONS_URL = 'https://tie.digitraffic.fi/api/tms/v1/stations';
export const STATIONS_DATA_URL = 'https://tie.digitraffic.fi/api/tms/v1/stations/data';
export const HISTORY_URL = 'https://tie.digitraffic.fi/api/tms/v1/history';

/** Yksittäisen aseman metatiedot (detailed-muoto). */
export function stationDetailUrl(id: number): string {
  return `https://tie.digitraffic.fi/api/tms/v1/stations/${id}`;
}

/** Lähteetön HTTP-virhe tilakoodin kanssa (kutsuja voi päättää uusinnasta). */
export class DigitrafficError extends Error {
  readonly status: number;
  readonly resource: string;

  constructor(status: number, resource: string) {
    super(`Digitraffic vastasi ${status} (${resource})`);
    this.name = 'DigitrafficError';
    this.status = status;
    this.resource = resource;
  }
}

function headers(): Record<string, string> {
  return {
    accept: 'application/json',
    'Digitraffic-User': DIGITRAFFIC_USER,
  };
}

/** Hakee JSONin; heittää `DigitrafficError`in, jos vastaus ei ole 2xx. */
async function getJson<T>(url: string, resource: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new DigitrafficError(response.status, resource);
  return (await response.json()) as T;
}

/** Kaikkien asemien metatiedot (simplified-muoto). */
export function fetchStations(timeoutMs: number): Promise<DigitrafficStationsResponse> {
  return getJson<DigitrafficStationsResponse>(STATIONS_URL, 'stations', timeoutMs);
}

/** Yhden aseman metatiedot (detailed-muoto: kunnat, nimet, vapaa nopeus). */
export function fetchStationDetail(
  id: number,
  timeoutMs: number,
): Promise<DigitrafficStationDetail> {
  return getJson<DigitrafficStationDetail>(stationDetailUrl(id), `station/${id}`, timeoutMs);
}

/**
 * Kaikkien asemien reaaliaikaiset anturiarvot yhdellä kutsulla (144 kt gzip).
 * Palauttaa myös `Map`in `id` → aseman data, koska suodatus tehdään
 * asematunnisteiden perusteella.
 */
export async function fetchAllStationData(
  timeoutMs: number,
): Promise<{ dataUpdatedTime: string | null; byId: Map<number, DigitrafficStationData> }> {
  const response = await getJson<DigitrafficStationsDataResponse>(
    STATIONS_DATA_URL,
    'stations/data',
    timeoutMs,
  );
  const byId = new Map<number, DigitrafficStationData>();
  for (const station of response.stations ?? []) {
    byId.set(station.id, station);
  }
  return { dataUpdatedTime: response.dataUpdatedTime ?? null, byId };
}

/**
 * Historia-rajapinta palauttaa CSV:tä. Hyväksytään myös tyhjä vastaus
 * (tuntematon asema tai ajanjakso, jolta ei ole dataa) — se ei ole virhe vaan
 * tieto, joka näytetään käyttäjälle tyhjänä sarjana.
 */
export async function fetchHistoryCsv(
  query: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const url = new URL(HISTORY_URL);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: { accept: 'text/csv', 'Digitraffic-User': DIGITRAFFIC_USER },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new DigitrafficError(response.status, 'history');
  return response.text();
}
