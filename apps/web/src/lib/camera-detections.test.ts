import { describe, expect, it } from 'vitest';

import type { CameraDetection } from '../api/camera-detections';
import {
  IMAGE_UNAVAILABLE_TEXT,
  bboxBoxStyle,
  bestScore,
  cameraSubtitle,
  cameraTitle,
  classifyDetection,
  detectionHeadline,
  formatBbox,
  formatScore,
  formatScoreExact,
  imageNotice,
  sortNewestFirst,
} from './camera-detections';

function detection(overrides: Partial<CameraDetection> = {}): CameraDetection {
  return {
    id: 'C04546:C0454601:1791705564',
    camera: {
      cameraId: 'C04546:C0454601',
      name: 'Tie 12 Tampere, Hyhky - Lahteen',
      municipality: 'Tampere',
      latitude: 61.508008,
      longitude: 23.687886,
    },
    capturedAt: '2026-10-11T07:59:24.000Z',
    capturedAtEpoch: 1791705564,
    processedAt: '2026-10-11T08:01:17.000Z',
    hasPerson: true,
    hasWildlife: false,
    detectionCount: 1,
    detectedClasses: ['person'],
    detections: [{ label: 'person', score: 0.337, bbox: [755.06, 545.46, 800.55, 644.96] }],
    imageUrl: 'https://s3.example/raw.jpg?sig=1',
    imageKey: 'C04546/C0454601/2026-10-11T07-59-24-000Z/raw.jpg',
    processingStatus: 'SUCCESS',
    ...overrides,
  };
}

describe('classifyDetection', () => {
  it('tunnistaa ihmisluokat ja suomentaa ne', () => {
    for (const label of ['person', 'pedestrian', 'human', 'PERSON']) {
      expect(classifyDetection(label)).toEqual({ kind: 'person', label: 'ihminen' });
    }
  });

  it('tunnistaa eläinluokat (myös lajikohtaiset) ja suomentaa ne', () => {
    for (const label of ['animal', 'deer', 'moose', 'bear', 'wild boar']) {
      expect(classifyDetection(label)).toEqual({ kind: 'animal', label: 'eläin' });
    }
  });

  it('näyttää tuntemattoman luokan sellaisenaan eikä arvaa (§20)', () => {
    expect(classifyDetection('car')).toEqual({ kind: 'other', label: 'car' });
  });
});

describe('confidencen muotoilu', () => {
  it('näyttää prosentit pyöristettynä', () => {
    expect(formatScore(0.337)).toBe('34 %');
    expect(formatScore(0.05)).toBe('5 %');
    expect(formatScore(1)).toBe('100 %');
    expect(formatScore(0)).toBe('0 %');
  });

  it('palauttaa tyhjän puuttuvasta arvosta', () => {
    expect(formatScore(null)).toBe('');
    expect(formatScore(undefined)).toBe('');
    expect(formatScore(Number.NaN)).toBe('');
  });

  it('näyttää tarkan arvon detaljilistaan suomalaisella desimaalilla', () => {
    expect(formatScoreExact(0.337)).toBe('0,34');
    expect(formatScoreExact(null)).toBe('');
  });
});

describe('formatBbox', () => {
  it('muotoilee laatikon pikseleinä', () => {
    expect(formatBbox([755.06, 545.46, 800.55, 644.96])).toBe('755, 545 – 801, 645 px');
  });

  it('palauttaa tyhjän, jos laatikkoa ei ole', () => {
    expect(formatBbox(null)).toBe('');
  });
});

