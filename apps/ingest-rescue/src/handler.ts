/**
 * ingest-rescue — pelastustoimen vaihdettava lähdeadapteri (arkkitehtuuri §10).
 *
 * Peto-media lopetti automaattiset ensitiedotteet 1.9.2026. Uusi
 * valtakunnallinen pelastustoimen mediapalvelu julkaistaan syksyllä 2026.
 * Tämä adapteri on kokeellinen stub — disabloitu Parameter Storessa
 * (/tampere360/{env}/sources/rescue/enabled = false), kunnes lähde
 * julkaistaan. Vaihto (PetoAdapter → RescueMediaAdapter) ei vaadi muutoksia
 * normalisointiin tai UI:hin — molemmat näkevät tyypin RESCUE_INCIDENT.
 */

import { createLogger } from '@tampere360/observability';

const logger = createLogger({
  service: 'ingest-rescue',
  source: 'RESCUE_MEDIA',
  environment: process.env['ENVIRONMENT'],
});

export async function handler(): Promise<{ status: string }> {
  logger.info('ingest-rescue kutsuttu — lähde disabloitu, ei toteutusta vielä');
  return { status: 'DISABLED' };
}
