/**
 * Ajoneuvojen esityslogiikka: otsikot, viivetekstit ja iän muotoilu.
 *
 * Puhtaita funktioita (ei verkkoa eikä Reactia), jotta ne ovat
 * yksikkötestattavissa ilman selainta (§27).
 */

import type { VehicleMode, VehicleProperties } from '../api/types';

/** Muodon nimi yksikössä (popupissa). */
export const MODE_LABELS: Record<VehicleMode, string> = {
  TRAM: 'Ratikka',
  BUS: 'Bussi',
};

/** Muodon nimi monikossa (suodatinpainikkeet). */
export const MODE_LABELS_PLURAL: Record<VehicleMode, string> = {
  TRAM: 'Ratikat',
  BUS: 'Bussit',
};

/**
 * Määrällinen muoto määrän yhteyteen: "19 ratikkaa", "158 bussia".
 * (Suomessa luvun jälkeen ei käytetä perusmuotoa — siksi oma taulukko.)
 */
export const MODE_LABELS_PARTITIVE: Record<VehicleMode, string> = {
  TRAM: 'ratikkaa',
  BUS: 'bussia',
};

/** Popupin otsikko: "Ratikka 1 → Hervantajärvi A". */
export function vehicleTitle(
  vehicle: Pick<VehicleProperties, 'mode' | 'line' | 'destination'>,
): string {
  const head = `${MODE_LABELS[vehicle.mode]} ${vehicle.line}`;
  return vehicle.destination ? `${head} → ${vehicle.destination}` : head;
}

/**
 * Poikkeama aikataulusta luettavana tekstinä.
 *
 * Lähde antaa keston ISO 8601 -muodossa, ja Lambda muuntaa sen sekunneiksi.
 * Alle minuutin heittoa ei näytetä lukuna, koska se ei ole käyttäjälle
 * merkityksellinen (ja aikatauluissa on muutenkin minuutin tarkkuus).
 */
export function delayLabel(delaySeconds: number | null | undefined): string {
  const minutes = delayMinutes(delaySeconds);
  switch (delayTone(delaySeconds)) {
    case 'unknown':
      return 'aikataulusta ei tietoa';
    case 'ontime':
      return 'ajassa';
    case 'late':
      return `${minutes} min myöhässä`;
    default:
      return `${minutes} min etuajassa`;
  }
}

/**
 * Viiveen sävy popupin tyylittelyä varten.
 *
 * Sama kynnys kuin `delayLabel`illa (alle minuutin heitto on "ajassa"), jotta
 * teksti ja väri eivät voi kertoa eri asiaa.
 */
export type DelayTone = 'ontime' | 'late' | 'early' | 'unknown';

export function delayTone(delaySeconds: number | null | undefined): DelayTone {
  const minutes = delayMinutes(delaySeconds);
  if (minutes === null) return 'unknown';
  if (minutes === 0) return 'ontime';
  return (delaySeconds ?? 0) > 0 ? 'late' : 'early';
}

/** Viive pyöristettynä minuutteina; `null`, jos viivettä ei tiedetä. */
function delayMinutes(delaySeconds: number | null | undefined): number | null {
  if (delaySeconds === null || delaySeconds === undefined || !Number.isFinite(delaySeconds)) {
    return null;
  }
  return Math.round(Math.abs(delaySeconds) / 60);
}

/**
 * Havainnon ikä lyhyenä tekstinä: "juuri nyt", "12 s sitten", "3 min sitten".
 * Antaa `null`, jos aikaa ei ole — silloin UI ei näytä ikää lainkaan (§20).
 */
export function formatVehicleAge(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;

  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'juuri nyt';
  if (seconds < 60) return `${seconds} s sitten`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min sitten`;
  return `${Math.round(minutes / 60)} h sitten`;
}

/** Kartan selosteteksti: "19 ratikkaa · päivitetty 3 s sitten". */
export function vehicleSummary(
  mode: VehicleMode,
  count: number,
  updatedAt: string | null | undefined,
  now: number = Date.now(),
): string {
  const label = MODE_LABELS_PARTITIVE[mode];
  const age = formatVehicleAge(updatedAt, now);
  return age ? `${count} ${label} · päivitetty ${age}` : `${count} ${label}`;
}