describe('bboxBoxStyle', () => {
  it('skaalaa laatikon prosentteina kuvan koosta', () => {
    expect(bboxBoxStyle([100, 50, 300, 250], 1000, 500)).toEqual({
      left: '10%',
      top: '10%',
      width: '20%',
      height: '40%',
    });
  });

  it('leikkaa kuvan ulkopuolelle jäävän osan', () => {
    // 900…1200 x 400…900 kuvassa 1000 × 500 → oikea/reuna rajautuu kuvaan.
    expect(bboxBoxStyle([900, 400, 1200, 900], 1000, 500)).toEqual({
      left: '90%',
      top: '80%',
      width: '10%',
      height: '20%',
    });
  });

  it('käsittelee väärin päin annetun laatikon', () => {
    expect(bboxBoxStyle([300, 250, 100, 50], 1000, 500)).toEqual(
      bboxBoxStyle([100, 50, 300, 250], 1000, 500),
    );
  });

  it('ei piirrä mitään ilman kokoa tai kelvollisia koordinaatteja', () => {
    expect(bboxBoxStyle([1, 2, 3, 4], null, 500)).toBeNull();
    expect(bboxBoxStyle([1, 2, 3, 4], 0, 500)).toBeNull();
    expect(bboxBoxStyle(null, 1000, 500)).toBeNull();
    // Nollaleveä laatikko ei ole havainto vaan kohina.
    expect(bboxBoxStyle([100, 100, 100, 200], 1000, 500)).toBeNull();
  });
});

describe('kameran esitys', () => {
  it('käyttää nimeä tai tunnistetta otsikkona', () => {
    expect(cameraTitle(detection().camera)).toBe('Tie 12 Tampere, Hyhky - Lahteen');
    expect(cameraTitle({ ...detection().camera, name: null })).toBe('C04546:C0454601');
  });

  it('kokoaa alarivistä kunnan ja koordinaatit', () => {
    expect(cameraSubtitle(detection().camera)).toBe('Tampere · 61.50801, 23.68789');
    expect(cameraSubtitle({ ...detection().camera, municipality: null })).toBe(
      '61.50801, 23.68789',
    );
    expect(cameraSubtitle({ ...detection().camera, latitude: null, longitude: null })).toBe(
      'Tampere',
    );
    expect(
      cameraSubtitle({
        cameraId: 'C1',
        name: null,
        municipality: null,
        latitude: null,
        longitude: null,
      }),
    ).toBe('');
  });
});

describe('detectionHeadline', () => {
  it('laskee laatikkohavainnot luokittain', () => {
    expect(
      detectionHeadline(
        detection({
          detections: [
            { label: 'person', score: 0.9, bbox: null },
            { label: 'person', score: 0.4, bbox: null },
            { label: 'animal', score: 0.3, bbox: null },
          ],
        }),
      ),
    ).toBe('ihminen × 2 · eläin');
  });

  it('käyttää lähteen lippuja, kun bounding boxeja ei saatu', () => {
    expect(detectionHeadline(detection({ detections: null }))).toBe('ihminen');
    expect(
      detectionHeadline(detection({ detections: null, hasPerson: true, hasWildlife: true })),
    ).toBe('ihminen ja eläin');
    expect(
      detectionHeadline(detection({ detections: null, hasPerson: false, hasWildlife: true })),
    ).toBe('eläin');
    expect(
      detectionHeadline(detection({ detections: null, hasPerson: false, hasWildlife: false })),
    ).toBe('havainto');
  });
});

describe('bestScore', () => {
  it('palauttaa suurimman confidencen tai nullin', () => {
    expect(
      bestScore(
        detection({
          detections: [
            { label: 'person', score: 0.2, bbox: null },
            { label: 'person', score: 0.8, bbox: null },
          ],
        }),
      ),
    ).toBe(0.8);
    expect(bestScore(detection({ detections: null }))).toBeNull();
    expect(bestScore(detection({ detections: [] }))).toBeNull();
  });
});

describe('imageNotice', () => {
  it('ei huomauta mitään, kun kuva on saatavilla', () => {
    expect(imageNotice(detection())).toBeNull();
  });

  it('kertoo lyhyesti, jos kuvaa ei saatu (sama teksti kuin latausvirheessä)', () => {
    expect(imageNotice(detection({ imageUrl: null }))).toBe(IMAGE_UNAVAILABLE_TEXT);
    expect(IMAGE_UNAVAILABLE_TEXT).not.toContain('arkistoi');
  });
});

describe('sortNewestFirst', () => {
  it('järjestää uusimman ensin', () => {
    const items = [
      detection({ id: 'a', capturedAtEpoch: 100 }),
      detection({ id: 'b', capturedAtEpoch: 300 }),
      detection({ id: 'c', capturedAtEpoch: 200 }),
    ];
    expect(sortNewestFirst(items).map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });
});
