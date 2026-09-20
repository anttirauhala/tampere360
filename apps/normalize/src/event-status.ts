/**
 * Lähteen oma elinkaaritila normalisoituna.
 *
 * Tausta: normalisoija kirjoitti aiemmin aina `ACTIVE`, joten mikään tilanne ei
 * koskaan päättynyt — esimerkiksi FMI:n varoitus jäi näkyviin "aktiivisena"
 * vielä tunteja sen jälkeen, kun se oli päättynyt (dev 20.9.2026: endsAt 10:00,
 * yhä ACTIVE klo 17). Lähteiden raakadatan `status`-kenttä luetaan nyt mukaan.
 *
 * Vain ne lähteet, joiden raakadata sisältää elinkaaritilan, huomioidaan —
 * muiden `status`-kentillä voi olla eri merkitys (esim. tiejakson tila).
 */
export const SOURCES_WITH_LIFECYCLE_STATUS: ReadonlySet<string> = new Set(['FMI_CAP']);

/** Lähteen tilan sallitut arvot (muut → ACTIVE). */
export type SourceStatus = 'ACTIVE' | 'ENDED' | 'CANCELLED';

export function sourceStatus(
  source: string,
  raw: Record<string, unknown> | undefined,
): SourceStatus {
  if (!SOURCES_WITH_LIFECYCLE_STATUS.has(source)) return 'ACTIVE';
  const value = typeof raw?.['status'] === 'string' ? raw['status'].toUpperCase() : '';
  return value === 'ENDED' || value === 'CANCELLED' ? value : 'ACTIVE';
}
