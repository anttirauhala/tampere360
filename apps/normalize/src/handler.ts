/**
 * normalize — normalisointi-Lambda (arkkitehtuuri §2–3).
 *
 * SQS-ingestion-jono -> IngestMessage -> Tampere247Event ->
 * SourceEventNormalized EventBridge custom busille.
 * Tukee useita lähteita: FMI_CAP, TAMPERE_TRAFFIC, ...
 */

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { createLogger } from '@tampere360/observability';
import { sha256Hex, ulid } from '@tampere360/source-adapter-sdk';
import type { IngestMessage, Tampere247Event } from '@tampere360/event-contracts';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

const logger = createLogger({
  service: 'normalize',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const eventbridge = new EventBridgeClient({});

function mapRawToFields(source: string, raw: Record<string, unknown> | undefined) {
  if (source === 'FMI_CAP') {
    const capSev = String(raw?.severity ?? '').toLowerCase();
    const severity = capSev === 'extreme' ? 'CRITICAL' : capSev === 'severe' ? 'MAJOR' : capSev === 'moderate' ? 'MINOR' : 'INFO';
    return {
      type: 'WEATHER_WARNING' as const,
      category: 'WEATHER' as const,
      severity,
      title: { fi: String(raw?.event ?? 'Säävaroitus') },
      description: raw?.description ? { fi: String(raw.description) } : undefined,
      attribution: { name: 'Ilmatieteen laitos', required: true },
      areaCodes: ['PIRKANMAA'] as string[],
      validity: { startsAt: raw?.onset ? String(raw.onset) : null, endsAt: raw?.expires ? String(raw.expires) : null },
    };
  }
  if (source === 'TAMPERE_TRAFFIC') {
    const stType = String(raw?.situationType ?? raw?.trafficAnnouncementType ?? '');
    const type = stType.toLowerCase().includes('roadwork') ? 'ROADWORK' as const : 'TRAFFIC_INCIDENT' as const;
    const sev = String(raw?.severity ?? '').toUpperCase();
    const severity = ['INFO','MINOR','MAJOR','CRITICAL'].includes(sev) ? sev : 'MAJOR';
    const loc = raw?.location as Record<string, unknown> | undefined;
    const announcements = Array.isArray(raw?.announcements) ? raw.announcements as Record<string, unknown>[] : [];
    const title = announcements[0]?.title ? String(announcements[0].title) : String(raw?.title ?? 'Liikennetapahtuma');
    const locDetails = raw?.locationDetails as Record<string, unknown> | undefined;
    const roadLoc = locDetails?.roadAddressLocation as Record<string, unknown> | undefined;
    const municipality = (roadLoc?.municipality as string | undefined) ?? (loc?.municipality as string | undefined) ?? null;
    const td = announcements[0]?.timeAndDuration as Record<string, unknown> | undefined;
    return {
      type,
      category: 'TRAFFIC' as const,
      severity,
      title: { fi: title },
      description: announcements[0]?.comment ? { fi: String(announcements[0].comment) } : undefined,
      attribution: { name: 'Tampereen kaupunki', required: true },
      location: { municipality, latitude: (loc?.latitude ?? null) as number | null, longitude: (loc?.longitude ?? null) as number | null },
      validity: { startsAt: td?.startTime as string | null ?? null, endsAt: td?.endTime as string | null ?? null },
      areaCodes: municipality ? [municipality] : [],
    };
  }
  return {
    type: 'OTHER' as const, category: 'TRAFFIC' as const,
    severity: 'INFO', title: { fi: String(raw?.title ?? 'Tapahtuma') },
    attribution: { name: source, required: false },
    location: null, validity: null, areaCodes: [],
  };
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failIds: string[] = [];
  for (const record of event.Records) {
    const messageId = record.messageId;
    let ingestMessage: IngestMessage;
    try { ingestMessage = JSON.parse(record.body) as IngestMessage; } catch { failIds.push(messageId); continue; }
    if (!ingestMessage.events?.length) continue;
    for (const parsedEvent of ingestMessage.events) {
      try {
        const raw = parsedEvent.raw as Record<string, unknown> | undefined;
        const contentHash = sha256Hex(JSON.stringify(raw ?? {}));
        const now = new Date().toISOString();
        const eventId = ulid();
        const m = mapRawToFields(parsedEvent.source, raw);
        const normalized: Tampere247Event = {
          schemaVersion: '1.0', id: eventId,
          canonicalKey: `${parsedEvent.source}:${parsedEvent.sourceId}`,
          processingKey: parsedEvent.processingKey,
          source: { system: parsedEvent.source, sourceId: parsedEvent.sourceId, fetchedAt: ingestMessage.batch.fetchedAt },
          type: m.type as Tampere247Event['type'],
          category: m.category as Tampere247Event['category'],
          severity: m.severity as Tampere247Event['severity'],
          status: 'ACTIVE', lifecycle: 'ACTIVE',
          title: m.title, description: m.description,
          location: {
            municipality: m.location?.municipality ?? null, district: null, address: null,
            latitude: m.location?.latitude ?? null, longitude: m.location?.longitude ?? null,
            geometry: null, areaCodes: (m.areaCodes ?? []) as Tampere247Event['location']['areaCodes'],
          },
          validity: { startsAt: m.validity?.startsAt ?? null, endsAt: m.validity?.endsAt ?? null },
          publishedAt: now, updatedAt: now, tags: [],
          attribution: m.attribution, contentHash,
        };
        await eventbridge.send(new PutEventsCommand({
          Entries: [{
            EventBusName: process.env['EVENT_BUS_NAME'] ?? 'tampere360-dev-events',
            Source: 'tampere360', DetailType: 'SourceEventNormalized',
            Detail: JSON.stringify({ event: normalized, batchId: ingestMessage.batch.batchId, occurredAt: now }),
          }],
        }));
        logger.info('Normalisoitu', { source: parsedEvent.source, processingKey: parsedEvent.processingKey, type: m.type });
      } catch (e) { failIds.push(messageId); }
    }
  }
  return { batchItemFailures: [...new Set(failIds)].map((id) => ({ itemIdentifier: id })) };
}
