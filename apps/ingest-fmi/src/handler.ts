/**
 * ingest-fmi — Ilmatieteen laitoksen CAP-säävaroitusten lähdeadapteri.
 *
 * Hakee RSS-syötteen (alerts.fmi.fi/cap/feed/rss_fi-FI.rss), jäsentää
 * RSS-itemit, noutaa jokaisen CAP-XML:n, suodattaa Pirkanmaa/Tampere-
 * alueen, tallentaa raakadatan S3:een ja lähettää jäsennetyt tapahtumat
 * SQS-ingestion-jonoon normalisointia varten.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createLogger } from '@tampere360/observability';
import { fetchWithRetry, saveIngestionCheckpoint, sha256Hex, ulid } from '@tampere360/source-adapter-sdk';

import { type ParsedCapAlert, parseCapXml, parseRssFeed } from './cap-parser';

const logger = createLogger({
  service: 'ingest-fmi',
  source: 'FMI_CAP',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

const RSS_URL = 'https://alerts.fmi.fi/cap/feed/rss_fi-FI.rss';

/**
 * Peruutusviesti (msgType=Cancel) tulee FMI:ltä **uudella** identifierillä ja
 * viittaa alkuperäiseen varoitukseen `<references>`-kentässä. Kohdistetaan
 * peruutus viitattuun tunnisteeseen, jotta se osuu samaan canonicalKeyhin
 * (= samaan tilanteeseen) kuin alkuperäinen varoitus — muuten peruutuksesta
 * syntyisi irrallinen tapahtuma eikä vanha varoitus koskaan päättyisi.
 */
function cancelTargetId(parsed: ParsedCapAlert): string {
  const referenced = parsed.referencedIdentifiers[0];
  return parsed.status === 'CANCELLED' && referenced ? referenced : parsed.identifier;
}

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const invocationId = ulid();

  logger.info('Aloitetaan FMI CAP -haku', { url: RSS_URL });

  // 1. Nouda RSS-syöte
  let rssXml: string;
  try {
    const res = await fetchWithRetry(RSS_URL, { timeoutMs: 15_000, maxAttempts: 3 });
    rssXml = res.body;
  } catch (err) {
    logger.error('RSS-haku epäonnistui', { error: String(err) });
    await saveIngestionCheckpoint({
      tableName: process.env['INGESTION_STATE_TABLE_NAME'] ?? '',
      source: 'FMI_CAP',
      status: 'ERROR',
      error: String(err),
    });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  // 2. Jäsennä RSS
  const items = parseRssFeed(rssXml);
  logger.info('RSS itemit haettu', { count: items.length });

  // 3. Käy läpi jokainen CAP item, nouda XML, suodata, lähetä
  const processed: string[] = [];
  for (const item of items) {
    const guid = typeof item.guid === 'object' ? item.guid?.['#text'] ?? String(item.guid) : String(item.guid ?? '');
    const capUrl = item.link;
    if (!capUrl || !guid) continue;

    // Nouda CAP-XML
    let capXml: string;
    try {
      const res = await fetchWithRetry(capUrl, { timeoutMs: 15_000, maxAttempts: 2 });
      capXml = res.body;
    } catch {
      continue;
    }

    const parsed = parseCapXml(capXml);
    if (!parsed || !parsed.relevantForTampereRegion) {
      continue;
    }

    // Tallenna raakadata S3:een
    const batchId = ulid();
    const rawKey = `source=fmi-cap/year=${
      new Date().getUTCFullYear()
    }/month=${
      String(new Date().getUTCMonth() + 1).padStart(2, '0')
    }/day=${
      String(new Date().getUTCDate()).padStart(2, '0')
    }/hour=${
      String(new Date().getUTCHours()).padStart(2, '0')
    }/${batchId}.xml`;

    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucketName, Key: rawKey, Body: capXml, ContentType: 'application/xml',
      }));
    } catch (err) {
      logger.error('S3-virhe', { guid, error: String(err) });
      continue;
    }

    const sourceId = cancelTargetId(parsed);
    const contentHash = sha256Hex(capXml);
    const processingKey = `FMI_CAP:${sourceId}:${contentHash.slice(0, 16)}`;

    const sourceEvent = {
      parsedId: ulid(),
      batchId,
      source: 'FMI_CAP' as const,
      sourceId,
      processingKey,
      raw: parsed,
      extractedAt: new Date().toISOString(),
    };

    const ingestMessage = {
      schemaVersion: '1.0' as const,
      batch: {
        batchId,
        source: 'FMI_CAP' as const,
        fetchedAt: new Date().toISOString(),
        s3Key: rawKey,
        contentType: 'application/xml',
        byteSize: Buffer.byteLength(capXml, 'utf8'),
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
          source: { DataType: 'String', StringValue: 'FMI_CAP' },
          correlationId: { DataType: 'String', StringValue: invocationId },
        },
      }));
    } catch (err) {
      logger.error('SQS-virhe', { guid, error: String(err) });
      continue;
    }

    processed.push(guid);
    logger.info('CAP varoitus käsitelty', {
      event: parsed.event, severity: parsed.severity,
    });
  }

  await saveIngestionCheckpoint({
    tableName: process.env['INGESTION_STATE_TABLE_NAME'] ?? '',
    source: 'FMI_CAP',
    status: 'OK',
    lastSuccessfulFetch: new Date().toISOString(),
    itemsReceived: processed.length,
  });
  return { status: 'OK', itemsProcessed: processed.length };
}
