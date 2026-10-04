/**
 * ingest-fmi — Ilmatieteen laitoksen CAP-säävaroitusten lähdeadapteri.
 *
 * Hakee RSS-syötteen (alerts.fmi.fi/cap/feed/rss_fi-FI.rss), jäsentää
 * RSS-itemit, noutaa jokaisen CAP-XML:n, suodattaa Pirkanmaa/Tampere-
 * alueen, tallentaa raakadatan S3:een ja lähettää jäsennetyt tapahtumat
 * SQS-ingestion-jonoon normalisointia varten.
 *
 * Kustannusoptimointi 4.10.2026: vain muuttuneet tietueet lähetetään ja
 * yhdestä ajokerrasta syntyy yksi S3-objekti (ks. source-adapter-sdk).
 * CAP-XML haetaan edelleen jokaisesta RSS-itemistä, koska sisältötarkiste
 * (ja siten muutoksen tunnistus) lasketaan siitä.
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

import { type ParsedCapAlert, parseCapXml, parseRssFeed, warningIdentity } from './cap-parser';

const logger = createLogger({
  service: 'ingest-fmi',
  source: 'FMI_CAP',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

const RSS_URL = 'https://alerts.fmi.fi/cap/feed/rss_fi-FI.rss';
const SOURCE = 'FMI_CAP' as const;
const ARCHIVE_PREFIX = 'fmi-cap';

/** Yhden CAP-varoituksen ehdokas (ennen muutosvertailua). */
interface FmiCandidate {
  sourceId: string;
  contentHash: string;
  processingKey: string;
  raw: ParsedCapAlert;
  /** Alkuperäinen CAP-XML — säilytetään raaka-arkistossa uudelleenkäsittelyä varten. */
  sourceText: string;
  guid: string;
}

/**
 * Peruutusviesti (msgType=Cancel) tulee FMI:ltä **uudella** identifierillä ja
 * viittaa alkuperäiseen varoitukseen `<references>`-kentässä. Kohdistetaan
 * peruutus viitattuun tunnisteeseen, jotta se osuu samaan canonicalKeyhin
 * (= samaan tilanteeseen) kuin alkuperäinen varoitus — muuten peruutuksesta
 * syntyisi irrallinen tapahtuma eikä vanha varoitus koskaan päättyisi.
 *
 * Lähteetunnisteesta otetaan lisäksi **vakaa häntä** (`warningIdentity`), koska
 * FMI antaa jokaiselle päivitykselle uuden identifierin mutta pitää hännän
 * samana. Ilman tätä jokainen `Update` loi uuden tilanteen.
 */
function cancelTargetId(parsed: ParsedCapAlert): string {
  const referenced = parsed.referencedIdentifiers[0];
  return parsed.status === 'CANCELLED' && referenced ? referenced : parsed.identifier;
}

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const tableName = process.env['INGESTION_STATE_TABLE_NAME'] ?? '';
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
      tableName,
      source: SOURCE,
      status: 'ERROR',
      error: String(err),
    });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  // 2. Jäsennä RSS
  const items = parseRssFeed(rssXml);
  logger.info('RSS itemit haettu', { count: items.length });

  // 3. Käy läpi jokainen CAP item, nouda XML ja suodata Pirkanmaa/Tampere
  const candidates: FmiCandidate[] = [];
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

    const sourceId = warningIdentity(cancelTargetId(parsed));
    const contentHash = sha256Hex(capXml);
    candidates.push({
      sourceId,
      contentHash,
      processingKey: `FMI_CAP:${sourceId}:${contentHash.slice(0, 16)}`,
      raw: parsed,
      sourceText: capXml,
      guid,
    });
  }

  // 4. Lähetä vain muuttuneet (kustannusoptimointi 4.10.2026)
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
        sourceText: c.sourceText,
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
        logger.info('CAP varoitus lähetetty', {
          event: c.raw.event,
          severity: c.raw.severity,
        });
      } catch (err) {
        failed.push(c.sourceId);
        logger.error('SQS-virhe', { guid: c.guid, error: String(err) });
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
