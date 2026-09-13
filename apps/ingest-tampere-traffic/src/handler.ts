/**
 * ingest-tampere-traffic — Tampereen kaupungin liikennetiedote-/tietyö-
 * rajapinnan lähdeadapteri (ensisijainen liikennelähde, arkkitehtuuri §9).
 *
 * Hakee traffic-incidents.tampere.fi/api/v1 (JSON/D2Light), jäsentää
 * tapahtumat tallentaa raakadatan S3:een ja lähettää tapahtumat
 * SQS-ingestion-jonoon normalisointia varten.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createLogger } from '@tampere360/observability';
import { fetchWithRetry, sha256Hex, ulid } from '@tampere360/source-adapter-sdk';

const logger = createLogger({
  service: 'ingest-tampere-traffic',
  source: 'TAMPERE_TRAFFIC',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

const API_URL = 'https://traffic-incidents.tampere.fi/api/v1';

/** Yksittäisen liikennetapahtuman tyyppi. */
interface TrafficIncident {
  id?: string;
  situationType?: string;
  trafficAnnouncementType?: string;
  title?: string;
  description?: string;
  severity?: string;
  status?: string;
  startTime?: string;
  endTime?: string;
  lastUpdated?: string;
  location?: Record<string, unknown>;
  locationDetails?: Record<string, unknown>;
  /** Useat D2Light-mallistot käyttävät sisäkkäisiä annoucements-taulukkoa. */
  announcements?: Record<string, unknown>[];
}

function extractIncidents(body: unknown): TrafficIncident[] {
  if (Array.isArray(body)) return body as TrafficIncident[];
  const root = body as Record<string, unknown> | undefined;
  if (!root) return [];
  // Yritä eri kenttiä joista liikennetapahtuma-taulukko voisi löytyä
  return (root.situations ?? root.items ?? root.roadworks ?? root.trafficIncidents ?? root.features ?? []) as TrafficIncident[];
}

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const invocationId = ulid();

  logger.info('Haetaan Tampereen liikennetietoja', { url: API_URL });

  let rawJson: string;
  try {
    const res = await fetchWithRetry(API_URL, { timeoutMs: 15_000, maxAttempts: 3 });
    rawJson = res.body;
  } catch (err) {
    logger.error('API-haku epäonnistui', { error: String(err) });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch {
    logger.error('JSON-jäsennys epäonnistui');
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  const incidents = extractIncidents(data);
  if (incidents.length === 0) {
    logger.info('Ei liikennetapahtumia', { url: API_URL });
    return { status: 'OK', itemsProcessed: 0 };
  }

  const processed: string[] = [];
  for (const inc of incidents) {
    const sourceId = inc.id ?? `incident-${ulid()}`;
    const title = inc.title ?? (inc.announcements?.[0]?.title as string | undefined) ?? 'Tuntematon';
    const contentHash = sha256Hex(JSON.stringify(inc));
    const processingKey = `TAMPERE_TRAFFIC:${sourceId}:${contentHash.slice(0, 16)}`;

    // Tallenna raakadata S3:een
    const batchId = ulid();
    const rawKey = `source=tampere-traffic/year=${
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
        Bucket: bucketName,
        Key: rawKey,
        Body: JSON.stringify(inc),
        ContentType: 'application/json',
      }));
    } catch (err) {
      logger.error('S3-tallennus epäonnistui', { sourceId, error: String(err) });
      continue;
    }

    // Muodosta jäsennelty tapahtuma ja lähetä SQS:ään
    const sourceEvent = {
      parsedId: ulid(),
      batchId,
      source: 'TAMPERE_TRAFFIC' as const,
      sourceId,
      processingKey,
      raw: inc,
      extractedAt: new Date().toISOString(),
    };

    const ingestMessage = {
      schemaVersion: '1.0' as const,
      batch: {
        batchId,
        source: 'TAMPERE_TRAFFIC' as const,
        fetchedAt: new Date().toISOString(),
        s3Key: rawKey,
        contentType: 'application/json',
        byteSize: Buffer.byteLength(JSON.stringify(inc), 'utf8'),
        contentHash: sha256Hex(JSON.stringify(inc)),
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
          source: { DataType: 'String', StringValue: 'TAMPERE_TRAFFIC' },
          correlationId: { DataType: 'String', StringValue: invocationId },
        },
      }));
    } catch (err) {
      logger.error('SQS-lähetys epäonnistui', { sourceId, error: String(err) });
      continue;
    }

    processed.push(sourceId);
    logger.info('Liikennetapahtuma käsitelty', { sourceId, title });
  }

  return { status: 'OK', itemsProcessed: processed.length };
}
