/**
 * Raakadatan arkistointi S3:een (arkkitehtuuri §7).
 *
 * Kustannusoptimointi 4.10.2026: aiemmin jokainen raakatietue kirjoitettiin
 * omana S3-objektinaan jokaisella ajokerralla → ~2 M PUT-pyyntöä kuukaudessa
 * pelkästään raakadataan (~10 $/kk). Nyt yhdestä ajokerrasta syntyy **yksi
 * objekti**, joka sisältää koko haetun tietuejoukon. Kirjoitus tehdään vain
 * silloin, kun vähintään yksi tietue muuttui (ks. incremental.ts).
 *
 * Objekti on JSON-kirjekuori, jotta kaikki lähteet tallennetaan samassa
 * muodossa ja jokaisen tietueen raw säilyy uudelleenkäsittelyä varten.
 */

export interface RawArchiveItem {
  /** Lähdejärjestelmän oma tunniste. */
  sourceId: string;
  /** Idempotenssiavain (sama kuin SQS-viestissä). */
  processingKey: string;
  /** Normalisoijalle välitetty raw sellaisenaan (sama kuin SQS-viestissä). */
  raw: unknown;
  /** Alkuperäinen lähdeteksti (esim. CAP-XML), jos sellainen on. */
  sourceText?: string;
}

export interface RawArchiveEnvelope {
  schemaVersion: '1.0';
  source: string;
  batchId: string;
  fetchedAt: string;
  itemCount: number;
  items: RawArchiveItem[];
}

/** Rakentaa yhden ajokerran raaka-arkiston (JSON-merkkijono). */
export function buildRawArchive(input: {
  source: string;
  batchId: string;
  fetchedAt: string;
  items: RawArchiveItem[];
}): string {
  const envelope: RawArchiveEnvelope = {
    schemaVersion: '1.0',
    source: input.source,
    batchId: input.batchId,
    fetchedAt: input.fetchedAt,
    itemCount: input.items.length,
    items: input.items,
  };
  return JSON.stringify(envelope);
}

/**
 * S3-avain: `source=<prefix>/year=/month=/day=/hour=/<batchId>.json`.
 * Sama hierarkia kuin aiemmin, jotta elinkaarisäännöt (Glacier/poisto)
 * osuvat edelleen.
 */
export function rawArchiveKey(
  sourcePrefix: string,
  batchId: string,
  at: Date = new Date(),
): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  const day = String(at.getUTCDate()).padStart(2, '0');
  const hour = String(at.getUTCHours()).padStart(2, '0');
  return `source=${sourcePrefix}/year=${year}/month=${month}/day=${day}/hour=${hour}/${batchId}.json`;
}
