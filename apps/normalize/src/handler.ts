/**
 * normalize — normalisointi-Lambda (arkkitehtuuri §2–3).
 *
 * SQS ingestion queue -> normalisointi -> Tampere247Event ->
 * SourceEventNormalized-domain-eventti EventBridge custom busille.
 *
 * TODO (Vaihe 2): lue ParsedSourceEvent SQS-viestistä, muunna
 * Tampere247Event-malliin, laske contentHash/canonicalKey, julkaise
 * EventBridgeen (@tampere247/event-contracts DomainEventType.SourceEventNormalized).
 * Käytä reportBatchItemFailures-tukea osittaisiin epäonnistumisiin.
 */

import { createLogger } from '@tampere247/observability';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

const logger = createLogger({
  service: 'normalize',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  logger.info('normalize kutsuttu — toteutus tulossa Vaiheessa 2', {
    recordCount: event.Records.length,
  });
  return { batchItemFailures: [] };
}
