/**
 * Kamerahavaintojen esityslogiikka (§43).
 *
 * Nämä ovat **puhtaita funktioita** (ei verkkoa, ei Reactia), jotta
 * luokkasuomennokset, confidencen muotoilu ja bounding boxien skaalaus ovat
 * yksikkötestattavissa. Verkkohaku on `api/camera-detections.ts`:ssä.
 *
 * Kaksi periaatetta:
 *  1. **Confidence näytetään aina prosentteina.** Mallin arvio on usein matala
 *     (esimerkkihavainto 0,34), joten lukua ei saa piilottaa eikä pyöristää
 *     ylöspäin: käyttäjän pitää nähdä, kuinka varma havainto on.
 *  2. **Bounding boxit skaalataan prosentteina** kuvan luonnollisesta koosta,
 *     jolloin sama tyyli toimii kaikilla kuvako'oilla eikä JavaScriptin tarvitse
 *     tuntea renderöidyn kuvan leveyttä.
 */

import type { CameraDetection, DetectionBox, DetectionCamera } from '../api/camera-detections';

/** Havainnon laji ja suomenkielinen nimi. */
export interface DetectionClass {
  kind: 'person' | 'animal' | 'other';
  /** Näytettävä nimi ("ihminen", "eläin" tai lähdepalvelun oma luokka). */
  label: string;
}

/** Lähdepalvelun malli tunnistaa nämä luokat (README 11.10.2026). */
const PERSON_LABELS = ['person', 'pedestrian', 'human', 'people'];
const ANIMAL_LABELS = [
  'animal',
  'deer',
  'moose',
  'elk',
  'bear',
  'wolf',
  'fox',
  'wild boar',
  'reindeer',
  'hare',
  'rabbit',
];

/**
 * Teksti, kun kuvaa ei saada näkyviin (osoite puuttuu tai lataus epäonnistuu).
 * Näkymä rajoittuu 60 vuorokauteen, joten arkistointi ei ole syy — siksi
 * sanamuoto ei viittaa siihen.
 */
export const IMAGE_UNAVAILABLE_TEXT = 'Kuvaa ei saatu näkyviin.';

/** Luokan laji ja suomennos. Tuntematon luokka näytetään sellaisenaan (§20). */
export function classifyDetection(label: string): DetectionClass {
  const normalized = label.trim().toLowerCase();
  if (PERSON_LABELS.includes(normalized)) return { kind: 'person', label: 'ihminen' };
  if (ANIMAL_LABELS.includes(normalized)) return { kind: 'animal', label: 'eläin' };
  return { kind: 'other', label: label.trim() };
}

/** Confidence prosentteina, esim. `0.337` → `34 %`. Puuttuva arvo → tyhjä. */
export function formatScore(score: number | null | undefined): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '';
  return `${Math.round(score * 100)} %`;
}

/** Confidence tarkasti, esim. `0,34` — detaljilistaan. */
export function formatScoreExact(score: number | null | undefined): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '';
  return score.toFixed(2).replace('.', ',');
}

/** Bounding box luettavaksi tekstiksi, esim. `755, 545 – 801, 645 px`. */
export function formatBbox(bbox: DetectionBox['bbox']): string {
  if (!bbox) return '';
  const [x1, y1, x2, y2] = bbox;
  const round = (value: number) => Math.round(value);
  return `${round(x1)}, ${round(y1)} – ${round(x2)}, ${round(y2)} px`;
}

