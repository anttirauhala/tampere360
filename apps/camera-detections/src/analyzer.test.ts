import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnalyzerError,
  buildCamerasUrl,
  buildDetectionDetailUrl,
  buildDetectionsUrl,
  buildImageUrlEndpoint,
  fetchCameras,
  fetchDetectionDetail,
  fetchDetectionHits,
  fetchImageUrl,
  normalizeCameras,
  normalizeDetail,
  normalizeSummary,
} from './analyzer';

const BASE = 'https://example.execute-api.eu-north-1.amazonaws.com/dev';

/** Fixture: oikea rivi lähdepalvelusta (11.10.2026). */
const SUMMARY_ROW = {
  cameraId: 'C04546:C0454601',
  capturedAtEpoch: 1791705564,
  capturedAt: '2026-10-11T07:59:24.000Z',
  hasWildlife: false,
  hasPerson: true,
  detectionCount: 1,
  detectedClasses: ['person'],
  processingStatus: 'SUCCESS',
  rawImageKey: 'C04546/C0454601/2026-10-11T07-59-24-000Z/raw.jpg',
  processedImageKey: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('URL-rakentajat', () => {
  it('pyytää vain osumarivit ja rajaa sivukoon upstreamin ylärajaan', () => {
    const url = buildDetectionsUrl(BASE, { limit: 12 });
    expect(url).toContain('/detections?');
    expect(url).toContain('hasDetection=true');
    expect(url).toContain('limit=12');

    // Upstream hyväksyy enintään 100 riviä.
    expect(buildDetectionsUrl(BASE, { limit: 250 })).toContain('limit=100');
  });

  it('enkoodaa sivutusmerkin (base64 sisältää +, / ja =)', () => {
    const url = buildDetectionsUrl(BASE, { limit: 5, cursor: 'a+b/c=' });
    expect(url).toContain('nextToken=a%2Bb%2Fc%3D');
  });

  it('jättää kameratunnisteen raakana detaljipolkuun (%3A → 404 upstreamissa)', () => {
    const url = buildDetectionDetailUrl(BASE, 'C04546:C0454601', 1791705564);
    expect(url).toBe(`${BASE}/detections/C04546:C0454601/1791705564`);
    expect(url).not.toContain('%3A');
  });

  it('rakentaa kamera- ja kuvaosoitteet', () => {
    expect(buildCamerasUrl(BASE)).toBe(`${BASE}/cameras`);
    // Kuva-avain sisältää vinoviivoja → ne enkoodataan kyselyparametriin.
    expect(buildImageUrlEndpoint(BASE, 'raw', 'C04546/C0454601/raw.jpg')).toBe(
      `${BASE}/images?bucket=raw&key=C04546%2FC0454601%2Fraw.jpg`,
    );
  });
});

describe('normalizeSummary', () => {
  it('normalisoi oikean rivin', () => {
    const summary = normalizeSummary(SUMMARY_ROW);
    expect(summary).toMatchObject({
      cameraId: 'C04546:C0454601',
      capturedAtEpoch: 1791705564,
      hasPerson: true,
      hasWildlife: false,
      detectionCount: 1,
      detectedClasses: ['person'],
      rawImageKey: 'C04546/C0454601/2026-10-11T07-59-24-000Z/raw.jpg',
    });
  });

  it('pudottaa rivin ilman tunnistetta, kuvausaikaa tai kuva-avainta', () => {
    expect(normalizeSummary({ ...SUMMARY_ROW, cameraId: 'C04546/../x' })).toBeNull();
    expect(normalizeSummary({ ...SUMMARY_ROW, capturedAtEpoch: undefined })).toBeNull();
    expect(normalizeSummary({ ...SUMMARY_ROW, rawImageKey: '' })).toBeNull();
    expect(normalizeSummary(null)).toBeNull();
  });

  it('tulkitsee myös merkkijonomuotoiset totuusarvot ja siivoaa luvut', () => {
    const summary = normalizeSummary({
      ...SUMMARY_ROW,
      hasPerson: 'true',
      detectionCount: -3,
    });
    expect(summary?.hasPerson).toBe(true);
    // Negatiivinen määrä ei ole mielekäs → 0, ei koskaan arvaus (§20).
    expect(summary?.detectionCount).toBe(0);
  });
});

describe('normalizeDetail', () => {
  it('poimii bounding boxit ja confidencet', () => {
    const detections = normalizeDetail({
      detection: {
        replicateOutput: {
          detections: [{ bbox: [755.06, 545.46, 800.55, 644.96], label: 'person', score: 0.337 }],
        },
      },
    });
    expect(detections).toEqual([
      { label: 'person', score: 0.337, bbox: [755.06, 545.46, 800.55, 644.96] },
    ]);
  });

  it('palauttaa tyhjän listan, kun havaintoja ei ole tai muoto on vieras', () => {
    expect(normalizeDetail({ detection: { replicateOutput: { detections: [] } } })).toEqual([]);
    expect(normalizeDetail({ detection: { replicateOutput: null } })).toEqual([]);
    expect(normalizeDetail({})).toEqual([]);
  });

  it('jättää bboxin nulliksi, jos koordinaatit eivät ole numeroita', () => {
    const detections = normalizeDetail({
      detection: {
        replicateOutput: { detections: [{ bbox: [1, 'x', 3, 4], label: 'animal', score: '0.5' }] },
      },
    });
    expect(detections).toEqual([{ label: 'animal', score: 0.5, bbox: null }]);
  });
});

describe('normalizeCameras', () => {
  it('poimii nimen, kunnan ja sijainnin', () => {
    const cameras = normalizeCameras({
      cameras: [
        {
          cameraId: 'C04546:C0454601',
          name: 'Tie 12 Tampere, Hyhky - Lahteen',
          municipality: 'Tampere',
          lat: 61.508008,
          lon: 23.687886,
        },
        { cameraId: '', name: 'rikki' },
      ],
    });
    expect(cameras).toHaveLength(1);
    expect(cameras[0]).toMatchObject({
      cameraId: 'C04546:C0454601',
      latitude: 61.508008,
      longitude: 23.687886,
    });
    expect(normalizeCameras({})).toEqual([]);
  });
});

describe('verkkohaut', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hakee osumarivit ja kertoo, onko lisää', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [SUMMARY_ROW], count: 1, nextToken: 'tok-1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchDetectionHits(BASE, { limit: 5 }, 1000);
    expect(result.items).toHaveLength(1);
    expect(result.more).toBe(true);
    expect(result.nextToken).toBe('tok-1');
  });

  it('heittää AnalyzerErrorin 500-vastauksesta ja vierasmuotoisesta rungosta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Error"}', { status: 500 })),
    );
    await expect(fetchDetectionHits(BASE, { limit: 5 }, 1000)).rejects.toBeInstanceOf(
      AnalyzerError,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ unexpected: true })),
    );
    await expect(fetchDetectionHits(BASE, { limit: 5 }, 1000)).rejects.toBeInstanceOf(
      AnalyzerError,
    );
  });

  it('jäsentää detaljin valmistumisajan ja bboxit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          detection: {
            ...SUMMARY_ROW,
            processedAtEpoch: 1791705677,
            replicateOutput: { detections: [{ bbox: [1, 2, 3, 4], label: 'person', score: 0.9 }] },
          },
        }),
      ),
    );

    const detail = await fetchDetectionDetail(BASE, 'C04546:C0454601', 1791705564, 1000);
    expect(detail.processedAtEpoch).toBe(1791705677);
    expect(detail.detections).toHaveLength(1);
  });

  it('hakee kameraluettelon ja presigned-kuva-URLin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/cameras')) {
          return jsonResponse({
            cameras: [{ cameraId: 'C1', name: 'Nimi', municipality: 'Tampere', lat: 1, lon: 2 }],
          });
        }
        return jsonResponse({ url: 'https://s3.example/raw.jpg?sig=1', expiresIn: 3600 });
      }),
    );

    expect(await fetchCameras(BASE, 1000)).toHaveLength(1);
    expect(await fetchImageUrl(BASE, 'raw', 'a/b.jpg', 1000)).toBe(
      'https://s3.example/raw.jpg?sig=1',
    );
  });

  it('heittää virheen, jos kuvavastauksesta puuttuu url', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ expiresIn: 3600 })),
    );
    await expect(fetchImageUrl(BASE, 'raw', 'a.jpg', 1000)).rejects.toBeInstanceOf(AnalyzerError);
  });
});
