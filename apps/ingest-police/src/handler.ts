/**
 * ingest-police — Sisä-Suomen poliisilaitoksen RSS-tiedotteiden lähdeadapteri
 * (arkkitehtuuri §9). Hakee RSS-syötteen, suodattaa Tampere/Pirkanmaa-
 * aiheiset otsikot, tallentaa raakadatan S3:een ja lähettää tapahtumat
 * SQS-ingestion-jonoon. CC BY 4.0.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createLogger } from '@tampere360/observability';
import { fetchWithRetry, sha256Hex, ulid } from '@tampere360/source-adapter-sdk';
import { XMLParser } from 'fast-xml-parser';

const logger = createLogger({
  service: 'ingest-police',
  source: 'POLICE_RSS',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

const RSS_URL = 'https://poliisi.fi/sisa-suomen-poliisilaitos/-/asset_publisher/ZtAEeHB39Lxr/rss';

/** Pirkanmaan kaupunkeja ja tunnisteita — jos otsikossa esiintyy, käsitellään. */
const TAMPERE_KEYWORDS = [
  'tampere', 'nokia', 'pirkkala', 'ylöjärvi', 'lempäälä', 'kangasala',
  'virrat', 'ruovesi', 'parkano', 'ikaalinen', 'sastamala',
  'valkeakoski', 'akaa', 'pirkanmaa', 'tampereella', 'näsijärvi',
  'rantaväylä', 'hämeenkatu', 'pispala', 'hervanta', 'tesoma',
  'ratina', 'rautatientori', 'linja-autoasema', 'sorin aukio',
  'lielahti', 'koivistonkylä', 'lapinniemi', 'epilänharju',
];

function isRelevant(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return TAMPERE_KEYWORDS.some((kw) => text.includes(kw));
}

interface RssItem {
  title?: string;
  link?: string;
  description?: string;
  guid?: { '#text'?: string } | string;
  pubDate?: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const invocationId = ulid();

  logger.info('Haetaan poliisin RSS-tiedotteita', { url: RSS_URL });

  let rssXml: string;
  try {
    const res = await fetchWithRetry(RSS_URL, { timeoutMs: 15_000, maxAttempts: 3 });
    rssXml = res.body;
  } catch (err) {
    logger.error('RSS-haku epäonnistui', { error: String(err) });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  let doc: Record<string, unknown>;
  try {
    doc = xmlParser.parse(rssXml);
  } catch {
    logger.error('RSS-jäsennys epäonnistui');
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  const rss = doc?.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (!channel) {
    logger.warn('RSS-syötteessä ei channelia');
    return { status: 'OK', itemsProcessed: 0 };
  }

  const rawItems = channel.item ?? [];
  const items: RssItem[] = Array.isArray(rawItems) ? rawItems as RssItem[] : [rawItems] as RssItem[];

  // Suodata duplikaatit guid:n perusteella (normalisointi hoitaa lopullisen idempotenssin)
  const seen = new Set<string>();
  const relevant: RssItem[] = [];
  for (const item of items) {
    const guid = typeof item.guid === 'object' ? item.guid?.['#text'] ?? '' : String(item.guid ?? '');
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    const title = String(item.title ?? '');
    const desc = String(item.description ?? '');
    // Vain Tampere/Pirkanmaa -relevantit
    if (!isRelevant(title, desc)) continue;
    relevant.push(item);
  }

  logger.info('RSS käsitelty', { total: items.length, relevant: relevant.length });

  const processed: string[] = [];
  for (const item of relevant) {
    const rawGuid = typeof item.guid === 'object' ? item.guid?.['#text'] ?? '' : String(item.guid ?? '');
    const sourceId = rawGuid || `police-${ulid()}`;
    const contentHash = sha256Hex(JSON.stringify(item));
    const processingKey = `POLICE_RSS:${sourceId}:${contentHash.slice(0, 16)}`;

    const batchId = ulid();
    const rawKey = `source=police/year=${
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
        Bucket: bucketName, Key: rawKey, Body: JSON.stringify(item), ContentType: 'application/json',
      }));
    } catch (err) {
      logger.error('S3-virhe', { sourceId, error: String(err) });
      continue;
    }

    const sourceEvent = {
      parsedId: ulid(), batchId,
      source: 'POLICE_RSS' as const,
      sourceId, revision: undefined,
      processingKey,
      raw: item,
      extractedAt: new Date().toISOString(),
    };

    const ingestMessage = {
      schemaVersion: '1.0' as const,
      batch: {
        batchId, source: 'POLICE_RSS' as const,
        fetchedAt: new Date().toISOString(),
        s3Key: rawKey, contentType: 'application/json',
        byteSize: Buffer.byteLength(JSON.stringify(item), 'utf8'),
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
          source: { DataType: 'String', StringValue: 'POLICE_RSS' },
          correlationId: { DataType: 'String', StringValue: invocationId },
        },
      }));
    } catch (err) {
      logger.error('SQS-virhe', { sourceId, error: String(err) });
      continue;
    }

    processed.push(sourceId);
    logger.info('Poliisitiedote käsitelty', { sourceId, title: (item.title ?? '').slice(0, 80) });
  }

  return { status: 'OK', itemsProcessed: processed.length };
}
