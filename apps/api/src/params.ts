/**
 * API-kyselyn parametrien käsittely.
 *
 * `limit` on **kustannusparametri**: jokainen palautettu item on DynamoDB-luku
 * (1 KB item = 0,5 RRU), eli yksi pyyntö 100 itemillä maksaa ~50 RRU. Siksi
 * oletus pidetään pienenä ja yläraja rajattuna — yhdessä API Gatewayn
 * throttlen (10 req/s) ja Lambdan varatun concurrencyn kanssa tämä rajaa
 * väärinkäytön kustannusvaikutuksen (ks. infra/lib/config.ts API_THROTTLE).
 */

/** Oletusarvo, kun `limit` puuttuu tai on virheellinen. */
export const DEFAULT_LIMIT = 20;

/** Yhden pyynnön yläraja (estää jättimäiset DynamoDB-lukemat). */
export const MAX_LIMIT = 200;

/** Parsii `limit`-parametrin: 1..MAX_LIMIT; puuttuva/virheellinen → DEFAULT_LIMIT. */
export function parseLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}
