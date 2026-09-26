/**
 * Joukkoliikenteen ajoneuvosijainnit — jaetut tyypit (arkkitehtuuri §27).
 *
 * Nämä tyypit ovat sekä Lambdan (`handler.ts`) että frontendin
 * (`apps/web/src/api/types.ts`) sopimus. Frontend renderöi vastauksen **yhdestä
 * GeoJSON-lähteestä**, joten vastaus on jo valmiiksi FeatureCollection.
 */

/** Ajoneuvon liikennöintimuoto. Nyssellä esiintyvät vain nämä kaksi. */
export type VehicleMode = 'TRAM' | 'BUS';

/** SIRI VehicleMonitoring -vastauksesta poimitut kentät (raaka, ei vielä GeoJSONia). */
export interface SiriVehicle {
  /** SIRI `VehicleRef`, esim. `56920_10` — pysyvä ajoneuvotunniste (idempotenssi/dedupe). */
  vehicleId: string;
  /** Linjan numero sellaisena kuin se näytetään: `1`, `80`, `40A`. */
  line: string;
  /** Waltti `OperatorRef`, esim. `56920` (ratikka). Puuttuu jos lähde ei anna sitä. */
  operatorRef: string | null;
  /** Määränpää sellaisena kuin se lukee bussin kyltissä, esim. `Keskustori G`. */
  destination: string | null;
  /** Lähtöpiste, esim. `Moisio`. */
  origin: string | null;
  /** Suuntakoodi (1/2), ei maantieteellinen suunta. */
  direction: number | null;
  latitude: number;
  longitude: number;
  /** Suunta asteina (0 = pohjoinen). Ikonin kierto kartalla. */
  bearing: number | null;
  /** Poikkeama aikataulusta sekunteina: positiivinen = myöhässä, negatiivinen = etuajassa. */
  delaySeconds: number | null;
  /** Lähteen oma havaintoaika UTC-ISO:na (`RecordedAtTime`). */
  recordedAt: string;
}

/** Kartalla näytettävän ajoneuvon ominaisuudet. */
export interface VehicleProperties {
  vehicleId: string;
  line: string;
  mode: VehicleMode;
  destination: string | null;
  origin: string | null;
  direction: number | null;
  bearing: number | null;
  delaySeconds: number | null;
  recordedAt: string;
}

export interface VehicleFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: VehicleProperties;
}

/** API-vastaus (`GET /v1/vehicles`). */
export interface VehicleFeatureCollection {
  type: 'FeatureCollection';
  source: 'NYSSE_SIRI';
  /**
   * Walttin oma tuotantoaika (`ResponseTimestamp`) — **ei** meidän kelloamme.
   * `null`, jos lähde ei anna sitä. Noudattaa §20:n sääntöä: aikaleimoja ei arvata.
   */
  generatedAt: string | null;
  /** Milloin Tampere 247 haki tiedot (oma tekninen aikaleima). */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui ja tarjolla on viimeisin onnistunut snapshot. */
  stale: boolean;
  /** Ajoneuvojen määrä muodoittain **ennen** `mode`-suodatusta. */
  counts: Record<VehicleMode, number>;
  /** Suodatuksen jälkeinen määrä (sama kuin `features.length`). */
  count: number;
  features: VehicleFeature[];
}
