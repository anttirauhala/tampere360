/**
 * normalize — normalisointi-Lambda (arkkitehtuuri §2–3).
 * Tukee FMI_CAP, TAMPERE_TRAFFIC, VISIT_TAMPERE.
 */

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { createLogger } from '@tampere360/observability';
import { sha256Hex, ulid } from '@tampere360/source-adapter-sdk';
import type { IngestMessage, Tampere247Event } from '@tampere360/event-contracts';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

const logger = createLogger({ service: 'normalize', environment: process.env['ENVIRONMENT'] ?? 'dev' });
const eventbridge = new EventBridgeClient({});

function mapRawToFields(source: string, raw: Record<string, unknown> | undefined) {
  if (source === 'FMI_CAP') {
    const s = String(raw?.severity ?? '').toLowerCase();
    const severity = s === 'extreme' ? 'CRITICAL' : s === 'severe' ? 'MAJOR' : s === 'moderate' ? 'MINOR' : 'INFO';
    return {
      type: 'WEATHER_WARNING' as const, category: 'WEATHER' as const, severity,
      title: { fi: String(raw?.event ?? 'Säävaroitus') },
      description: raw?.description ? { fi: String(raw.description) } : undefined,
      attribution: { name: 'Ilmatieteen laitos', required: true },
      areaCodes: ['PIRKANMAA'] as string[],
      validity: { startsAt: raw?.onset ? String(raw.onset) : null, endsAt: raw?.expires ? String(raw.expires) : null },
      location: { municipality: null, latitude: null, longitude: null },
    };
  }
  if (source === 'TAMPERE_TRAFFIC') {
    const st = String(raw?.situationType ?? raw?.trafficAnnouncementType ?? '');
    const type = st.toLowerCase().includes('roadwork') ? 'ROADWORK' as const : 'TRAFFIC_INCIDENT' as const;
    const sev = String(raw?.severity ?? '').toUpperCase();
    const severity = ['INFO','MINOR','MAJOR','CRITICAL'].includes(sev) ? sev : 'MAJOR';
    const loc = raw?.location as Record<string, unknown> | undefined;
    const anns = Array.isArray(raw?.announcements) ? raw.announcements as Record<string, unknown>[] : [];
    const title = anns[0]?.title ? String(anns[0].title) : String(raw?.title ?? 'Liikennetapahtuma');
    const roadLoc = (raw?.locationDetails as Record<string, unknown> | undefined)?.roadAddressLocation as Record<string, unknown> | undefined;
    const municipality = (roadLoc?.municipality as string | undefined) ?? (loc?.municipality as string | undefined) ?? null;
    const td = anns[0]?.timeAndDuration as Record<string, unknown> | undefined;
    return {
      type, category: 'TRAFFIC' as const, severity,
      title: { fi: title },
      description: anns[0]?.comment ? { fi: String(anns[0].comment) } : undefined,
      attribution: { name: 'Tampereen kaupunki / Digitraffic', required: true },
      areaCodes: municipality ? [municipality] : ['TAMPERE'],
      location: { municipality, latitude: (loc?.latitude ?? null) as number | null, longitude: (loc?.longitude ?? null) as number | null },
      validity: { startsAt: td?.startTime as string | null ?? null, endsAt: td?.endTime as string | null ?? null },
    };
  }
  if (source === 'VISIT_TAMPERE') {
    const loc = raw?.location as Record<string, unknown> | undefined;
    const lat = (loc?.coordinates as Record<string, unknown> | undefined)?.lat as number | undefined;
    const lon = (loc?.coordinates as Record<string, unknown> | undefined)?.lon as number | undefined;
    return {
      type: 'PUBLIC_EVENT' as const, category: 'EVENT' as const, severity: 'INFO',
      title: { fi: String(raw?.name ?? 'Tapahtuma') },
      description: raw?.description ? { fi: String(raw.description) } : undefined,
      attribution: { name: 'Visit Tampere', required: true },
      areaCodes: ['TAMPERE'],
      location: { municipality: 'Tampere', latitude: lat ?? null, longitude: lon ?? null },
      validity: { startsAt: raw?.startDate ? String(raw.startDate) : null, endsAt: raw?.endDate ? String(raw.endDate) : null },
    };
  }
  return {
    type: 'OTHER' as const, category: 'EVENT' as const, severity: 'INFO',
    title: { fi: String(raw?.name ?? String(raw?.title ?? 'Tapahtuma')) },
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
        logger.info('Normalisoitu', { source: parsedEvent.source, type: m.type });
      } catch (e) { failIds.push(messageId); }
    }
  }
  return { batchItemFailures: [...new Set(failIds)].map((id) => ({ itemIdentifier: id })) };
}
