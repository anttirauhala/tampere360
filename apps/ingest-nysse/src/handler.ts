/**
 * ingest-nysse — Nysse-joukkoliikenteen häiriötiedotteiden lähdeadapteri.
 *
 * TODO (Vaihe 3 — arkkitehtuuri §18): GTFS-RT Alerts / SIRI GM -URL:t
 * selvitettävä (Nysse-dokumentaatio ei auennut validoinnissa 6.9.2026).
 * Alert-syötteen enimmäishakutiheys dokumentoitu 60 s.
 */

import { createLogger } from '@tampere360/observability';

const logger = createLogger({
  service: 'ingest-nysse',
  source: 'NYSSE_ALERTS',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(): Promise<{ status: string }> {
  logger.info('ingest-nysse kutsuttu — toteutus tulossa Vaiheessa 3');
  return { status: 'NOT_IMPLEMENTED' };
}
