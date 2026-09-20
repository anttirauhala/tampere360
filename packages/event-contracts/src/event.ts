/**
 * Tampere360 — yhteinen tapahtumamalli (arkkitehtuuri §3).
 *
 * Kaikki ulkoiset lähteet muunnetaan tähän Tampere360Event-malliin.
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

/** Voimassaoloaika. `startsAt === null` → tapahtuman alkuaika ei ole tiedossa. */
export interface Validity {
  /**
   * Tapahtuman alkuaika lähteen mukaan (ISO 8601).
   *
   * Täytetään VAIN lähteen omasta tapahtuma-ajasta (esim. CAP `onset`,
   * Digitraffic `startTime`, GTFS-RT `activePeriod.start`). Jos lähde ei
   * kerro alkuaikaa, arvo on `null` — sitä ei päätellä julkaisu- tai
   * hakuaikaеsta (arkkitehtuuri §5: epävarmaa tietoa ei esitetä varmana).
   */
  startsAt?: string | null;
  /** Tapahtuman päättymisaika lähteen mukaan (ISO 8601), jos tiedossa. */
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
export interface Tampere360Event {
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
  /**
   * Lähteen oma julkaisuaika (ISO 8601).
   *
   * `null`, jos lähde ei anna julkaisuaikaa — arvoa EI koskaan päätellä
   * hakuajasta, jotta tekninen kellonaika ei valu liiketoimintadataan.
   * Tekninen "milloin havaitsimme" on aina `firstSeenAt`.
   */
  publishedAt: string | null;
  /**
   * Lähteen oma päivitysaika (ISO 8601), jos lähde antaa sen.
   * `null`, jos lähde ei kerro päivitysaikaa.
   */
  updatedAt: string | null;
  /**
   * Milloin Tampere360 näki tapahtuman ensimmäisen kerran (ISO 8601).
   *
   * Tekninen aikaleima: asetetaan normalisoinnissa. Tämä EI ole tapahtuman
   * alkuаika eikä lähteen julkaisuaika, vaan järjestelmän oma havaintoaika.
   * Käytetään järjestyksen ja "havaittu"-merkinnän pohjana silloin, kun
   * lähde ei anna tapahtuman omaa aikaa.
   */
  firstSeenAt: string;
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
