import { describe, expect, it } from 'vitest';

import type {
  DigitrafficCameraDataResponse,
  DigitrafficCameraStationsResponse,
} from '../api/cameras';
import {
  CAMERA_RADIUS_KM,
  cameraImageTime,
  cameraImageUrl,
  cameraLabel,
  formatDistance,
  haversineKm,
  TAMPERE_CENTER,
  toTrafficCameras,
  type TrafficCamera,
} from './cameras';

/**
 * Hakee aseman tuloksesta tunnisteella.
 *
 * `tsconfig`:ssä on `noUncheckedIndexedAccess`, joten suora `cameras[0]` olisi
 * tyypiltään `TrafficCamera | undefined`. Tämä apuri pitää testit tyyppiturvassa
 * ja antaa selkeän virheen, jos asema puuttuu suodatuksesta.
 */
function cameraAt(cameras: TrafficCamera[], stationId: string): TrafficCamera {
  const found = cameras.find((camera) => camera.stationId === stationId);
  if (!found) {
    throw new Error(
      `Asema ${stationId} puuttuu tuloksesta: ${cameras.map((c) => c.stationId).join(', ')}`,
    );
  }
  return found;
}

/**
 * Fixture on kopioitu Digitrafficin asemaluettelosta (23.9.2026):
 * kolme Tampereen asemaa, yksi Nokian asema (yksi preset ei ole
 * kuvauskierrossa) ja yksi kaukainen asema (Inkoo).
 */
const RESPONSE: DigitrafficCameraStationsResponse = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'C04607',
      geometry: { type: 'Point', coordinates: [23.772567, 61.507146, 110] },
      properties: {
        id: 'C04607',
        name: 'vt12_Tre_Rantatunneli_Armonkallio',
        collectionStatus: 'GATHERING',
        dataUpdatedTime: '2026-09-23T15:26:49Z',
        presets: [{ id: 'C0460700', inCollection: true }],
      },
    },
    {
      type: 'Feature',
      id: 'C04555',
      geometry: { type: 'Point', coordinates: [23.774492, 61.477335, 0] },
      properties: {
        id: 'C04555',
        name: 'yt3495_Tampere_Rautaharkko',
        dataUpdatedTime: '2026-09-23T15:27:07Z',
        presets: [
          { id: 'C0455501', inCollection: true },
          { id: 'C0455502', inCollection: true },
          { id: 'C0455509', inCollection: true },
        ],
      },
    },
    {
      type: 'Feature',
      id: 'C04509',
      geometry: { type: 'Point', coordinates: [23.584856, 61.48815, 0] },
      properties: {
        id: 'C04509',
        name: 'vt3_Nokia_Pitkäniemi',
        dataUpdatedTime: '2026-09-23T15:28:14Z',
        presets: [
          { id: 'C0450901', inCollection: true },
          { id: 'C0450903', inCollection: false },
        ],
      },
    },
    {
      type: 'Feature',
      id: 'C01503',
      geometry: { type: 'Point', coordinates: [23.99616, 60.05374, 0] },
      properties: {
        id: 'C01503',
        name: 'kt51_Inkoo',
        dataUpdatedTime: '2026-09-23T15:25:44Z',
        presets: [{ id: 'C0150301', inCollection: true }],
      },
    },
  ],
};

/**
 * Kuvausaikarajapinnan fixture (`/stations/data`, 23.9.2026).
 *
 * Asemaluettelon `dataUpdatedTime` (15:25–15:28Z) on metatietoa ja tunteja
 * vanha, kun taas kuvien todellinen kuvausaika (`measuredTime`) on 18:46–18:47Z.
 * Tämä ero on syy siihen, miksi kuvausajat haetaan erikseen.
 *
 * C04509 (Nokia) puuttuu tarkoituksella: asemalle ei silloin näytetä aikaa.
 */
const DATA: DigitrafficCameraDataResponse = {
  dataUpdatedTime: '2026-09-23T18:51:03Z',
  stations: [
    {
      id: 'C04607',
      dataUpdatedTime: '2026-09-23T18:47:52Z',
      presets: [{ id: 'C0460700', measuredTime: '2026-09-23T18:47:05Z' }],
    },
    {
      id: 'C04555',
      dataUpdatedTime: '2026-09-23T18:46:30Z',
      presets: [
        { id: 'C0455501', measuredTime: '2026-09-23T18:46:37Z' },
        { id: 'C0455502', measuredTime: '2026-09-23T18:46:20Z' },
        // Ajat puuttuvat: silloin käytetään aseman omaa aikaa.
        { id: 'C0455509', measuredTime: null },
      ],
    },
  ],
};

