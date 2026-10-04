/**
 * Inkrementaalinen keräys — muuttumattomien tietueiden ohitus.
 *
 * Kustannusoptimointi 4.10.2026: adapterit lähettivät aiemmin **jokaisen**
 * raakatietueen S3:een ja SQS-jonoon jokaisella ajokerralla — myös kun tietue
 * ei ollut muuttunut. Nysse ja Tampere Traffic ajetaan minuutin välein, joten
 * sama muuttumaton tietue lähetettiin ~1 440 kertaa vuorokaudessa
 * (~34 000 viestiä/vrk/ympäristö). Dedup tapahtui vasta normalisoinnissa,
 * jolloin SQS-pyyntö, S3-PUT, KMS-kutsu ja Lambda-ajo oli jo maksettu.
 *
 * Näillä apureilla muuttumattomat tietueet ohitetaan jo adapterissa. Vertailu
 * tehdään sisältötarkisteesta (contentHash), joka tallennetaan lähdekohtaisesti
 * IngestionState-tauluun (attribuutti `sentItems`, ks. checkpoint.ts).
 */

export interface TrackableItem {
  /** Lähdejärjestelmän oma tunniste (esim. Digitraffic situationId). */
  sourceId: string;
  /** Sisältötarkiste (sha256Hex) — vertailun perusta. */
  contentHash: string;
}

/**
 * Palauttaa vain ne tietueet, joiden sisältö on muuttunut edelliseen ajoon
 * verrattuna. Puuttuva aiempi tarkiste (uusi tietue) lasketaan muuttuneeksi.
 */
export function selectChangedItems<T extends TrackableItem>(
  items: T[],
  previous: Record<string, string>,
): T[] {
  return items.filter((item) => previous[item.sourceId] !== item.contentHash);
}

/**
 * Muodostaa uuden tilakartan tämän ajokerran tietueista. Kartta rakennetaan
 * aina **koko** joukosta, joten syötteestä kadonneet tietueet poistuvat
 * (kartta ei kasva rajatta).
 */
export function buildSentItems(items: TrackableItem[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of items) map[item.sourceId] = item.contentHash;
  return map;
}

/**
 * Poistaa kartasta epäonnistuneet lähetykset, jotta ne yritetään uudelleen
 * seuraavalla ajokerralla (niitä ei merkitä lähetetyiksi).
 */
export function dropSentItems(
  map: Record<string, string>,
  failedSourceIds: Iterable<string>,
): Record<string, string> {
  const next = { ...map };
  for (const id of failedSourceIds) delete next[id];
  return next;
}
