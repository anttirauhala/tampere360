/**
 * ingest-tampere-traffic — Tampereen kaupungin liikennetiedote-/tietyö-
 * rajapinnan lähdeadapteri (ensisijainen liikennelähde, arkkitehtuuri §9).
 *
 * TODO (Vaihe 3): toteuta EventSourceAdapter — fetch
 * traffic-incidents.tampere.fi/api/v1 → jäsennä JSON/D2Light → S3 → SQS.
 */

import { createLogger } from '@tampere247/observability';

const logger = createLogger({
  service: 'ingest-tampere-traffic',
  source: 'TAMPERE_TRAFFIC',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(): Promise<{ status: string }> {
  logger.info('ingest-tampere-traffic kutsuttu — toteutus tulossa Vaiheessa 3');
  return { status: 'NOT_IMPLEMENTED' };
}
