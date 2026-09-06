/**
 * Tampere247 — yhteinen tapahtumamalli (arkkitehtuuri §3).
 *
 * Kaikki ulkoiset lähteet muunnetaan tähän Tampere247Event-malliin.
 * Malli erottaa: tapahtuman oman tunnisteen, lähdejärjestelmän tunnisteen,
 * kanonisen duplikaattiavaimen, julkaisu-/päivitys-/voimassaoloajat, tilan,
 * vakavuuden, sijainnin ja geometrian, lähteen ja lisenssin, kieliversiot
 * sekä alkuperäisen sisällön tarkisteen.
 */

import type {
  AreaCode,
  EventCategory,
  EventType,
  LifecycleStatus,
  LocationMethod,
  Severity,
  SituationStatus,
  SourceSystem,
} from './enums';

/** Skeeman versio. Muutetaan vain yhteensopimattomissa muutoksissa. */
export const SCHEMA_VERSION = '1.0';

/** Localized text; `fi` on aina pakollinen. */
export interface LocalizedText {
  fi: string;
  sv?: string;
  en?: string;
}

/** Minimal GeoJSON-geometriat (WGS84, [longitude, latitude]). */
export type GeoJsonPosition = [number, number];
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: GeoJsonPosition }
  | { type: 'LineString'; coordinates: GeoJsonPosition[] }
  | { type: 'MultiLineString'; coordinates: GeoJsonPosition[][] }
  | { type: 'Polygon'; coordinates: GeoJsonPosition[][] }
  | { type: 'MultiPolygon'; coordinates: GeoJsonPosition[][][] };

/** Lähdejärjestelmän tiedot (ei sisällä raakadataa — se on S3:ssa). */
export interface SourceRef {
  system: SourceSystem;
  /** Lähdejärjestelmän oma tunniste tapahtumalle. */
  sourceId: string;
  /** Lähdejärjestelmän revisio (esim. Digitraffic `version`), jos saatavilla. */
  revision?: string;
  /** URL alkuperäiseen sisältöön tai rajapinnan dokumentaatioon. */
  url?: string;
  /** Lisenssi, esim. "CC-BY-4.0". */
  license?: string;
  /** Milloin data haettiin lähteestä (ISO 8601). */
  fetchedAt: string;
}

/** Sijainti. Epävarmaa koordinaattia EI koskaan esitetä varmana (arkkitehtuuri §5). */
export interface EventLocation {
  municipality?: string | null;
  district?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  geometry?: GeoJsonGeometry | null;
  /** Geohash koordinaateista (GSI4). */
  geohash?: string;
  /** Alueet, joille tapahtuma on relevantti. */
  areaCodes: AreaCode[];
}

/** Voimassaoloaika. `endsAt === null` → päättymisaika ei tiedossa. */
export interface Validity {
  startsAt?: string | null;
  endsAt?: string | null;
}

/** Lähteen attribuutio (lisenssien edellyttämä näyttö UI:ssa). */
export interface Attribution {
  name: string;
  url?: string;
  license?: string;
  /** Onko attribuutio pakollinen näyttää (lisenssin mukaan). */
  required: boolean;
}

/** Normalisoitu tapahtuma — putken yhteinen valuutta. */
export interface Tampere247Event {
  schemaVersion: string;
  /** Tapahtuman oma tunniste (ULID). */
  id: string;
  /** Kanoninen duplikaattiavain, esim. "traffic:tampere-api:incident-12345". */
  canonicalKey: string;
  /**
   * Idempotenssiavain (arkkitehtuuri §4.1):
   * "source:sourceId:revision" tai "source:sourceId:sha256(...):n".
   */
  processingKey: string;
  source: SourceRef;
  type: EventType;
  category: EventCategory;
  severity: Severity;
  status: SituationStatus;
  lifecycle: LifecycleStatus;
  title: LocalizedText;
  description?: LocalizedText;
  location: EventLocation;
  validity: Validity;
  /** Lähteen julkaisuaika (ISO 8601). */
  publishedAt: string;
  /** Lähteen päivitysaika (ISO 8601). */
  updatedAt: string;
  tags?: string[];
  attribution?: Attribution;
  /**
   * Alkuperäisen sisällön tarkiste (SHA-256) muutostunnistusta varten.
   */
  contentHash: string;
  /** Sijainnin luottamus 0–1 (pakollinen jos locationMethod = TEXT_GEOCODING). */
  locationConfidence?: number;
  locationMethod?: LocationMethod;
}
