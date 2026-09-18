/**
 * situation-processor — EventBridge-käynnistetty prosessori (arkkitehtuuri §3–4).
 *
 * Kuluttaa SourceEventNormalized-domain-eventit ja tekee:
 * 1. validointi (isTampere360Event)
 * 2. aluesuodatus (Tampere/Pirkanmaa, §5)
 * 3. tekninen idempotenssi (attribute_not_exists(processingKey), §4.1)
 * 4. kanonisen Situation-kirjoitus DynamoDB:hen (§4.2)
 * 5. (myöhemmin) Situation* domain-eventin julkaisu muille prosessoreille
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, PutCommandInput } from '@aws-sdk/lib-dynamodb';
import { createLogger } from '@tampere360/observability';
import { ulid } from '@tampere360/source-adapter-sdk';
import { isTampere360Event } from '@tampere360/event-contracts';
import type { EventBridgeEvent } from 'aws-lambda';
import type { SourceEventNormalizedDetail, Tampere360Event } from '@tampere360/event-contracts';

const logger = createLogger({
  service: 'situation-processor',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);

export async function handler(event: EventBridgeEvent<string, unknown>): Promise<void> {
  const detail = event.detail as SourceEventNormalizedDetail | undefined;
  if (!detail?.event) return;

  const e: Tampere360Event = detail.event;

  if (!isTampere360Event(e)) {
    logger.warn('Validaatio hylkäsi', { processingKey: e.processingKey });
    return;
  }

  const areaCodes = e.location?.areaCodes ?? [];
  if (!areaCodes.includes('TAMPERE') && !areaCodes.includes('PIRKANMAA') && !areaCodes.includes('TAMPERE_REGION')) {
    logger.debug('Ohitettu — ei Tampere-aluetta', { processingKey: e.processingKey });
    return;
  }

  const tables = {
    sourceEvents: process.env['SOURCE_EVENTS_TABLE_NAME'] ?? '',
    situations: process.env['SITUATIONS_TABLE_NAME'] ?? '',
  };
  const now = new Date().toISOString();

  // Idempotentti SourceEvents-kirjoitus
  try {
    await doc.send(new PutCommand({
      TableName: tables.sourceEvents,
      Item: {
        processingKey: e.processingKey,
        source: e.source.system,
        sourceId: e.source.sourceId,
        event: e,
        publishedAt: e.publishedAt,
        receivedAt: now,
        expiresAt: Math.floor(Date.now() / 1000) + 90 * 86400,
      },
      ConditionExpression: 'attribute_not_exists(processingKey)',
    }));
  } catch (err: unknown) {
    const aerr = err as { name?: string };
    if (aerr.name === 'ConditionalCheckFailedException') {
      logger.debug('Jo käsitelty', { processingKey: e.processingKey });
      return;
    }
    logger.error('SourceEvents-virhe', { error: String(err) });
    return;
  }

  // Kanoninen Situation
  const situationId = ulid();
  const startsAt = e.validity?.startsAt ?? e.publishedAt;

  try {
    await doc.send(new PutCommand({
      TableName: tables.situations,
      Item: {
        situationId,
        processingKey: e.processingKey,
        canonicalKey: e.canonicalKey,
        event: e,
        status: e.status,
        category: e.category,
        severity: e.severity,
        startsAt,
        municipality: e.location?.municipality ?? null,
        geohash: e.location?.geohash ?? null,
        expiresAt: (e.status === 'ENDED' || e.status === 'CANCELLED')
          ? Math.floor(Date.now() / 1000) + 30 * 86400
          : undefined,
        createdAt: now,
        updatedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(situationId)',
    }));
    logger.info('Situation luotu', {
      situationId, canonicalKey: e.canonicalKey, category: e.category, status: e.status,
    });
  } catch (err: unknown) {
    const aerr = err as { name?: string };
    if (aerr.name !== 'ConditionalCheckFailedException') {
      logger.error('Situation-virhe', { error: String(err) });
    }
  }
}
