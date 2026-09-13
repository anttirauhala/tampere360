/**
 * situation-processor — EventBridge-käynnistetty prosessori (arkkitehtuuri §3).
 *
 * Kuluttaa SourceEventNormalized-domain-eventit ja tekee: validoinnin,
 * aluesuodatuksen (Tampere/seutu/Pirkanmaa), teknisen idempotenssin
 * (attribute_not_exists(processingKey)), semanttisen yhdistämisen
 * kanoniseksi Situationiksi ja DynamoDB-kirjoitukset. Uudet prosessorit
 * (ilmoitukset, tilastot) liitetään myöhemmin uusina EventBridge-sääntöinä
 * ilman muutoksia tähän.
 *
 * TODO (Vaihe 2): toteuta validointi (@tampere360/event-contracts
 * validateTampere360Event), Pirkanmaa-aluesuodatus, ehdollinen
 * DynamoDB-kirjoitus SourceEvents-tauluun ja Situations-yhdistäminen.
 */

import { createLogger } from '@tampere360/observability';
import type { EventBridgeEvent } from 'aws-lambda';

const logger = createLogger({
  service: 'situation-processor',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(event: EventBridgeEvent<string, unknown>): Promise<void> {
  logger.info('situation-processor kutsuttu — toteutus tulossa Vaiheessa 2', {
    detailType: event['detail-type'],
  });
}
