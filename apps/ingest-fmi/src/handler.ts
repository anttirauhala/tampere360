/**
 * ingest-fmi — Ilmatieteen laitoksen CAP-säävaroitusten lähdeadapteri.
 *
 * EventBridge Scheduler kutsuu tämän Lambdan ~5 min välein (ks. infra/lib/config.ts).
 *
 * TODO (Vaihe 2 — arkkitehtuuri §9, §16):
 *   toteuta EventSourceAdapter (source-adapter-sdk): fetch RSS-syöte
 *   (alerts.fmi.fi/cap/feed/rss_fi-FI.rss) → jäsennä CAP XML → suodata
 *   Pirkanmaa/Tampere → tallenna raakadata S3:een → lähetä SQS
 *   ingestion-jonoon.
 */

import { createLogger } from '@tampere247/observability';

const logger = createLogger({
  service: 'ingest-fmi',
  source: 'FMI_CAP',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(): Promise<{ status: string }> {
  logger.info('ingest-fmi kutsuttu — toteutus tulossa Vaiheessa 2');
  return { status: 'NOT_IMPLEMENTED' };
}
