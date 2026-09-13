/**
 * ingest-nysse — Nysse-häiriötiedotteet Waltti APIsta (arkkitehtuuri §9).
 *
 * Lataa GTFS-RT Service Alerts protobufista, jäsentää ja lähettää SQS:ään.
 * API-avain haetaan SSM-parametrista /tampere360/{env}/sources/nysse/api-key
 * rN aikana.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createLogger } from '@tampere360/observability';
import { fetchWithRetry, sha256Hex, ulid } from '@tampere360/source-adapter-sdk';
import { transit_realtime } from 'gtfs-realtime-bindings';

const logger = createLogger({ service: 'ingest-nysse', source: 'NYSSE_ALERTS', environment: process.env['ENVIRONMENT'] ?? 'dev' });
const s3 = new S3Client({}); const sqs = new SQSClient({}); const ssm = new SSMClient({});

const DEFAULT_URL = 'https://data.waltti.fi/tampere/api/gtfsrealtime/v1.0/feed/servicealerts';

interface AlertSummary {
  header?: string; description?: string; routeIds?: string[];
  effectiveStart?: string; effectiveEnd?: string;
}

function translateText(obj: unknown): string {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  const o = obj as Record<string, unknown>;
  if (o.translation) {
    const arr = Array.isArray(o.translation) ? o.translation : [o.translation];
    return String(arr.find((t: Record<string, unknown>) => t.language === 'fi')?.text ?? arr[0]?.text ?? '');
  }
  return '';
}

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const apiUrl = process.env['NYSSE_BASE_URL'] || DEFAULT_URL;
  const env = process.env['ENVIRONMENT'] || 'dev';
  const invocationId = ulid();

  // Hae API-avain SSM:stä (SecureString)
  let apiKey = '';
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: `/tampere360/${env}/sources/nysse/api-key`, WithDecryption: true }));
    apiKey = r.Parameter?.Value ?? '';
  } catch {
    logger.warn('API-avaimen haku SSM:stä epäonnistui', { param: `/tampere360/${env}/sources/nysse/api-key` });
  }

  if (!apiKey) {
    logger.warn('NYSSE_API_KEY ei asetettu SSM:ään', { url: apiUrl });
    return { status: 'OK', itemsProcessed: 0 };
  }

  let responseBody: Buffer;
  try {
    const res = await fetchWithRetry(apiUrl, { timeoutMs: 20_000, maxAttempts: 3, headers: { 'x-api-key': apiKey, Accept: 'application/x-protobuf' } });
    responseBody = Buffer.from(res.body, 'utf8');
  } catch (err) {
    logger.error('Haku epäonnistui', { error: String(err) });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  const alerts: AlertSummary[] = [];
  try {
    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(responseBody));
    if (feed.entity) {
      for (const e of feed.entity) {
        if (!e.alert) continue;
        const a = e.alert;
        alerts.push({
          header: translateText(a.headerText), description: translateText(a.descriptionText),
          routeIds: (a.informedEntity as Record<string, unknown>[] | undefined)?.map((ie) => String(ie.routeId ?? '')).filter(Boolean) ?? [],
          effectiveStart: a.activePeriod?.[0]?.start ? new Date(Number(a.activePeriod[0].start) * 1000).toISOString() : undefined,
          effectiveEnd: a.activePeriod?.[0]?.end ? new Date(Number(a.activePeriod[0].end) * 1000).toISOString() : undefined,
        });
      }
    }
  } catch {
    logger.error('Protobuf-jäsennys epäonnistui');
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  if (alerts.length === 0) {
    logger.info('Ei häiriöitä');
    return { status: 'OK', itemsProcessed: 0 };
  }

  const processed: string[] = [];
  for (const alert of alerts) {
    const sourceId = `alert-${ulid()}`;
    const contentHash = sha256Hex(JSON.stringify(alert));
    const processingKey = `NYSSE_ALERTS:${sourceId}:${contentHash.slice(0, 16)}`;
    const batchId = ulid();
    const rawKey = `source=nysse/year=${new Date().getUTCFullYear()}/${batchId}.json`;
    try { await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: rawKey, Body: JSON.stringify(alert), ContentType: 'application/json' })); } catch { continue; }
    const se: Parameters<typeof JSON.stringify>[0] = { parsedId: ulid(), batchId, source: 'NYSSE_ALERTS', sourceId, processingKey, raw: alert, extractedAt: new Date().toISOString() };
    const msg = { schemaVersion: '1.0', batch: { batchId, source: 'NYSSE_ALERTS', fetchedAt: new Date().toISOString(), s3Key: rawKey, contentType: 'application/json', byteSize: Buffer.byteLength(JSON.stringify(alert), 'utf8'), contentHash, itemCount: 1 }, events: [se], correlationId: invocationId };
    try { await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(msg), MessageAttributes: { source: { DataType: 'String', StringValue: 'NYSSE_ALERTS' }, correlationId: { DataType: 'String', StringValue: invocationId } } })); } catch { continue; }
    processed.push(sourceId);
  }
  logger.info('Nysse-häiriöt käsitelty', { count: processed.length });
  return { status: 'OK', itemsProcessed: processed.length };
}
