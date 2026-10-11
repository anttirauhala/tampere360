/**
 * Havaintolistan kokoaminen (arkkitehtuuri §43).
 *
 * Nämä ovat **puhtaita funktioita** (ei verkkoa eikä kelloa), jotta
 * suodatus-, liitos- ja järjestyslogiikka on yksikkötestattavissa ilman
 * selainta tai Lambdaa. Verkkohaut ovat `analyzer.ts`:ssä.
 *
 * Kaksi periaatetta:
 *  1. **Vain ihmiset ja eläimet näytetään.** Upstreamin `hasDetection=true`
 *     tarkoittaa "löysi jotain", joten rivi hyväksytään vasta kun se on itse
 *     todettu (`hasPerson` tai `hasWildlife`).
 *  2. **Järjestys on kuvausajan mukaan**, ei analyysiajan: käyttäjälle
 *     oleellista on milloin kuva otettiin.
 */

import type {
  AnalyzerBoxDetection,
  AnalyzerCamera,
  AnalyzerDetectionDetail,
  AnalyzerDetectionSummary,
  CameraDetectionItem,
  CameraRef,
} from './types';

/** Onko rivi käyttäjälle näytettävä havainto (ihminen tai eläin). */
export function isRelevantDetection(summary: AnalyzerDetectionSummary): boolean {
  return summary.hasPerson || summary.hasWildlife;
}

/** Kameratunniste → kamera -kartta (listassa ei ole nimeä eikä sijaintia). */
export function indexCameras(cameras: readonly AnalyzerCamera[]): Map<string, AnalyzerCamera> {
  const index = new Map<string, AnalyzerCamera>();
  for (const camera of cameras) {
    if (!index.has(camera.cameraId)) index.set(camera.cameraId, camera);
  }
  return index;
}

/**
 * Kamera havaintokortille. Jos kameraa ei löytynyt listasta, vain tunniste
 * tiedetään — muut kentät ovat `null` (ei arvausta, §20).
 */
export function buildCameraRef(
  cameraId: string,
  index: ReadonlyMap<string, AnalyzerCamera>,
): CameraRef {
  const camera = index.get(cameraId);
  return {
    cameraId,
    name: camera?.name ?? null,
    municipality: camera?.municipality ?? null,
    latitude: camera?.latitude ?? null,
    longitude: camera?.longitude ?? null,
  };
}

/**
 * Kokoaa yhden havaintokortin.
 *
 * `detections` on `null`, jos detaljia ei haettu lainkaan — se eroaa tyhjästä
 * listasta, joka tarkoittaa "analyysi ei löytänyt mitään" (vaikka rivi
 * suodatettiin `hasPerson`/`hasWildlife`-lippujen perusteella).
 */
export function buildDetectionItem(input: {
  summary: AnalyzerDetectionSummary;
  detail: AnalyzerDetectionDetail | null;
  cameraIndex: ReadonlyMap<string, AnalyzerCamera>;
}): CameraDetectionItem {
  const { summary, detail, cameraIndex } = input;
  const processedAtMs = detail?.processedAtEpoch != null ? detail.processedAtEpoch * 1000 : null;

  return {
    id: `${summary.cameraId}:${summary.capturedAtEpoch}`,
    camera: buildCameraRef(summary.cameraId, cameraIndex),
    capturedAt: summary.capturedAt,
    capturedAtEpoch: summary.capturedAtEpoch,
    processedAt: processedAtMs === null ? null : new Date(processedAtMs).toISOString(),
    hasPerson: summary.hasPerson,
    hasWildlife: summary.hasWildlife,
    detectionCount: summary.detectionCount,
    detectedClasses: summary.detectedClasses,
    detections: detail ? detail.detections : null,
    imageUrl: null,
    imageKey: summary.rawImageKey,
    processingStatus: summary.processingStatus,
  };
}

/** Järjestää havainnot uusimmasta vanhimpaan (kuvausaika). */
export function sortByCapturedDesc(items: readonly CameraDetectionItem[]): CameraDetectionItem[] {
  return [...items].sort((a, b) => b.capturedAtEpoch - a.capturedAtEpoch);
}

/**
 * Poistaa päällekkäisyydet (`cameraId` + kuvausaika).
 *
 * Sivutusmerkki voi palauttaa saman rivin uudelleen, jos lähdeaineisto muuttuu
 * kesken sivuutuksen — kortti näytetään silti vain kerran.
 */
export function dedupeById(items: readonly CameraDetectionItem[]): CameraDetectionItem[] {
  const seen = new Set<string>();
  const result: CameraDetectionItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

/** Havainnon luokkanimet detektorin järjestyksessä ilman toistoja. */
export function detectionLabels(detections: readonly AnalyzerBoxDetection[] | null): string[] {
  if (!detections) return [];
  const labels: string[] = [];
  for (const detection of detections) {
    if (!labels.includes(detection.label)) labels.push(detection.label);
  }
  return labels;
}
