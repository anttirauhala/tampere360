/**
 * Veden lämpötilan muotoilu (§34).
 *
 * Puhtaat funktiot (ei verkkoa eikä Reactia). Puuttuva arvo → tyhjä merkkijono,
 * ei nollaa eikä arvausta (§20). Verkkohaku on `api/water.ts`:ssä.
 */

/** Lämpötila suomalaisella desimaalierottimella, esim. `11,9 °C`. */
export function formatWaterTemperature(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return `${value.toFixed(1).replace('.', ',')} °C`;
}

/**
 * Havainnon päivämäärä muodossa `30.9.2026`.
 *
 * Lähde antaa aikaleiman **ilman aikavyöhykettä** (havainto on päivittäinen,
 * esim. `2026-09-30T00:00:00`). Päivä luetaan suoraan merkkijonosta eikä
 * `new Date`illa, jotta aikavyöhykkeen tulkinta ei siirrä päivää yhdellä (§20).
 */
export function formatMeasurementDate(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  const year = match?.[1];
  const month = match?.[2];
  const day = match?.[3];
  if (!year || !month || !day) return '';
  return `${Number(day)}.${Number(month)}.${year}`;
}
