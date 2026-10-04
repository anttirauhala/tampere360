/**
 * ingest-nysse — Nysse-häiriötiedotteet Waltti APIsta (Basic Auth).
 *
 * Kustannusoptimointi 4.10.2026: vain muuttuneet tietueet lähetetään ja
 * yhdestä ajokerrasta syntyy yksi S3-objekti (ks. source-adapter-sdk).
 * Aiemmin sama muuttumaton häiriö lähetettiin minuutin välein.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createLogger } from '@tampere360/observability';
import {
  buildRawArchive,
  buildSentItems,
  dropSentItems,
  loadSentItems,
  rawArchiveKey,
  saveIngestionCheckpoint,
  selectChangedItems,
  sha256Hex,
  ulid,
} from '@tampere360/source-adapter-sdk';
import { transit_realtime } from 'gtfs-realtime-bindings';

import { type NysseOutcome, buildNysseCheckpoint } from './checkpoint';

const logger = createLogger({
  service: 'ingest-nysse',
  source: 'NYSSE_ALERTS',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});
const s3 = new S3Client({});
const sqs = new SQSClient({});
const ssm = new SSMClient({});

const SOURCE = 'NYSSE_ALERTS' as const;
const ARCHIVE_PREFIX = 'nysse';

/** Yhden häiriön ehdokas (ennen muutosvertailua). */
interface NysseCandidate {
  sourceId: string;
  contentHash: string;
  processingKey: string;
  raw: unknown;
}

/**
 * Kirjoittaa lähdekohtaisen tilan IngestionState-tauluun JOKAISELLA ajokerralla.
 * Tämä on ainoa tapa, jolla `/v1/health/sources` näkee lähteen — myös silloin
 * kun ajo ei tuottanut yhtään tietuetta (esim. puuttuva API-avain).
 */
async function saveCheckpoint(
  outcome: NysseOutcome,
  itemsReceived = 0,
  sentItems?: Record<string, string>,
): Promise<void> {
  const checkpoint = buildNysseCheckpoint(outcome, itemsReceived);
  await saveIngestionCheckpoint({
    tableName: process.env['INGESTION_STATE_TABLE_NAME'] ?? '',
    source: SOURCE,
    status: checkpoint.status,
    itemsReceived: checkpoint.itemsReceived,
    ...(checkpoint.lastSuccessfulFetch
      ? { lastSuccessfulFetch: checkpoint.lastSuccessfulFetch }
      : {}),
    ...(checkpoint.error ? { error: checkpoint.error } : {}),
    ...(sentItems ? { sentItems } : {}),
  });
}

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
  const tableName = process.env['INGESTION_STATE_TABLE_NAME'] ?? '';
  const env = process.env['ENVIRONMENT'] || 'dev';
  const invocationId = ulid();

  // Hae Basic Auth -avain SSM:sta (/tampere360/{env}/sources/nysse/api-key)
  let apiKey = '';
  try {
    const r = await ssm.send(
      new GetParameterCommand({
        Name: `/tampere360/${env}/sources/nysse/api-key`,
        WithDecryption: true,
      }),
    );
    apiKey = r.Parameter?.Value ?? '';
  } catch {
    // SSM-haku epäonnistui — käsitellään alla puuttuvana avaimena.
  }

  if (!apiKey) {
    logger.warn('Nysse API-avain puuttuu SSM:sta');
    // Kirjoitetaan virhetila, jotta puuttuva konfiguraatio näkyy
    // /v1/health/sources-listalla (aiemmin lähde katosi listalta kokonaan).
    await saveCheckpoint('API_KEY_MISSING');
    return { status: 'ERROR', itemsProcessed: 0 };
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
    await saveCheckpoint('FETCH_FAILED');
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  // Jasenna protobuf
  const alerts: Record<string, string | undefined>[] = [];
  let feedTimestamp: string | undefined;
  let parsedOk = true;
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
          header: t(a.headerText),
          description: t(a.descriptionText),
          start: a.activePeriod?.[0]?.start
            ? new Date(Number(a.activePeriod[0].start) * 1000).toISOString()
            : undefined,
          end: a.activePeriod?.[0]?.end
            ? new Date(Number(a.activePeriod[0].end) * 1000).toISOString()
            : undefined,
        });
      }
    }
  } catch {
    // Protobuf-jäsennys epäonnistui — tämä EI ole sama asia kuin "ei häiriöitä".
    parsedOk = false;
  }

  if (!parsedOk) {
    logger.error('Protobuf-jäsennys epäonnistui');
    await saveCheckpoint('PARSE_FAILED');
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  if (alerts.length === 0) {
    logger.info('Ei hairioita');
    await saveCheckpoint('NO_ALERTS');
    return { status: 'OK', itemsProcessed: 0 };
  }

  // Sisältötarkiste lasketaan VAIN häiriön omista, vakioista kentistä:
  // feedTimestamp muuttuu jokaisella haulla eikä se saa muuttaa
  // processingKeyta (muuten sama häiriö lois uuden tilanteen joka minuutti).
  const candidates: NysseCandidate[] = alerts.map((a) => {
    const core = {
      entityId: a['entityId'],
      header: a['header'],
      description: a['description'],
      start: a['start'],
      end: a['end'],
    };
    const c = sha256Hex(JSON.stringify(core));
    const sourceId = a['entityId'] ?? `alert-${c.slice(0, 16)}`;
    return {
      sourceId,
      contentHash: c,
      processingKey: `NYSSE_ALERTS:${sourceId}:${c.slice(0, 16)}`,
      raw: { ...core, feedTimestamp },
    };
  });

  // Lähetä vain muuttuneet (kustannusoptimointi 4.10.2026).
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
      await saveCheckpoint('SUCCESS', alerts.length, previous);
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
      } catch (err) {
        failed.push(c.sourceId);
        logger.error('SQS-virhe', { sourceId: c.sourceId, error: String(err) });
      }
    }
  }

  logger.info('Nysse valmis', { sent, failed: failed.length });
  await saveCheckpoint('SUCCESS', alerts.length, dropSentItems(buildSentItems(candidates), failed));
  return { status: 'OK', itemsProcessed: sent };
}

function t(obj: unknown): string {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  const o = obj as Record<string, unknown>;
  if (o.translation) {
    const arr = Array.isArray(o.translation) ? o.translation : [o.translation];
    return String(
      arr.find((tx: Record<string, unknown>) => tx.language === 'fi')?.text ?? arr[0]?.text ?? '',
    );
  }
  return '';
}
