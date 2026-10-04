/**
 * Lähdekohtaisen keräystilan (IngestionState-taulu) kirjoitus.
 *
 * Arkkitehtuuri §7: adapteri kirjoittaa jokaisen ajon jälkeen lähdekohtaisen
 * tekninen tilan: viimeisin onnistunut haku, etag, cursor, tila ja
 * vastaanotettujen tietueiden määrä. API:n /v1/health/sources lukee tätä.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { IngestionStatus, SourceCheckpoint } from '@tampere360/event-contracts';

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);

export interface SaveCheckpointInput {
  /** Taulun nimi (INGESTION_STATE_TABLE_NAME). */
  tableName: string;
  /** Lähde (SourceSystem-arvo). */
  source: string;
  /** Tila: OK | ERROR | STALE | DISABLED. */
  status: IngestionStatus;
  /** Onnistuneen haun aikaleima (ISO 8601), jos haettu. */
  lastSuccessfulFetch?: string;
  /** Kuinka monta tietuetta käsiteltiin. */
  itemsReceived?: number;
  /** Virheilmoitus, jos status = ERROR. */
  error?: string;
  etag?: string;
  lastModified?: string;
  cursor?: string | null;
  /**
   * sourceId → contentHash: adapterin muistilista lähetetyistä tietueista.
   * Mahdollistaa muuttumattomien tietueiden ohituksen (kustannusoptimointi
   * 4.10.2026, ks. incremental.ts).
   */
  sentItems?: Record<string, string>;
}

/**
 * Kirjoittaa lähdekohtaisen tilan (yksi rivi per lähde, PK = source).
 * Ei heitä virhettä — checkpointin kirjoitusvirhe ei saa kaataa adapteria.
 */
export async function saveIngestionCheckpoint(input: SaveCheckpointInput): Promise<void> {
  const item: Record<string, unknown> = {
    source: input.source,
    status: input.status,
    updatedAt: new Date().toISOString(),
  };
  if (input.lastSuccessfulFetch) item.lastSuccessfulFetch = input.lastSuccessfulFetch;
  if (typeof input.itemsReceived === 'number') item.itemsReceived = input.itemsReceived;
  if (input.error) item.error = input.error.slice(0, 1000);
  if (input.etag) item.etag = input.etag;
  if (input.lastModified) item.lastModified = input.lastModified;
  if (input.cursor) item.cursor = input.cursor;
  if (input.sentItems) item.sentItems = input.sentItems;

  try {
    await doc.send(new PutCommand({ TableName: input.tableName, Item: item }));
  } catch {
    // Checkpointin kirjoitus ei ole kriittinen polku.
  }
}

/**
 * Lukee lähdekohtaisen `sentItems`-kartan (sourceId → contentHash), jolla
 * adapteri tunnistaa jo lähettämänsä tietueet. Palauttaa tyhjän kartan, jos
 * riviä ei vielä ole (ensimmäinen ajo) tai luku epäonnistuu — tällöin ajo
 * lähettää kaikki tietueet, kuten ennen optimointia.
 */
export async function loadSentItems(tableName: string, source: string): Promise<Record<string, string>> {
  if (!tableName) return {};
  try {
    const result = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { source },
        ProjectionExpression: 'sentItems',
      }),
    );
    const raw = result.Item?.['sentItems'];
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Muodostaa SourceCheckpoint-rakenteen (esim. testaukseen). */
export function buildCheckpoint(input: SaveCheckpointInput): SourceCheckpoint {
  return {
    source: input.source as SourceCheckpoint['source'],
    lastSuccessfulFetch: input.lastSuccessfulFetch ?? new Date().toISOString(),
    etag: input.etag,
    lastModified: input.lastModified,
    cursor: input.cursor ?? null,
    status: input.status,
    itemsReceived: input.itemsReceived ?? 0,
    error: input.error,
  };
}