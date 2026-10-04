/**
 * ingest-tampere-traffic — Digitraffic v2 liikennetiedotteiden lähdeadapteri
 * (ensisijainen liikennelähde, arkkitehtuuri §9).
 *
 * Korvaa Tampereen oman rajapinnan (traffic-incidents.tampere.fi ei validoitu
 * toimivaksi 6.9.2026). Suodattaa Pirkanmaan ilmoitukset (province = Pirkanmaa
 * tai tunnettu kunta).
 *
 * Kustannusoptimointi 4.10.2026: vain **muuttuneet** tietueet lähetetään ja
 * yhdestä ajokerrasta syntyy **yksi** S3-objekti. Aiemmin sama muuttumaton
 * tietue lähetettiin joka minuutti (ks. source-adapter-sdk/incremental.ts).
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
  service: 'ingest-tampere-traffic',
  source: 'TAMPERE_TRAFFIC',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

const API_URL = 'https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements';
const SOURCE = 'TAMPERE_TRAFFIC' as const;
const ARCHIVE_PREFIX = 'tampere-traffic';

/** Pirkanmaan kunnat — näiden ulkopuoliset suodatetaan pois. */
const PIRKANMAA_MUNICIPALITIES = new Set([
  'Tampere',
  'Nokia',
  'Pirkkala',
  'Ylöjärvi',
  'Lempäälä',
  'Kangasala',
  'Vesilahti',
  'Akaa',
  'Valkeakoski',
  'Sastamala',
  'Ikaalinen',
  'Parkano',
  'Ruovesi',
  'Mänttä-Vilppula',
  'Urjala',
  'Hämeenkyrö',
  'Juupajoki',
  'Kihniö',
  'Kuhmoinen',
  'Orivesi',
  'Punkalaidun',
  'Virrat',
]);

interface RoadAddressPoint {
  municipality?: string;
  province?: string;
  country?: string;
}

interface DigitrafficFeature {
  type: string;
  geometry: { type: string; coordinates: number[][] | number[][][] };
  properties: {
    situationId: string;
    situationType: string;
    trafficAnnouncementType: string;
    version: number;
    releaseTime: string;
    versionTime: string;
    announcements: {
      language: string;
      title: string;
      location: { description: string };
      locationDetails: {
        roadAddressLocation: {
          primaryPoint?: RoadAddressPoint;
          secondaryPoint?: RoadAddressPoint;
          direction?: string;
        };
      };
      features: { name: string }[];
      comment?: string;
      timeAndDuration: { startTime: string; endTime?: string };
      additionalInformation?: string;
      sender?: string;
    }[];
  };
}

/** Yhden ilmoituksen ehdokas (ennen muutosvertailua). */
interface TrafficCandidate {
  sourceId: string;
  contentHash: string;
  revision: string;
  processingKey: string;
  raw: unknown;
  title: string;
  municipality: string | null;
}

/**
 * Onko ilmoitus Pirkanmaalla? Digitraffic antaa kunnan ja maakunnan
 * roadAddressLocation.primaryPoint / secondaryPoint -tasolla.
 */
function isPirkanmaa(feature: DigitrafficFeature): boolean {
  for (const ann of feature.properties.announcements ?? []) {
    const roadLoc = ann.locationDetails?.roadAddressLocation;
    if (!roadLoc) continue;
    for (const point of [roadLoc.primaryPoint, roadLoc.secondaryPoint]) {
      if (!point) continue;
      if (point.province === 'Pirkanmaa') return true;
      if (point.municipality && PIRKANMAA_MUNICIPALITIES.has(point.municipality)) return true;
    }
  }
  return false;
}

/** Poimii kunnan ilmoituksesta (primaryPoint ensisijainen). */
function pickMunicipality(feature: DigitrafficFeature): string | null {
  for (const ann of feature.properties.announcements ?? []) {
    const roadLoc = ann.locationDetails?.roadAddressLocation;
    const m = roadLoc?.primaryPoint?.municipality ?? roadLoc?.secondaryPoint?.municipality;
    if (m) return m;
  }
  return null;
}

export async function handler(): Promise<{ status: string; itemsProcessed: number }> {
  const bucketName = process.env['RAW_BUCKET_NAME'] ?? '';
  const queueUrl = process.env['INGESTION_QUEUE_URL'] ?? '';
  const tableName = process.env['INGESTION_STATE_TABLE_NAME'] ?? '';
  const invocationId = ulid();

  logger.info('Haetaan Digitraffic liikennetiedotteita', { url: API_URL });

  let rawJson: string;
  try {
    const res = await fetchWithRetry(API_URL, { timeoutMs: 20_000, maxAttempts: 3 });
    rawJson = res.body;
  } catch (err) {
    logger.error('Haku epäonnistui', { error: String(err) });
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  let collection: { type: string; features: DigitrafficFeature[] };
  try {
    collection = JSON.parse(rawJson);
  } catch {
    logger.error('GeoJSON-jäsennys epäonnistui');
    return { status: 'ERROR', itemsProcessed: 0 };
  }

  if (!collection.features || collection.features.length === 0) {
    logger.info('Ei liikennetiedotteita', { url: API_URL });
    return { status: 'OK', itemsProcessed: 0 };
  }

  const filtered = collection.features.filter(isPirkanmaa);
  logger.info('Liikennetiedotteita', {
    total: collection.features.length,
    filtered: filtered.length,
  });

  const candidates: TrafficCandidate[] = [];
  for (const feat of filtered) {
    const ann = feat.properties.announcements?.[0];
    if (!ann) continue;
    const rawObj: unknown = { ...feat };
    candidates.push({
      sourceId: feat.properties.situationId,
      contentHash: sha256Hex(JSON.stringify(rawObj)),
      revision: String(feat.properties.version),
      processingKey: `TAMPERE_TRAFFIC:${feat.properties.situationId}:${feat.properties.version}`,
      raw: rawObj,
      title: ann.title,
      municipality: pickMunicipality(feat),
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
    // Yksi S3-objekti per ajokerta (koko tietuejoukko), ei objektia per tietue.
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
        revision: c.revision,
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
        logger.info('Lähetetty', {
          sourceId: c.sourceId,
          title: c.title,
          municipality: c.municipality,
        });
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
