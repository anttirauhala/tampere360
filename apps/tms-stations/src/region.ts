/**
 * Aluesuodatus ja nimeäminen (arkkitehtuuri §30).
 *
 * **Miksi rajaus tehdään koordinaateilla eikä kunnalla:** asemaluettelon
 * simplified-muodossa ei ole `municipality`-kenttää, ja yksityiskohtaiset
 * metatiedot haetaan vain rajauksen läpäisseille asemille (yksi pyyntö per
 * asema). Koordinaattirajaus pitää siis pyyntömäärän pienenä.
 *
 * Rajaus on **Tampereen seutu** — laajempi kuin kaupunkialue (mukana myös
 * Nokia, Pirkkala, Ylöjärvi, Kangasala ja Lempäälä), mutta suppeampi kuin
 * Pirkanmaa. Mitattu 27.9.2026: rajaus osuu 21 asemaan, joista 19 on keruussa.
 */

export const REGION_BOUNDS = {
  minLatitude: 61.3,
  maxLatitude: 61.7,
  minLongitude: 23.5,
  maxLongitude: 24.0,
} as const;

/** Onko piste Tampereen seudun rajauksen sisällä? */
export function inTampereRegion(latitude: unknown, longitude: unknown): boolean {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return (
    latitude >= REGION_BOUNDS.minLatitude &&
    latitude <= REGION_BOUNDS.maxLatitude &&
    longitude >= REGION_BOUNDS.minLongitude &&
    longitude <= REGION_BOUNDS.maxLongitude
  );
}

/**
 * Tienumero teknisestä nimestä, esim. `vt12_Tre_Paasikiventie` → `vt12`.
 *
 * Digitrafficin TMS-nimet alkavat aina tienumerolla ja alaviivalla
 * (`vt3_…`, `kt65_…`, `yt3495_…`). Jos muoto poikkeaa, palautetaan `null`
 * eikä arvata — sama periaate kuin aikaleimoissa (§20).
 */
export function roadFromName(name: string | null | undefined): string | null {
  const value = (name ?? '').trim();
  const match = /^([a-z]{2}\d{1,4})_/i.exec(value);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Käyttäjälle näytettävä otsikko: `names.fi` (esim. "Tie 12 Tampere
 * Uittotunneli"), muuten ruotsi/englanti, muuten tekninen nimi.
 */
export function stationTitle(
  names: Record<string, string> | null | undefined,
  fallback: string,
): string {
  const preferred = ['fi', 'sv', 'en'];
  for (const language of preferred) {
    const value = names?.[language];
    if (value && value.trim()) return value.trim();
  }
  return fallback;
}
