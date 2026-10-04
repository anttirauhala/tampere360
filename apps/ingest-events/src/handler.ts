/**
 * ingest-events — Visit Tampere / Eventz -tapahtumakalenterin lähdeadapteri
 * (arkkitehtuuri §9). CC BY 4.0, päivittäin päivittyvä.
 *
 * Rajapinta: visittampere.fi/api/v1/event (REST/JSON).
 * Hakee meneillään olevat ja tulevat tapahtumat, tallentaa raakadatan
 * S3:een ja lähettää tapahtumat SQS-ingestion-jonoon.
 *
 * Kustannusoptimointi 4.10.2026: vain muuttuneet tietueet lähetetään ja
 * yhdestä ajokerrasta syntyy yksi S3-objekti (ks. source-adapter-sdk).
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createLogger } from '@tampere360/observability';
import {
  buildRawArchive,
  buildSentItems,
  dropSentItems,
  fetchWithRetry,
  loadSentItems,
  rawArchiveKey,
  saveIngestionCheckpoint,
  selectChangedItems,
  sha256Hex,
  ulid,
} from '@tampere360/source-adapter-sdk';

const logger = createLogger({
  service: 'ingest-events',
  source: 'VISIT_TAMPERE',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

const API_URL = 'https://visittampere.fi/api/v1/event';
const SOURCE = 'VISIT_TAMPERE' as const;
const ARCHIVE_PREFIX = 'events';

interface VisitTampereEvent {
  id?: number;
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  location?: { name?: string; coordinates?: { lat?: number; lon?: number } };
  category?: string[];
  image?: string;
  url?: string;
  [key: string]: unknown;
}

interface EventCandidate {
  sourceId: string;
  contentHash: string;
  processingKey: string;
  raw: unknown;
  name: string;
}

function extractEvents(body: unknown): VisitTampereEvent[] {
  if (Array.isArray(body)) return body as VisitTampereEvent[];
  const root = body as Record<string, unknown> | undefined;
  if (!root) return [];
  // Yritä yleisiä kenttänimiä
  return (root.events ?? root.data ?? root.results ?? root.items ?? []) as VisitTampereEvent[];
}

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const tableName = process.env['INGESTION_STATE_TABLE_NAME'] ?? '';
  const invocationId = ulid();

  logger.info('Haetaan Visit Tampere -tapahtumia', { url: API_URL });

  let responseBody: string;
  try {
    const res = await fetchWithRetry(API_URL, { timeoutMs: 15_000, maxAttempts: 3 });
    responseBody = res.body;
  } catch (err) {
    logger.error('API-haku epäonnistui', { error: String(err) });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  let data: unknown;
  try {
    data = JSON.parse(responseBody);
  } catch {
    logger.error('JSON-jäsennys epäonnistui', { preview: responseBody.slice(0, 500) });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  const events = extractEvents(data);
  if (events.length === 0) {
    logger.info('Ei tapahtumia', { url: API_URL });
    return { status: 'OK', itemsProcessed: 0 };
  }

  const now = new Date();
  const candidates: EventCandidate[] = [];
  for (const evt of events) {
    // Suodata: vain meneillään olevat tai tulevat (90 pv menneitä sallitaan).
    if (evt.startDate) {
      const start = new Date(evt.startDate);
      if (start < new Date(now.getTime() - 90 * 86400 * 1000)) continue;
    }
    const sourceId = evt.id ? String(evt.id) : `event-${ulid()}`;
    const contentHash = sha256Hex(JSON.stringify(evt));
    candidates.push({
      sourceId,
      contentHash,
      processingKey: `VISIT_TAMPERE:${sourceId}:${contentHash.slice(0, 16)}`,
      raw: evt,
      name: evt.name ?? '',
    });
  }

  // Muuttumattomat tietueet ohitetaan (kustannusoptimointi 4.10.2026).
  const previous = await loadSentItems(tableName, SOURCE);
  const changed = selectChangedItems(candidates, previous);
  logger.info('Muutokset', { candidates: candidates.length, changed: changed.length });

  const fetchedAt = new Date().toISOString();
  const batchId = ulid();
  const failed: string[] = [];
  let sent = 0;

  if (changed.length > 0) {
    const rawKey = rawArchiveKey(ARCHIVE_PREFIX, batchId);
    const archive = buildRawArchive({
      source: SOURCE,
      batchId,
      fetchedAt,
      items: candidates.map((c) => ({
        sourceId: c.sourceId,
        processingKey: c.processingKey,
        raw: c.raw,
      })),
    });
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: rawKey,
          Body: archive,
          ContentType: 'application/json',
        }),
      );
    } catch (err) {
      logger.error('S3-virhe', { error: String(err) });
      return { status: 'ERROR', itemsProcessed: 0 };
    }

    const batch = {
      batchId,
      source: SOURCE,
      fetchedAt,
      s3Key: rawKey,
      contentType: 'application/json',
      byteSize: Buffer.byteLength(archive, 'utf8'),
      contentHash: sha256Hex(archive),
      itemCount: candidates.length,
    };

    for (const c of changed) {
      const sourceEvent = {
        parsedId: ulid(),
        batchId,
        source: SOURCE,
        sourceId: c.sourceId,
        revision: undefined,
        processingKey: c.processingKey,
        raw: c.raw,
        extractedAt: new Date().toISOString(),
      };
      const ingestMessage = {
        schemaVersion: '1.0' as const,
        batch,
        events: [sourceEvent],
        correlationId: invocationId,
      };
      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(ingestMessage),
            MessageAttributes: {
              source: { DataType: 'String', StringValue: SOURCE },
              correlationId: { DataType: 'String', StringValue: invocationId },
            },
          }),
        );
        sent += 1;
        logger.info('Lähetetty', { sourceId: c.sourceId, name: c.name });
      } catch (err) {
        failed.push(c.sourceId);
        logger.error('SQS-virhe', { sourceId: c.sourceId, error: String(err) });
      }
    }
  }

  await saveIngestionCheckpoint({
    tableName,
    source: SOURCE,
    status: 'OK',
    lastSuccessfulFetch: fetchedAt,
    itemsReceived: candidates.length,
    sentItems: dropSentItems(buildSentItems(candidates), failed),
  });
  return { status: 'OK', itemsProcessed: sent };
}
