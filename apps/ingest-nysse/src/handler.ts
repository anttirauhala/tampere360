/**
 * ingest-nysse - Nysse-hairiotiedotteet Waltti APIsta (Basic Auth)
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createLogger } from '@tampere360/observability';
import { saveIngestionCheckpoint, sha256Hex, ulid } from '@tampere360/source-adapter-sdk';
import { transit_realtime } from 'gtfs-realtime-bindings';

const logger = createLogger({ service: 'ingest-nysse', source: 'NYSSE_ALERTS', environment: process.env['ENVIRONMENT'] ?? 'dev' });
const s3 = new S3Client({}); const sqs = new SQSClient({}); const ssm = new SSMClient({});

// Tallennetaan SSM-parametriin joko base64-merkkijono tai raaka ClientID:Secret
// ja Lambda laskee Base64 tarvittaessa.

async function fetchWithAuth(url: string, authBase64: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${authBase64}`,
        Accept: 'application/x-protobuf,application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn('HTTP-status', { url, status: res.status });
      return null;
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  } catch (e) {
    logger.warn('Fetch-epaonnistui', { url, error: (e as Error).message.slice(0, 80) });
    return null;
  }
}

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const env = process.env['ENVIRONMENT'] || 'dev';
  const invocationId = ulid();

  // Hae Basic Auth -avain SSM:sta (/tampere360/{env}/sources/nysse/api-key)
  let apiKey = '';
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: `/tampere360/${env}/sources/nysse/api-key`, WithDecryption: true }));
    apiKey = r.Parameter?.Value ?? '';
  } catch {
    // SSM-haku epäonnistui — käsitellään alla puuttuvana avaimena.
  }

  if (!apiKey) {
    logger.warn('Nysse API-avain puuttuu SSM:sta');
    return { status: 'OK', itemsProcessed: 0 };
  }

  // Kokeile eri URL-paatteita ja endpointteja
  const baseUrls = [
    'https://data.waltti.fi/tampere/api/gtfsrealtime/v1.0/feed/servicealert',
    'https://data.waltti.fi/tampere/api/gtfsrealtime/v1.0/feed/servicealerts',
    'https://data.waltti.fi/tampere/api/gtfsrealtime/v2/alerts',
  ];

  let body: Buffer | null = null;
  for (const url of baseUrls) {
    body = await fetchWithAuth(url, apiKey);
    if (body) break;
  }

  if (!body) {
    // Kokeile viela format=json query-parametrilla
    for (const url of baseUrls) {
      body = await fetchWithAuth(url + '?format=json', apiKey);
      if (body) break;
    }
  }

  if (!body || body.length === 0) {
    logger.error('Kaikki URL-kokeilut epaonnistuivat');
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  // Jasenna protobuf
  const alerts: Record<string, string | undefined>[] = [];
  let feedTimestamp: string | undefined;
  try {
    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(body));
    // Syötteen tuotantoaika (header.timestamp): tämä on Walttin julkaisuaika,
    // EI häiriön alkuaika — alkuaika tulee alertin activePeriod-kentästä.
    feedTimestamp = feed.header?.timestamp
      ? new Date(Number(feed.header.timestamp) * 1000).toISOString()
      : undefined;
    if (feed.entity) {
      for (const e of feed.entity) {
        if (!e.alert) continue;
        const a = e.alert;
        alerts.push({
          // GTFS-RT entity.id on pysyvä tunniste → idempotenssi toimii
          entityId: e.id || undefined,
          header: t(a.headerText), description: t(a.descriptionText),
          start: a.activePeriod?.[0]?.start ? new Date(Number(a.activePeriod[0].start) * 1000).toISOString() : undefined,
          end: a.activePeriod?.[0]?.end ? new Date(Number(a.activePeriod[0].end) * 1000).toISOString() : undefined,
        });
      }
    }
  } catch {
    // Protobuf-jäsennys epäonnistui — käsitellään alla tyhjänä tuloksena.
  }

  if (alerts.length === 0) {
    logger.info('Ei hairioita tai protobuf-tyhja');
    return { status: 'OK', itemsProcessed: 0 };
  }

  const processed: string[] = [];
  for (const a of alerts) {
    // Sisältötarkiste lasketaan VAIN häiriön omista, vakioista kentistä:
    // feedTimestamp muuttuu jokaisella haulla eikä se saa muuttaa
    // processingKeyta (muuten sama häiriö lois uuden tilanteen joka minuutti).
    const core = {
      entityId: a.entityId, header: a.header, description: a.description,
      start: a.start, end: a.end,
    };
    const c = sha256Hex(JSON.stringify(core));
    const sourceId = a.entityId ?? `alert-${c.slice(0, 16)}`;
    const pk = `NYSSE_ALERTS:${sourceId}:${c.slice(0, 16)}`;
    const bid = ulid();
    const key = `source=nysse/year=${new Date().getUTCFullYear()}/${bid}.json`;
    const raw = { ...core, feedTimestamp };
    try { await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: JSON.stringify(raw), ContentType: 'application/json' })); } catch { continue; }
    const se = { parsedId: ulid(), batchId: bid, source: 'NYSSE_ALERTS', sourceId, processingKey: pk, raw, extractedAt: new Date().toISOString() };
    const msg = { schemaVersion: '1.0', batch: { batchId: bid, source: 'NYSSE_ALERTS', fetchedAt: new Date().toISOString(), s3Key: key, contentType: 'application/json', byteSize: Buffer.byteLength(JSON.stringify(raw), 'utf8'), contentHash: c, itemCount: 1 }, events: [se], correlationId: invocationId };
    try { await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(msg) })); } catch { continue; }
    processed.push(sourceId);
  }
  logger.info('Nysse valmis', { count: processed.length });
  await saveIngestionCheckpoint({
    tableName: process.env['INGESTION_STATE_TABLE_NAME'] ?? '',
    source: 'NYSSE_ALERTS',
    status: 'OK',
    lastSuccessfulFetch: new Date().toISOString(),
    itemsReceived: processed.length,
  });
  return { status: 'OK', itemsProcessed: processed.length };
}

function t(obj: unknown): string {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  const o = obj as Record<string, unknown>;
  if (o.translation) {
    const arr = Array.isArray(o.translation) ? o.translation : [o.translation];
    return String(arr.find((tx: Record<string, unknown>) => tx.language === 'fi')?.text ?? arr[0]?.text ?? '');
  }
  return '';
}