describe('cameraImageUrl', () => {
  it('rakentaa kuvatiedoston osoitteen preset-tunnisteesta', () => {
    expect(cameraImageUrl('C0450701')).toBe('https://weathercam.digitraffic.fi/C0450701.jpg');
  });
});

describe('haversineKm', () => {
  it('on nolla samalle pisteelle', () => {
    expect(haversineKm(TAMPERE_CENTER, TAMPERE_CENTER)).toBe(0);
  });

  it('laskee etäisyyden tunnetuille pisteille', () => {
    // Rantatunnelin kamera ~1,2 km keskustasta (Digitrafficin koordinaatit).
    const rantatunneli = { latitude: 61.507146, longitude: 23.772567 };
    expect(haversineKm(TAMPERE_CENTER, rantatunneli)).toBeCloseTo(1.2, 1);

    // Inkoo on yli 150 km päässä.
    const inkoo = { latitude: 60.05374, longitude: 23.99616 };
    expect(haversineKm(TAMPERE_CENTER, inkoo)).toBeGreaterThan(150);
  });
});

describe('cameraLabel', () => {
  it('muuttaa alaviivat välilyönneiksi', () => {
    expect(cameraLabel('vt12_Tre_Rantatunneli_Armonkallio')).toBe(
      'vt12 Tre Rantatunneli Armonkallio',
    );
  });

  it('palauttaa tyhjän merkkijonon puuttuvasta nimestä', () => {
    expect(cameraLabel(null)).toBe('');
    expect(cameraLabel(undefined)).toBe('');
  });
});

describe('formatDistance', () => {
  it('käyttää suomalaista desimaalierotinta', () => {
    expect(formatDistance(1.234)).toBe('1,2 km');
    expect(formatDistance(0.82)).toBe('0,8 km');
  });

  it('ei pyöristä ylös säteen yli (9,96 km -> 9,9 km)', () => {
    // Jos arvo pyöristettäisiin 10,0 kilometriin, näyttäisi siltä että asema
    // olisi sääntöjen vastaisesti yli 10 km päässä.
    expect(formatDistance(CAMERA_RADIUS_KM - 0.04)).toBe('9,9 km');
  });
});

