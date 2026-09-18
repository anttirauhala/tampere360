/**
 * ingest-tampere-traffic — Digitraffic v2 liikennetiedotteiden lähdeadapteri
 * (ensisijainen liikennelähde, arkkitehtuuri §9).
 *
 * Korvaa Tampereen oman rajapinnan (traffic-incidents.tampere.fi ei validoitu
 * toimivaksi 6.9.2026). Suodattaa Pirkanmaan ilmoitukset (province = Pirkanmaa
 * tai tunnettu kunta).
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createLogger } from '@tampere360/observability';
import { fetchWithRetry, saveIngestionCheckpoint, sha256Hex, ulid } from '@tampere360/source-adapter-sdk';

const logger = createLogger({
  service: 'ingest-tampere-traffic',
  source: 'TAMPERE_TRAFFIC',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const s3 = new S3Client({});
const sqs = new SQSClient({});

const API_URL = 'https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements';

/** Pirkanmaan kunnat — näiden ulkopuoliset suodatetaan pois. */
const PIRKANMAA_MUNICIPALITIES = new Set([
  'Tampere','Nokia','Pirkkala','Ylöjärvi','Lempäälä','Kangasala','Vesilahti',
  'Akaa','Valkeakoski','Sastamala','Ikaalinen','Parkano','Ruovesi',
  'Mänttä-Vilppula','Urjala','Hämeenkyrö','Juupajoki','Kihniö','Kuhmoinen',
  'Orivesi','Punkalaidun','Virrat',
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
  logger.info('Liikennetiedotteita', { total: collection.features.length, filtered: filtered.length });

  const processed: string[] = [];
  for (const feat of filtered) {
    const ann = feat.properties.announcements?.[0];
    if (!ann) continue;

    const sourceId = feat.properties.situationId;
    const title = ann.title;
    const rawObj = { ...feat };
    const contentHash = sha256Hex(JSON.stringify(rawObj));
    const revision = String(feat.properties.version);
    const processingKey = `TAMPERE_TRAFFIC:${sourceId}:${revision}`;

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
        Bucket: bucketName, Key: rawKey, Body: JSON.stringify(rawObj), ContentType: 'application/json',
      }));
    } catch (err) {
      logger.error('S3-virhe', { sourceId, error: String(err) });
      continue;
    }

    const sourceEvent = {
      parsedId: ulid(), batchId,
      source: 'TAMPERE_TRAFFIC' as const,
      sourceId, revision,
      processingKey,
      raw: rawObj,
      extractedAt: new Date().toISOString(),
    };

    const ingestMessage = {
      schemaVersion: '1.0' as const,
      batch: {
        batchId, source: 'TAMPERE_TRAFFIC' as const,
        fetchedAt: new Date().toISOString(),
        s3Key: rawKey, contentType: 'application/json',
        byteSize: Buffer.byteLength(JSON.stringify(rawObj), 'utf8'),
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
          source: { DataType: 'String', StringValue: 'TAMPERE_TRAFFIC' },
          correlationId: { DataType: 'String', StringValue: invocationId },
        },
      }));
    } catch (err) {
      logger.error('SQS-virhe', { sourceId, error: String(err) });
      continue;
    }

    processed.push(sourceId);
    logger.info('Käsitelty', { sourceId, title, municipality: pickMunicipality(feat) });
  }

  await saveIngestionCheckpoint({
    tableName: process.env['INGESTION_STATE_TABLE_NAME'] ?? '',
    source: 'TAMPERE_TRAFFIC',
    status: 'OK',
    lastSuccessfulFetch: new Date().toISOString(),
    itemsReceived: processed.length,
  });
  return { status: 'OK', itemsProcessed: processed.length };
}
