/**
 * Nysse-pysäkit ja reaaliaikaiset lähdöt — jaetut tyypit (arkkitehtuuri §28).
 *
 * Nämä tyypit ovat sekä Lambdan (`handler.ts`) että frontendin
 * (`apps/web/src/api/types.ts`) sopimus.
 *
 * Kaksi erillistä dataa, kaksi eri cachea:
 *  - **staattinen** pysäkkirekisteri GTFS-static-aineistosta (muuttuu harvoin)
 *  - **reaaliaikaiset** lähdöt Waltti SIRI StopMonitoringista (15 s cache)
 */

/** GTFS-static `stops.txt` -rivi (vain kartalla tarvittavat kentät). */
export interface GtfsStop {
  /** GTFS `stop_id`, esim. `0015`. **Sama tunniste, jota SIRI SM käyttää `MonitoringRef`inä.** */
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * Pysäkki API-vastauksessa.
 *
 * `latitude`/`longitude` ovat `null`, jos koordinaattia ei tunneta: GTFS-static
 * on ainoa lähde, jossa ne ovat, ja lähdedatan puuttuessa arvoa **ei arvata**
 * (§20). Frontend saa koordinaatit joka tapauksessa kartan pysäkkikerroksesta.
 */
export interface Stop {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

/** Karttakerroksen pysäkin ominaisuudet (GeoJSON `properties`). */
export interface StopProperties {
  id: string;
  name: string;
}

export interface StopFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: StopProperties;
}

/**
 * `GET /v1/stops` -vastaus: valmis GeoJSON, jotta kartalla on **yksi lähde**
 * (sama periaate kuin ajoneuvoissa, §27). Klusterointi tehdään MapLibressa.
 */
export interface StopFeatureCollection {
  type: 'FeatureCollection';
  source: 'NYSSE_GTFS';
  /** Milloin Tampere 247 haki tai luki staattisen aineiston (oma aikaleima). */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui ja tarjolla on vanhempi pysäkkirekisteri. */
  stale: boolean;
  count: number;
  features: StopFeature[];
}

/**
 * SIRI StopMonitoring -vastauksesta poimitut kentät (raaka, ei vielä API-mallia).
 *
 * Lähde antaa pysäkillä käynnissä olevat vuorot: jokainen `MonitoredStopVisit`
 * on yksi ajoneuvo matkalla tälle pysäkille.
 */
export interface SiriStopVisit {
  /** Lähteen havaintoaika (`RecordedAtTime`), UTC-ISO. */
  recordedAt: string | null;
  /** `MonitoringRef` — pysäkkitunniste, jolla tieto pyydettiin. */
  stopId: string;
  /** Linjan numero sellaisena kuin se näytetään (`LineRef`). */
  line: string;
  /** Määränpää kyltin mukaan (`DestinationName`). */
  destination: string | null;
  /** Lähtöpiste (`OriginName`). */
  origin: string | null;
  /** Pysäkin nimi lähteen mukaan (`StopVisitNote`). */
  stopName: string | null;
  /** `Monitored` = onko vuoro reaaliaikaisen seurannan piirissä. */
  realtime: boolean;
  /** Poikkeama aikataulusta sekunteina (positiivinen = myöhässä). */
  delaySeconds: number | null;
  /** Aikataulun mukainen saapuminen/lähtö tältä pysäkiltä (UTC-ISO). */
  aimedArrivalTime: string | null;
  aimedDepartureTime: string | null;
  /** Ennustettu saapuminen/lähtö (UTC-ISO). */
  expectedArrivalTime: string | null;
  expectedDepartureTime: string | null;
  /** Onko ajoneuvo juuri nyt pysäkillä (`VehicleAtStop`). */
  vehicleAtStop: boolean;
}

/** Parsittu StopMonitoring-vastaus. */
export interface ParsedStopMonitoring {
  /** Lähteen tuotantoaika (`ResponseTimestamp`), UTC-ISO tai null. */
  generatedAt: string | null;
  /** Kuinka kauan tämä vastaus on voimassa lähteen mukaan (`ValidUntil`, ~30 s). */
  validUntil: string | null;
  visits: SiriStopVisit[];
}

/**
 * Yksittäinen lähtö pysäkin sidepanelissa.
 *
 * Aikakentät noudattavat §20:n sääntöä: `null` tarkoittaa "ei tiedossa",
 * ei arvattua aikaa. `scheduledTime` on aikataulun mukainen aika ja
 * `expectedTime` reaaliaikainen ennuste (sama kuin aikataulu, jos vuoro ei ole
 * reaaliaikaisen seurannan piirissä).
 */
export interface StopDeparture {
  /** Linjan numero, esim. `3`, `8A`. */
  routeShortName: string;
  /** Määränpää, esim. `Hervanta`. */
  destination: string | null;
  /** Aikataulun mukainen lähtöaika (UTC-ISO) tai null. */
  scheduledTime: string | null;
  /** Ennustettu lähtöaika (UTC-ISO) tai null. */
  expectedTime: string | null;
  /** Poikkeama aikataulusta sekunteina (positiivinen = myöhässä) tai null. */
  delaySeconds: number | null;
  /** true = vuoro on reaaliaikaisen seurannan piirissä (`Monitored`). */
  realtime: boolean;
}

/**
 * `GET /v1/stops/{stopId}/departures` -vastaus.
 *
 * `stop` on `null` vain, jos pysäkkiä ei löytynyt muistissa olevasta
 * pysäkkirekisteristä eikä lähteen vastauksesta — frontend näyttää silloin
 * pelkän tunnisteen (se tuntee pysäkin kartalta).
 */
export interface StopDeparturesResponse {
  stop: Stop | null;
  departures: StopDeparture[];
  /** Lähteen tuotantoaika (UTC-ISO) tai null. */
  generatedAt: string | null;
  /** Milloin Tampere 247 haki tiedot (oma aikatekniikka). */
  fetchedAt: string;
  /** true = upstream-haku epäonnistui, tarjolla on viimeisin onnistunut vastaus. */
  stale: boolean;
  /**
   * `true` = lähtötiedot saatiin Waltilta (myös tyhjä lista on tieto).
   *
   * `false` = Waltti **ei palauta tälle pysäkille aikatauluja lainkaan**
   * (sen reaaliaikarekisteristä puuttuva pysäkki). Tämä päätellään toistuvista
   * virheistä (`coverage.ts`), koska Waltti vastaa tällaisille pysäkeille
   * pelkällä HTTP 500:lla eikä kerro syytä. Frontend näyttää silloin
   * rauhallisen "ei reaaliaikatietoja" -huomautuksen virheen sijaan.
   */
  realtimeCoverage: boolean;
}
