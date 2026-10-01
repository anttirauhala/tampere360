/**
 * Snapshotin rakentaminen: metatiedot + reaaliaikaiset anturiarvot
 * (arkkitehtuuri §30).
 *
 * Anturien nimet ovat Digitrafficin vakiintuneita nimiä. Suunnittain valitaan
 * **liukuva 5 minuutin keskiarvo** (`…_LIUKUVA_…`), koska se kuvaa
 * nykyhetkeä; kiinteä ikkuna (`…_KIINTEA_…`) on varalla, jos liukuvaa arvoa ei
 * kyseiseltä asemalta löydy. Jos kumpaakaan ei ole, arvo on `null` — sitä ei
 * arvata.
 */

import { flowLevel, roundRatio, speedRatio } from './flow';
import type { StationMeta } from './metadata';
import type {
  DigitrafficSensorValue,
  DigitrafficStationData,
  DirectionSnapshot,
  StationSnapshot,
  StationsResponse,
} from './types';

/** Anturinimet suunnittain, paremmuusjärjestyksessä. */
export function speedSensorNames(direction: 1 | 2): string[] {
  return [
    `KESKINOPEUS_5MIN_LIUKUVA_SUUNTA${direction}`,
    `KESKINOPEUS_5MIN_KIINTEA_SUUNTA${direction}`,
  ];
}

export function volumeSensorNames(direction: 1 | 2): string[] {
  return [`OHITUKSET_5MIN_LIUKUVA_SUUNTA${direction}`, `OHITUKSET_5MIN_KIINTEA_SUUNTA${direction}`];
}

/** Ensimmäinen löytyvä anturin arvo nimijärjestyksen mukaan. */
function sensorValue(values: Map<string, DigitrafficSensorValue>, names: string[]): number | null {
  for (const name of names) {
    const sensor = values.get(name);
    if (sensor && Number.isFinite(sensor.value)) return sensor.value;
  }
  return null;
}

export interface LiveValues {
  speed1: number | null;
  speed2: number | null;
  volume1: number | null;
  volume2: number | null;
  /** Mittausten aikaleima (lähteestä, ei arvattu). */
  measuredAt: string | null;
}

/** Poimii reaaliaikaiset arvot aseman anturilistasta. */
export function liveValues(data: DigitrafficStationData | null | undefined): LiveValues {
  const byName = new Map<string, DigitrafficSensorValue>();
  for (const sensor of data?.sensorValues ?? []) {
    byName.set(sensor.name, sensor);
  }

  return {
    speed1: sensorValue(byName, speedSensorNames(1)),
    speed2: sensorValue(byName, speedSensorNames(2)),
    volume1: sensorValue(byName, volumeSensorNames(1)),
    volume2: sensorValue(byName, volumeSensorNames(2)),
    measuredAt: data?.dataUpdatedTime ?? null,
  };
}

function directionSnapshot(
  direction: 1 | 2,
  municipality: string | null,
  freeFlowSpeed: number | null,
  speed: number | null,
  volume: number | null,
): DirectionSnapshot {
  const ratio = speedRatio(speed, freeFlowSpeed);
  return {
    direction,
    municipality,
    freeFlowSpeed,
    speed,
    volume,
    speedRatio: roundRatio(ratio),
    level: flowLevel(speed, freeFlowSpeed, volume),
  };
}

/** Kuinka vanha mittaus oli vastausta rakennettaessa (minuutteina). */
export function ageMinutes(measuredAt: string | null, nowMs: number): number | null {
  if (!measuredAt) return null;
  const time = Date.parse(measuredAt);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.round((nowMs - time) / 60_000));
}

/** Yksi asema vastausmuodossa. */
export function toStationSnapshot(
  meta: StationMeta,
  data: DigitrafficStationData | null,
  nowMs: number,
): StationSnapshot {
  const live = liveValues(data);
  return {
    id: meta.id,
    tmsNumber: meta.tmsNumber,
    name: meta.name,
    title: meta.title,
    road: meta.road,
    municipality: meta.municipality,
    province: meta.province,
    latitude: meta.latitude,
    longitude: meta.longitude,
    bearing: meta.bearing,
    directions: [
      directionSnapshot(
        1,
        meta.direction1Municipality,
        meta.freeFlowSpeed1,
        live.speed1,
        live.volume1,
      ),
      directionSnapshot(
        2,
        meta.direction2Municipality,
        meta.freeFlowSpeed2,
        live.speed2,
        live.volume2,
      ),
    ],
    measuredAt: live.measuredAt,
    ageMinutes: ageMinutes(live.measuredAt, nowMs),
  };
}

/** Onko aseman sujuvuus arvioitavissa kummassakaan suunnassa? */
function hasKnownLevel(station: StationSnapshot): boolean {
  return station.directions.some((direction) => direction.level !== 'TUNTEMATON');
}

function isCongested(station: StationSnapshot): boolean {
  return station.directions.some((direction) => direction.level === 'RUUHKAUTUNUT');
}

export interface BuildStationsOptions {
  metas: StationMeta[];
  liveById: Map<number, DigitrafficStationData>;
  generatedAt: string | null;
  fetchedAt: string;
  nowMs: number;
  stale: boolean;
}

/**
 * Rakentaa koko vastauksen. Asemat järjestetään nimen mukaan, jotta
 * käyttöliittymän järjestys on vakaa eikä riipu lähteen järjestyksestä.
 */
export function buildStationsResponse(options: BuildStationsOptions): StationsResponse {
  const stations = options.metas
    .map((meta) => toStationSnapshot(meta, options.liveById.get(meta.id) ?? null, options.nowMs))
    .sort((a, b) => a.title.localeCompare(b.title, 'fi'));

  return {
    stations,
    counts: {
      stations: stations.length,
      congested: stations.filter(isCongested).length,
      unknown: stations.filter((station) => !hasKnownLevel(station)).length,
    },
    generatedAt: options.generatedAt,
    fetchedAt: options.fetchedAt,
    stale: options.stale,
  };
}
