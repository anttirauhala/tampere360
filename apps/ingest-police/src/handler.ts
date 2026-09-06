/**
 * ingest-police — Sisä-Suomen poliisilaitoksen RSS-tiedotteiden lähdeadapteri.
 *
 * TODO (Vaihe 3 — arkkitehtuuri §18): tarkka RSS-URL selvitettävä
 * (poliisi.fi JS-renderöity, /rss ja /tiedotteet palauttivat 404
 * validoinnissa 6.9.2026). Tallennetaan sellaisenaan, geokoodataan.
 */

import { createLogger } from '@tampere247/observability';

const logger = createLogger({
  service: 'ingest-police',
  source: 'POLICE_RSS',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(): Promise<{ status: string }> {
  logger.info('ingest-police kutsuttu — toteutus tulossa Vaiheessa 3');
  return { status: 'NOT_IMPLEMENTED' };
}
