/**
 * ingest-nysse — Nysse-joukkoliikenteen häiriötiedotteiden lähdeadapteri
 * (arkkitehtuuri §9). GTFS-RT Alerts -syöte (protobuf), hakuväli 1 min.
 *
 * Lataa GTFS-RT Alerts -syötteen, jäsentää protobufista FeedMessage->
 * FeedEntity->Alert-rakenteet, suodattaa olennaiset ja lähettää SQS:ään.
 *
 * URL konfiguroidaan Nysse-dokumentaation selvittyä (SSM / env).
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createLogger } from '@tampere360/observability';
import { fetchWithRetry, sha256Hex, ulid } from '@tampere360/source-adapter-sdk';
import { transit_realtime } from 'gtfs-realtime-bindings';

const logger = createLogger({
  service: 'ingest-nysse',
  source: 'NYSSE_ALERTS',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

// Oletus-URL (korvaa SSM:n base-urlilla kun tiedossa)
const DEFAULT_URL = 'https://data.waltti.fi/tampere/api/gtfsrealtime/v2/alerts';

interface AlertSummary {
  id?: string;
  header?: string;
  description?: string;
  routeIds?: string[];
  effectiveStart?: string;
  effectiveEnd?: string;
  cause?: number;
  effect?: number;
  url?: string;
}

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const invocationId = ulid();
  const apiUrl = process.env['NYSSE_BASE_URL'] || DEFAULT_URL;

  logger.info('Haetaan Nysse-häiriötiedotteita', { url: apiUrl });

  let responseBody: Buffer;
  try {
    const res = await fetchWithRetry(apiUrl, {
      timeoutMs: 20_000,
      maxAttempts: 3,
      headers: { 'Accept': 'application/x-protobuf, application/json, application/xml' },
    });
    responseBody = Buffer.from(res.body, 'utf8');
    // Jos palvelin palauttaa protobufin, aseta 'Accept' oikein
  } catch (err) {
    logger.error('Nysse-haku epäonnistui', { url: apiUrl, error: String(err) });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  // Yritä jäsentää alertit — kokeile protobuf + JSON + XML
  let alerts: AlertSummary[] = [];

  // 1) Yritä GTFS-RT protobuf
  try {
    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(responseBody));
    if (feed.entity && feed.entity.length > 0) {
      alerts = feed.entity
        .filter((e: { alert?: Record<string, unknown> }) => e.alert)
        .map((e: { id?: string; alert?: Record<string, unknown> }) => {
          const a = e.alert ?? {};
          return {
            id: e.id ?? '',
            header: translateText(a.headerText),
            description: translateText(a.descriptionText),
            routeIds: ((a.informedEntity ?? []) as Record<string, unknown>[])
              .map((ie: Record<string, unknown>) => String(ie.routeId ?? '')).filter(Boolean),
            effectiveStart: a.activePeriod?.[0]?.start ? new Date(Number(a.activePeriod[0].start) * 1000).toISOString() : undefined,
            effectiveEnd: a.activePeriod?.[0]?.end ? new Date(Number(a.activePeriod[0].end) * 1000).toISOString() : undefined,
            cause: a.cause as number | undefined,
            effect: a.effect as number | undefined,
            url: a.url?.translation?.[0]?.text as string | undefined,
          };
        });
    }
  } catch {
    // protobuf-jäsennys epäonnistui, yritä JSON
  }

  // 2) Jos protobuf ei toiminut, yritä JSON (moni palvelin palauttaa JSON-muunnoksen)
  if (alerts.length === 0) {
    try {
      const jsonData = JSON.parse(responseBody.toString('utf8'));
      const rawAlerts = Array.isArray(jsonData)
        ? jsonData
        : (jsonData.alerts ?? jsonData.entities ?? jsonData.feeds ?? []);
      alerts = rawAlerts.map((a: Record<string, unknown>) => ({
        id: String(a.id ?? ''),
        header: String(a.headerText ?? a.title ?? a.header ?? ''),
        description: String(a.descriptionText ?? a.description ?? ''),
        routeIds: (a.informedEntity ?? a.routeIds ?? []).map((r: unknown) => String(r)),
        effectiveStart: (a.effectiveStartDate ?? a.start as string) ?? undefined,
        effectiveEnd: (a.effectiveEndDate ?? a.end as string) ?? undefined,
      }));
    } catch {
      logger.error('Häiriötietojen jäsennys epäonnistui (protobuf + JSON + XML)');
      return { status: 'ERROR', itemsProcessed: 0 };
    }
  }

  if (alerts.length === 0) {
    logger.info('Ei häiriötiedotteita', { url: apiUrl });
    return { status: 'OK', itemsProcessed: 0 };
  }

  const processed: string[] = [];
  for (const alert of alerts) {
    const sourceId = alert.id || `alert-${ulid()}`;
    const contentHash = sha256Hex(JSON.stringify(alert));
    const processingKey = `NYSSE_ALERTS:${sourceId}:${contentHash.slice(0, 16)}`;

    const batchId = ulid();
    const rawKey = `source=nysse/year=${
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
        Bucket: bucketName, Key: rawKey, Body: JSON.stringify(alert), ContentType: 'application/json',
      }));
    } catch (err) {
      logger.error('S3-virhe', { sourceId, error: String(err) });
      continue;
    }

    const sourceEvent = {
      parsedId: ulid(), batchId,
      source: 'NYSSE_ALERTS' as const,
      sourceId, revision: undefined,
      processingKey,
      raw: alert,
      extractedAt: new Date().toISOString(),
    };

    const ingestMessage = {
      schemaVersion: '1.0' as const,
      batch: {
        batchId, source: 'NYSSE_ALERTS' as const,
        fetchedAt: new Date().toISOString(),
        s3Key: rawKey, contentType: 'application/json',
        byteSize: Buffer.byteLength(JSON.stringify(alert), 'utf8'),
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
          source: { DataType: 'String', StringValue: 'NYSSE_ALERTS' },
          correlationId: { DataType: 'String', StringValue: invocationId },
        },
      }));
    } catch (err) {
      logger.error('SQS-virhe', { sourceId, error: String(err) });
      continue;
    }

    processed.push(sourceId);
    logger.info('Häiriö käsitelty', { sourceId, header: alert.header?.slice(0, 80) });
  }

  return { status: 'OK', itemsProcessed: processed.length };
}

function translateText(obj: unknown): string {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  const o = obj as Record<string, unknown>;
  if (o.translation) {
    const arr = Array.isArray(o.translation) ? o.translation : [o.translation];
    const fi = arr.find((t: Record<string, unknown>) => t.language === 'fi' || t.language === 'sv');
    return String(fi?.text ?? arr[0]?.text ?? '') as string;
  }
  if (o.text) return String(o.text);
  return '';
}