describe('toTrafficCameras', () => {
  it('ottaa vain säteen sisällä olevat asemat ja järjestää lähimmästä', () => {
    const cameras = toTrafficCameras(RESPONSE, DATA);
    expect(cameras.map((camera) => camera.stationId)).toEqual(['C04607', 'C04555', 'C04509']);
    expect(cameraAt(cameras, 'C04607').distanceKm).toBeLessThan(
      cameraAt(cameras, 'C04555').distanceKm,
    );
    expect(cameras.every((camera) => camera.distanceKm < CAMERA_RADIUS_KM)).toBe(true);
  });

  it('muotoilee nimen, päivitysajan ja kuvaosoitteet', () => {
    const first = cameraAt(toTrafficCameras(RESPONSE, DATA), 'C04607');
    expect(first.label).toBe('vt12 Tre Rantatunneli Armonkallio');
    // Päivitysaika tulee kuvausaikarajapinnasta, ei asemaluettelon metatiedosta.
    expect(first.updatedAt).toBe('2026-09-23T18:47:52Z');
    expect(first.presets).toEqual([
      {
        id: 'C0460700',
        imageUrl: 'https://weathercam.digitraffic.fi/C0460700.jpg',
        measuredTime: '2026-09-23T18:47:05Z',
      },
    ]);
  });

  it('ei käytä asemaluettelon dataUpdatedTimea kuvan aikana (regressiosuoja)', () => {
    // Asemaluettelo väittää 15:26:49Z, mutta kuvat olivat oikeasti 18:47:05Z.
    // Aiemmin listan arvo näytettiin "kuvan aikana" → aika oli 3 tuntia pielessä.
    const camera = cameraAt(toTrafficCameras(RESPONSE, DATA), 'C04607');
    expect(camera.updatedAt).not.toBe('2026-09-23T15:26:49Z');
    expect(cameraImageTime(camera, camera.presets[0]!)).toBe('2026-09-23T18:47:05Z');
  });

  it('jättää pois kamerat, jotka eivät ole kuvauskierrossa', () => {
    const nokia = cameraAt(toTrafficCameras(RESPONSE, DATA), 'C04509');
    expect(nokia.presets.map((preset) => preset.id)).toEqual(['C0450901']);
  });

  it('jättää pois aseman, jolla ei ole yhtään kuvauskierrossa olevaa kameraa', () => {
    const cameras = toTrafficCameras({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'C00001',
          geometry: { type: 'Point', coordinates: [23.761, 61.4978, 0] },
          properties: {
            id: 'C00001',
            name: 'testi',
            presets: [{ id: 'C0000101', inCollection: false }],
          },
        },
      ],
    });
    expect(cameras).toEqual([]);
  });

  it('käyttää annettua keskipistettä ja sädettä', () => {
    // Kapeampi säde pudottaa kauemmat asemat pois.
    const narrow = toTrafficCameras(RESPONSE, DATA, TAMPERE_CENTER, 2);
    expect(narrow.map((camera) => camera.stationId)).toEqual(['C04607']);

    // Säde 0 = ei yhtään asemaa (rajatapaus: etäisyys ei ole pienempi kuin 0).
    expect(toTrafficCameras(RESPONSE, DATA, TAMPERE_CENTER, 0)).toEqual([]);
  });

  it('kestää puuttuvan tai virheellisen geometrian', () => {
    const cameras = toTrafficCameras({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'A', properties: { id: 'A', presets: [{ id: 'A01' }] } },
        {
          type: 'Feature',
          id: 'B',
          geometry: { type: 'Point', coordinates: [Number.NaN, Number.NaN] },
          properties: { id: 'B', presets: [{ id: 'B01' }] },
        },
        {
          type: 'Feature',
          id: 'C',
          geometry: { type: 'Point', coordinates: [23.761, 61.4978] },
          properties: { id: 'C', name: null, presets: [{ id: 'C01' }] },
        },
      ],
    });
    expect(cameras.map((camera) => camera.stationId)).toEqual(['C']);
    // Nimen puuttuessa näytetään asematunniste.
    expect(cameraAt(cameras, 'C').label).toBe('C');
  });

  it('palauttaa tyhjän listan, jos vastaus puuttuu', () => {
    expect(toTrafficCameras(undefined)).toEqual([]);
    expect(toTrafficCameras(null)).toEqual([]);
    expect(toTrafficCameras(null, null, TAMPERE_CENTER, 0)).toEqual([]);
  });

  it('jättää ajan näyttämättä, jos kuvausaikoja ei ole (aikaa ei arvata)', () => {
    // Ilman kuvausaikavastausta aikaa ei keksitä asemaluettelosta, koska se ei
    // ole kuvan aika (§20).
    const camera = cameraAt(toTrafficCameras(RESPONSE), 'C04607');
    expect(camera.updatedAt).toBeNull();
    expect(cameraImageTime(camera, camera.presets[0]!)).toBeNull();
  });

  it('kestää puuttuvan aseman kuvausaikavastauksessa', () => {
    // C04509 puuttuu DATA-fixturesta (esim. rajapinnan katko).
    const nokia = cameraAt(toTrafficCameras(RESPONSE, DATA), 'C04509');
    expect(nokia.updatedAt).toBeNull();
    expect(nokia.presets[0]?.measuredTime).toBeNull();
  });
});

describe('cameraImageTime', () => {
  it('suosii kamerakohtaista measuredTimea', () => {
    const camera = cameraAt(toTrafficCameras(RESPONSE, DATA), 'C04607');
    expect(cameraImageTime(camera, camera.presets[0]!)).toBe('2026-09-23T18:47:05Z');
  });

  it('käyttää aseman aikaa, jos kameralta puuttuu oma aika', () => {
    const camera = cameraAt(toTrafficCameras(RESPONSE, DATA), 'C04555');
    const withoutTime = camera.presets.find((preset) => preset.id === 'C0455509');
    expect(withoutTime).toBeDefined();
    expect(cameraImageTime(camera, withoutTime!)).toBe('2026-09-23T18:46:30Z');
  });
});
