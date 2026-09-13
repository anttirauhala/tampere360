/**
 * ingest-events — Visit Tampere / Eventz -tapahtumakalenterin lähdeadapteri.
 *
 * TODO (Vaihe 3 — arkkitehtuuri §18): rajapinta selvitettävä
 * (/api/v1/event ja /api/v1/events palauttivat 404 validoinnissa 6.9.2026,
 * kalenteri oli myös hetkellisesti alhaalla).
 */

import { createLogger } from '@tampere360/observability';

const logger = createLogger({
  service: 'ingest-events',
  source: 'VISIT_TAMPERE',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(): Promise<{ status: string }> {
  logger.info('ingest-events kutsuttu — toteutus tulossa Vaiheessa 3');
  return { status: 'NOT_IMPLEMENTED' };
}
