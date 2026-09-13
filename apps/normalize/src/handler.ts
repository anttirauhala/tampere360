/**
 * normalize — normalisointi-Lambda (arkkitehtuuri §2–3).
 *
 * SQS-ingestion-jono -> IngestMessage -> Tampere247Event ->
 * SourceEventNormalized EventBridge custom busille.
 * Raportoi osittaiset epäonnistumiset batchItemFailures-kentällä.
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

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failIds: string[] = [];

  for (const record of event.Records) {
    const messageId = record.messageId;
    let ingestMessage: IngestMessage;

    try {
      ingestMessage = JSON.parse(record.body) as IngestMessage;
    } catch {
      failIds.push(messageId);
      continue;
    }

    if (!ingestMessage.events?.length) continue;

    for (const parsedEvent of ingestMessage.events) {
      try {
        const raw = parsedEvent.raw as Record<string, unknown> | undefined;
        const contentHash = sha256Hex(JSON.stringify(raw ?? {}));
        const now = new Date().toISOString();
        const eventId = ulid();

        const normalized: Tampere247Event = {
          schemaVersion: '1.0',
          id: eventId,
          canonicalKey: `${parsedEvent.source}:${parsedEvent.sourceId}`,
          processingKey: parsedEvent.processingKey,
          source: {
            system: parsedEvent.source,
            sourceId: parsedEvent.sourceId,
            fetchedAt: ingestMessage.batch.fetchedAt,
          },
          type: 'WEATHER_WARNING',
          category: 'WEATHER',
          severity: 'MAJOR',
          status: 'ACTIVE',
          lifecycle: 'ACTIVE',
          title: { fi: String(raw?.event ?? 'Säävaroitus') },
          description: raw?.description ? { fi: String(raw.description) } : undefined,
          location: {
            municipality: null, district: null, address: null,
            latitude: null, longitude: null, geometry: null,
            areaCodes: [],
          },
          validity: { startsAt: null, endsAt: null },
          publishedAt: now,
          updatedAt: now,
          tags: [],
          attribution: { name: 'Ilmatieteen laitos', required: true },
          contentHash,
        };

        await eventbridge.send(new PutEventsCommand({
          Entries: [{
            EventBusName: process.env['EVENT_BUS_NAME'] ?? 'tampere360-dev-events',
            Source: 'tampere360',
            DetailType: 'SourceEventNormalized',
            Detail: JSON.stringify({ event: normalized, batchId: ingestMessage.batch.batchId, occurredAt: now }),
          }],
        }));
      } catch {
        failIds.push(messageId);
      }
    }
  }

  const uniqueFails = [...new Set(failIds)];
  return { batchItemFailures: uniqueFails.map((id) => ({ itemIdentifier: id })) };
}