/** Prosenttiarvo 0…100, rajattuna — kuva ei voi vuotaa ulos kortistaan. */
function percent(value: number, total: number): string {
  const raw = (value / total) * 100;
  return `${Math.min(100, Math.max(0, raw))}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface BoxStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

/**
 * Bounding boxin sijainti prosentteina kuvan koosta.
 *
 * Koordinaatit rajataan kuvan sisään ennen prosenttilaskua, joten osittain kuvan
 * ulkopuolelle jäävä laatikko leikkautuu eikä valu kortin reunan yli.
 *
 * Palauttaa `null`, jos laatikoita ei ole tai kuvan kokoa ei vielä tiedetä
 * (`naturalWidth`/`naturalHeight` tulevat `<img onLoad>`ista). Silloin
 * laatikoita ei piirretä — vääriä koordinaatteja ei koskaan arvata.
 */
export function bboxBoxStyle(
  bbox: DetectionBox['bbox'],
  naturalWidth: number | null,
  naturalHeight: number | null,
): BoxStyle | null {
  if (!bbox) return null;
  if (!naturalWidth || !naturalHeight) return null;
  if (naturalWidth <= 0 || naturalHeight <= 0) return null;

  const [x1, y1, x2, y2] = bbox;
  const left = clamp(Math.min(x1, x2), 0, naturalWidth);
  const top = clamp(Math.min(y1, y2), 0, naturalHeight);
  const right = clamp(Math.max(x1, x2), 0, naturalWidth);
  const bottom = clamp(Math.max(y1, y2), 0, naturalHeight);

  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;

  return {
    left: percent(left, naturalWidth),
    top: percent(top, naturalHeight),
    width: percent(width, naturalWidth),
    height: percent(height, naturalHeight),
  };
}

/** Kameran otsikko: lähdepalvelun nimi tai tunniste, jos nimeä ei ole. */
export function cameraTitle(camera: DetectionCamera): string {
  return camera.name ?? camera.cameraId;
}

/** Kameran alarivi: kunta ja koordinaatit, jos ne tiedetään. */
export function cameraSubtitle(camera: DetectionCamera): string {
  const parts: string[] = [];
  if (camera.municipality) parts.push(camera.municipality);
  if (camera.latitude !== null && camera.longitude !== null) {
    parts.push(`${camera.latitude.toFixed(5)}, ${camera.longitude.toFixed(5)}`);
  }
  return parts.join(' · ');
}

/**
 * Havainnon otsikkorivi: mitä kuvassa havaittiin.
 *
 * Jos bounding boxeja ei saatu, käytetään lähdepalvelun omia lippuja
 * (`hasPerson`/`hasWildlife`) — ne ovat yhtä lailla lähteen tietoa, eivät
 * arvaus.
 */
export function detectionHeadline(item: CameraDetection): string {
  const detections = item.detections ?? [];
  if (detections.length === 0) {
    if (item.hasPerson && item.hasWildlife) return 'ihminen ja eläin';
    if (item.hasPerson) return 'ihminen';
    if (item.hasWildlife) return 'eläin';
    return 'havainto';
  }

  const counted = new Map<string, number>();
  for (const detection of detections) {
    const { label } = classifyDetection(detection.label);
    if (!label) continue;
    counted.set(label, (counted.get(label) ?? 0) + 1);
  }

  return [...counted.entries()]
    .map(([label, count]) => (count > 1 ? `${label} × ${count}` : label))
    .join(' · ');
}

/** Vahvin confidence havainnon laatikoista — tai `null`, jos niitä ei ole. */
export function bestScore(item: CameraDetection): number | null {
  const detections = item.detections ?? [];
  let best: number | null = null;
  for (const detection of detections) {
    if (!Number.isFinite(detection.score)) continue;
    if (best === null || detection.score > best) best = detection.score;
  }
  return best;
}

/**
 * Kuvahuomautus: `null`, jos kuva on käytettävissä, muuten teksti, joka
 * kerrotaan käyttäjälle. Sama teksti käytetään myös silloin, kun kuvan lataus
 * epäonnistuu selaimessa.
 */
export function imageNotice(item: CameraDetection): string | null {
  if (item.imageUrl) return null;
  return IMAGE_UNAVAILABLE_TEXT;
}

/** Uusin ensin (puolustava järjestys, vaikka API järjestää jo). */
export function sortNewestFirst(items: readonly CameraDetection[]): CameraDetection[] {
  return [...items].sort((a, b) => b.capturedAtEpoch - a.capturedAtEpoch);
}
