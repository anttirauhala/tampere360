/**
 * Sujuvuusarvio: nopeus suhteessa vapaan ajon nopeuteen (arkkitehtuuri §30).
 *
 * Digitraffic antaa asemakohtaisen **vapaan ajon nopeuden**
 * (`freeFlowSpeed1/2`, sama arvo kuin `VVAPAAS1/2`-anturivakiot), joten
 * sujuvuutta ei tarvitse arvata nopeusrajoituksesta: suhde
 * `nopeus / vapaa nopeus` on 1, kun liikenne virtaa esteettä.
 *
 * **Luokittelu on oma arviomme**, ei lähteen — siksi se kerrotaan
 * käyttöliittymässä avoimesti (sama periaate kuin tilanteiden
 * vakavuusluokittelussa, §24).
 *
 * **Matalan liikennemäärän suoja:** hiljaisena aikana yksittäinen hidas
 * auto laskee keskinopeutta, vaikka tietä ei ruuhkauta mikään. Siksi
 * sujuvuutta ei arvioida lainkaan, jos liikennemäärä on alle
 * `MIN_VOLUME_FOR_FLOW` (1 auto/min) — tulos on silloin `TUNTEMATON`,
 * ei virheellinen "ruuhka".
 */

import type { FlowLevel } from './types';

/** Suhde ≥ 0,75 → sujuvaa (nopeus vähintään 3/4 vapaasta nopeudesta). */
export const CONGESTION_LIGHT_MAX = 0.75;
/** Suhde < 0,5 → ruuhkautunut (nopeus alle puolet vapaasta nopeudesta). */
export const CONGESTION_HEAVY_MAX = 0.5;
/** Alle tämän liikennemäärän (kpl/h) sujuvuutta ei arvioida. */
export const MIN_VOLUME_FOR_FLOW = 60;

/** `speed / freeFlowSpeed`, tai `null` jos jompikumpi puuttuu tai on 0. */
export function speedRatio(speed: number | null, freeFlowSpeed: number | null): number | null {
  if (speed === null || freeFlowSpeed === null) return null;
  if (!Number.isFinite(speed) || !Number.isFinite(freeFlowSpeed)) return null;
  if (freeFlowSpeed <= 0) return null;
  return speed / freeFlowSpeed;
}

/** Sujuvuusluokka nopeuden, vapaan nopeuden ja liikennemäärän perusteella. */
export function flowLevel(
  speed: number | null,
  freeFlowSpeed: number | null,
  volume: number | null,
): FlowLevel {
  if (volume === null || volume < MIN_VOLUME_FOR_FLOW) return 'TUNTEMATON';

  const ratio = speedRatio(speed, freeFlowSpeed);
  if (ratio === null) return 'TUNTEMATON';
  if (ratio >= CONGESTION_LIGHT_MAX) return 'SUJUVAA';
  if (ratio >= CONGESTION_HEAVY_MAX) return 'HIDASTUNUT';
  return 'RUUHKAUTUNUT';
}

/** Pyöristys näyttöä varten: `1` desimaali, mutta kokonaisluvut ilman desimaalia. */
export function roundRatio(ratio: number | null): number | null {
  if (ratio === null) return null;
  return Math.round(ratio * 100) / 100;
}
