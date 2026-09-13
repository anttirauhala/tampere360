/**
 * ingest-events — Visit Tampere / Eventz -tapahtumakalenterin lähdeadapteri
 * (arkkitehtuuri §9). CC BY 4.0, päivittäin päivittyvä.
 *
 * Rajapinta: visittampere.fi/api/v1/event (REST/JSON).
 * Hakee meneillään olevat ja tulevat tapahtumat, tallentaa raakadatan
 * S3:een ja lähettää tapahtumat SQS-ingestion-jonoon.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createLogger } from '@tampere360/observability';
import { fetchWithRetry, sha256Hex, ulid } from '@tampere360/source-adapter-sdk';

const logger = createLogger({
  service: 'ingest-events',
  source: 'VISIT_TAMPERE',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

const API_URL = 'https://visittampere.fi/api/v1/event';

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
  const processed: string[] = [];
  for (const evt of events) {
    const sourceId = evt.id ? String(evt.id) : `event-${ulid()}`;

    // Suodata: vain meneillään olevat tai tulevat
    if (evt.startDate) {
      const start = new Date(evt.startDate);
      // 90 päivää menneitä sallitaan (jos alkaneet hiljattain)
      if (start < new Date(now.getTime() - 90 * 86400 * 1000)) continue;
    }

    const contentHash = sha256Hex(JSON.stringify(evt));
    const processingKey = `VISIT_TAMPERE:${sourceId}:${contentHash.slice(0, 16)}`;

    const batchId = ulid();
    const rawKey = `source=events/year=${
      new Date().getUTCFullYear()
    }/month=${
      String(new Date().getUTCMonth() + 1).padStart(2, '0')
    }/day=${
      String(new Date().getUTCDate()).padStart(2, '0')
    }/hour=${
      String(new Date().getUTCHours()).padStart(2, '0')
    }/${batchId}.json`;

    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucketName, Key: rawKey, Body: JSON.stringify(evt), ContentType: 'application/json',
      }));
    } catch (err) {
      logger.error('S3-virhe', { sourceId, error: String(err) });
      continue;
    }

    const sourceEvent = {
      parsedId: ulid(), batchId,
      source: 'VISIT_TAMPERE' as const,
      sourceId, revision: undefined,
      processingKey,
      raw: evt,
      extractedAt: new Date().toISOString(),
    };

    const ingestMessage = {
      schemaVersion: '1.0' as const,
      batch: {
        batchId, source: 'VISIT_TAMPERE' as const,
        fetchedAt: new Date().toISOString(),
        s3Key: rawKey, contentType: 'application/json',
        byteSize: Buffer.byteLength(JSON.stringify(evt), 'utf8'),
        contentHash,
        itemCount: 1,
      },
      events: [sourceEvent],
      correlationId: invocationId,
    };

    try {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(ingestMessage),
        MessageAttributes: {
          source: { DataType: 'String', StringValue: 'VISIT_TAMPERE' },
          correlationId: { DataType: 'String', StringValue: invocationId },
        },
      }));
    } catch (err) {
      logger.error('SQS-virhe', { sourceId, error: String(err) });
      continue;
    }

    processed.push(sourceId);
    logger.info('Tapahtuma käsitelty', { sourceId, name: evt.name ?? '' });
  }

  return { status: 'OK', itemsProcessed: processed.length };
}
