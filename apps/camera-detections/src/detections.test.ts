import { describe, expect, it } from 'vitest';

import {
  buildCameraRef,
  buildDetectionItem,
  dedupeById,
  detectionLabels,
  indexCameras,
  isRelevantDetection,
  sortByCapturedDesc,
} from './detections';
import type { AnalyzerCamera, AnalyzerDetectionDetail, AnalyzerDetectionSummary } from './types';

function summary(overrides: Partial<AnalyzerDetectionSummary> = {}): AnalyzerDetectionSummary {
  return {
    cameraId: 'C04546:C0454601',
    capturedAtEpoch: 1791705564,
    capturedAt: '2026-10-11T07:59:24.000Z',
    hasPerson: true,
    hasWildlife: false,
    detectionCount: 1,
    detectedClasses: ['person'],
    processingStatus: 'SUCCESS',
    rawImageKey: 'C04546/C0454601/2026-10-11T07-59-24-000Z/raw.jpg',
    ...overrides,
  };
}

const CAMERAS: AnalyzerCamera[] = [
  {
    cameraId: 'C04546:C0454601',
    name: 'Tie 12 Tampere, Hyhky - Lahteen',
    municipality: 'Tampere',
    latitude: 61.508008,
    longitude: 23.687886,
  },
];

describe('isRelevantDetection', () => {
  it('hyväksyy ihmisen tai eläimen', () => {
    expect(isRelevantDetection(summary())).toBe(true);
    expect(isRelevantDetection(summary({ hasPerson: false, hasWildlife: true }))).toBe(true);
  });

  it('hylkää rivin, jossa ei ole kumpaakaan (hasDetection = "löysi jotain")', () => {
    expect(isRelevantDetection(summary({ hasPerson: false, hasWildlife: false }))).toBe(false);
  });
});

describe('kameran liitos', () => {
  it('liittää nimen, kunnan ja sijainnin', () => {
    const ref = buildCameraRef('C04546:C0454601', indexCameras(CAMERAS));
    expect(ref).toEqual({
      cameraId: 'C04546:C0454601',
      name: 'Tie 12 Tampere, Hyhky - Lahteen',
      municipality: 'Tampere',
      latitude: 61.508008,
      longitude: 23.687886,
    });
  });

  it('jättää kentät nulliksi, jos kameraa ei löytynyt (ei arvausta, §20)', () => {
    const ref = buildCameraRef('C99999:C9999901', indexCameras(CAMERAS));
    expect(ref).toEqual({
      cameraId: 'C99999:C9999901',
      name: null,
      municipality: null,
      latitude: null,
      longitude: null,
    });
  });
});

describe('buildDetectionItem', () => {
  it('kokoaa kortin ja muotoilee analyysiajan ISO-muotoon', () => {
    const detail: AnalyzerDetectionDetail = {
      ...summary(),
      processedAtEpoch: 1791705677,
      detections: [{ label: 'person', score: 0.337, bbox: [755, 545, 800, 645] }],
    };
    const item = buildDetectionItem({
      summary: summary(),
      detail,
      cameraIndex: indexCameras(CAMERAS),
    });

    expect(item.id).toBe('C04546:C0454601:1791705564');
    expect(item.processedAt).toBe(new Date(1791705677 * 1000).toISOString());
    expect(item.detections).toHaveLength(1);
    expect(item.imageUrl).toBeNull();
    expect(item.imageKey).toBe('C04546/C0454601/2026-10-11T07-59-24-000Z/raw.jpg');
  });

  it('erottaa "ei haettu" (null) tyhjästä havaintolistasta', () => {
    const withoutDetail = buildDetectionItem({
      summary: summary(),
      detail: null,
      cameraIndex: new Map(),
    });
    expect(withoutDetail.detections).toBeNull();
    expect(withoutDetail.processedAt).toBeNull();

    const emptyDetail = buildDetectionItem({
      summary: summary(),
      detail: { ...summary(), processedAtEpoch: null, detections: [] },
      cameraIndex: new Map(),
    });
    expect(emptyDetail.detections).toEqual([]);
  });
});

describe('järjestys ja päällekkäisyydet', () => {
  it('järjestää uusimmasta vanhimpaan kuvausajan mukaan', () => {
    const items = [summary({ capturedAtEpoch: 100 }), summary({ capturedAtEpoch: 300 })].map(
      (entry) => buildDetectionItem({ summary: entry, detail: null, cameraIndex: new Map() }),
    );
    expect(sortByCapturedDesc(items).map((item) => item.capturedAtEpoch)).toEqual([300, 100]);
  });

  it('poistaa saman havainnon toistot', () => {
    const one = buildDetectionItem({ summary: summary(), detail: null, cameraIndex: new Map() });
    const two = buildDetectionItem({
      summary: summary({ capturedAtEpoch: 1 }),
      detail: null,
      cameraIndex: new Map(),
    });
    expect(dedupeById([one, one, two])).toHaveLength(2);
  });
});

describe('detectionLabels', () => {
  it('palauttaa luokat ilman toistoja ja käsittelee nullin', () => {
    expect(
      detectionLabels([
        { label: 'person', score: 0.9, bbox: null },
        { label: 'person', score: 0.4, bbox: null },
        { label: 'animal', score: 0.3, bbox: null },
      ]),
    ).toEqual(['person', 'animal']);
    expect(detectionLabels(null)).toEqual([]);
  });
});
