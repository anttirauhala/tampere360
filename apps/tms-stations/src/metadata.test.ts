import { describe, expect, it } from 'vitest';

import { buildStationMeta, selectRegionStations } from './metadata';
import type {
  DigitrafficStationDetail,
  DigitrafficStationFeature,
  DigitrafficStationsResponse,
} from './types';

/** Aito simplified-rivi (27.9.2026): vt12_Tre_Paasikiventie Tampereella. */
function feature(
  id: number,
  tmsNumber: number,
  name: string,
  longitude: number,
  latitude: number,
  collectionStatus = 'GATHERING',
): DigitrafficStationFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [longitude, latitude, 0] },
    properties: { id, tmsNumber, name, collectionStatus },
  };
}

const PAASIKIVENTIE = feature(23438, 438, 'vt12_Tre_Paasikiventie', 23.697679, 61.508408);

/** Aito detailed-vastaus samasta asemasta. */
const PAASIKIVENTIE_DETAIL: DigitrafficStationDetail = {
  type: 'Feature',
  id: 23438,
  geometry: { type: 'Point', coordinates: [23.697679, 61.508408, 0] },
  properties: {
    id: 23438,
    tmsNumber: 438,
    name: 'vt12_Tre_Paasikiventie',
    collectionStatus: 'GATHERING',
    bearing: 100,
    municipality: 'Tampere',
    province: 'Pirkanmaa',
    direction1Municipality: 'Lahti',
    direction2Municipality: 'Rauma',
    freeFlowSpeed1: 55,
    freeFlowSpeed2: 55,
    names: {
      fi: 'Tie 12 Tampere Uittotunneli',
      sv: 'Väg 12 Tammerfors Flottningstunnel',
      en: 'Road 12 Tampere Uittotunneli',
    },
  },
};

describe('selectRegionStations', () => {
  it('valitsee vain Tampereen seudun keruussa olevat asemat', () => {
    const response: DigitrafficStationsResponse = {
      type: 'FeatureCollection',
      features: [
        PAASIKIVENTIE,
        feature(23471, 471, 'vt3_Tampere_Multisilta', 23.679, 61.492),
        // Alueen ulkopuolella (Helsinki)
        feature(1234, 234, 'vt1_Helsinki', 24.94, 60.17),
        // Alueella mutta keruu poistettu käytöstä
        feature(23456, 456, 'kt65_Tre_Lielahti', 23.63, 61.51, 'REMOVED_TEMPORARILY'),
      ],
    };

    const selected = selectRegionStations(response);
    expect(selected.map((item) => item.properties.id)).toEqual([23438, 23471]);
  });

  it('kestää puuttuvan koordinaatin ja tyhjän vastauksen', () => {
    const broken: DigitrafficStationFeature = {
      type: 'Feature',
      properties: { id: 1, tmsNumber: 1, name: 'rikki', collectionStatus: 'GATHERING' },
    };
    expect(selectRegionStations({ type: 'FeatureCollection', features: [broken] })).toEqual([]);
    expect(selectRegionStations(null)).toEqual([]);
    expect(selectRegionStations(undefined)).toEqual([]);
  });
});

describe('buildStationMeta', () => {
  it('yhdistää simplified- ja detailed-tiedot', () => {
    const meta = buildStationMeta(PAASIKIVENTIE, PAASIKIVENTIE_DETAIL);
    expect(meta).toMatchObject({
      id: 23438,
      tmsNumber: 438,
      name: 'vt12_Tre_Paasikiventie',
      title: 'Tie 12 Tampere Uittotunneli',
      road: 'vt12',
      municipality: 'Tampere',
      province: 'Pirkanmaa',
      latitude: 61.508408,
      longitude: 23.697679,
      bearing: 100,
      direction1Municipality: 'Lahti',
      direction2Municipality: 'Rauma',
      freeFlowSpeed1: 55,
      freeFlowSpeed2: 55,
    });
  });

  it('toimii ilman detailed-tietoja (otsikko = tekninen nimi, vapaa nopeus null)', () => {
    const meta = buildStationMeta(PAASIKIVENTIE, null);
    expect(meta.title).toBe('vt12_Tre_Paasikiventie');
    expect(meta.municipality).toBeNull();
    expect(meta.freeFlowSpeed1).toBeNull();
    expect(meta.latitude).toBe(61.508408);
    expect(meta.road).toBe('vt12');
  });

  it('näyttää puuttuvan tiedon nullina eikä keksi arvoa', () => {
    const bare = feature(89, 89, 'DSL6L', 23.6, 61.5);
    const meta = buildStationMeta(bare, {
      type: 'Feature',
      id: 89,
      properties: { id: 89, tmsNumber: 89, name: 'DSL6L' },
    });
    expect(meta.title).toBe('DSL6L');
    expect(meta.road).toBeNull();
    expect(meta.municipality).toBeNull();
    expect(meta.bearing).toBeNull();
    expect(meta.freeFlowSpeed2).toBeNull();
  });
});
