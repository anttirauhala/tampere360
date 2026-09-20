/** API-vastausten tyypit (vastaavat apps/api:n palauttamaa muotoa). */

export type Category =
  'TRAFFIC' | 'PUBLIC_TRANSPORT' | 'POLICE' | 'RESCUE' | 'WEATHER' | 'EVENT' | 'RAIL';

export type Severity = 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL';
export type SituationStatus = 'ACTIVE' | 'UPCOMING' | 'ENDED' | 'CANCELLED';

/** Miten sijainti on päätelty (ks. packages/event-contracts/src/enums.ts). */
export type LocationMethod =
  'SOURCE_COORDINATE' | 'SOURCE_AREA' | 'DISTRICT_LOOKUP' | 'TEXT_GEOCODING' | 'MANUAL';

/** Minimal GeoJSON-geometria (WGS84, [longitude, latitude]). */
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] };

export interface LocalizedText {
  fi: string;
  sv?: string;
  en?: string;
}

/**
 * Listanäkymän rivi (kevyt).
 *
 * Aikakentät:
 * - `startsAt`  tapahtuman alkuaika lähteen mukaan — **null, jos ei tiedossa**
 * - `publishedAt` lähteen julkaisuaika — null, jos lähde ei kerro sitä
 * - `firstSeenAt` tekninen havaintoaika (Tampere360 näki tapahtuman)
 */
export interface SituationSummary {
  situationId: string;
  category: Category;
  severity: Severity;
  status: SituationStatus;
  startsAt: string | null;
  publishedAt?: string | null;
  firstSeenAt?: string | null;
  municipality?: string | null;
  title: string;
  /** Infoteksti (fi) listariviä varten; null jos lähde ei anna sitä. */
  description?: string | null;
}

export interface SituationListResponse {
  items: SituationSummary[];
  /** null = viimeinen sivu (cursor-sivutus). */
  nextCursor: string | null;
}

/** Yksittäisen tilanteen koko sisältö. */
export interface SituationDetail {
  situationId: string;
  canonicalKey: string;
  status: SituationStatus;
  category: Category;
  severity: Severity;
  startsAt: string;
  municipality?: string | null;
  geohash?: string | null;
  createdAt: string;
  updatedAt: string;
  event: {
    id: string;
    type: string;
    category: Category;
    severity: Severity;
    status: SituationStatus;
    title: LocalizedText;
    description?: LocalizedText;
    location: {
      municipality?: string | null;
      district?: string | null;
      address?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      geometry?: GeoJsonGeometry | null;
      areaCodes: string[];
      geohash?: string;
    };
    validity: { startsAt?: string | null; endsAt?: string | null };
    publishedAt: string;
    updatedAt: string;
    tags?: string[];
    locationMethod?: LocationMethod;
    attribution?: { name: string; url?: string; license?: string; required: boolean };
    source: {
      system: string;
      sourceId: string;
      url?: string;
      license?: string;
      fetchedAt: string;
    };
  };
}

/** GeoJSON-karttavastaus. */
export interface MapFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { situationId: string; title: string; severity: Severity };
}

export interface MapResponse {
  type: 'FeatureCollection';
  features: MapFeature[];
}

export interface SourceHealth {
  source: string;
  status: string;
  lastSuccessfulFetch?: string;
  itemsReceived?: number;
  error?: string;
}

export interface SourceHealthResponse {
  status: string;
  sources: SourceHealth[];
}

export interface CategoriesResponse {
  categories: Category[];
}

/** Kategorioiden suomenkieliset nimet ja värit. */
export const CATEGORY_LABELS: Record<Category, string> = {
  TRAFFIC: 'Liikenne',
  PUBLIC_TRANSPORT: 'Joukkoliikenne',
  POLICE: 'Poliisi',
  RESCUE: 'Pelastustoimi',
  WEATHER: 'Säävaroitukset',
  EVENT: 'Tapahtumat',
  RAIL: 'Junaliikenne',
};

/** Tapahtumatyypin emoji koostekortin otsikon eteen. */
export const CATEGORY_EMOJI: Record<Category, string> = {
  POLICE: '🚓', // poliisiauto
  WEATHER: '☀️', // aurinko
  TRAFFIC: '🚗', // auto
  PUBLIC_TRANSPORT: '🚌', // bussi
  EVENT: '🎉',
  RESCUE: '🚒',
  RAIL: '🚆',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  INFO: 'Tiedote',
  MINOR: 'Vähäinen',
  MAJOR: 'Merkittävä',
  CRITICAL: 'Kriittinen',
};

/** Lähdetunnisteiden suomenkieliset nimet. */
export const SOURCE_LABELS: Record<string, string> = {
  TAMPERE_TRAFFIC: 'Liikennetiedotteet (Digitraffic)',
  FMI_CAP: 'Ilmatieteen laitos (CAP)',
  POLICE_RSS: 'Sisä-Suomen poliisi (RSS)',
  NYSSE_ALERTS: 'Nysse (GTFS-RT)',
  VISIT_TAMPERE: 'Visit Tampere',
  RESCUE_MEDIA: 'Pelastustoimi',
};
