/** TanStack Query -hookit: välimuisti, taustapäivitykset, pollaus (§10–11). */

import { useQuery } from '@tanstack/react-query';

import { fetchCameraData, fetchCameraStations } from './cameras';
import { apiGet } from './client';
import { SAUNAS_STALE_TIME_MS, fetchSaunas } from './saunas';
import {
  STOP_DEPARTURES_POLL_MS,
  STOPS_STALE_TIME_MS,
  fetchStopDepartures,
  fetchStops,
} from './stops';
import { VEHICLE_POLL_MS, fetchVehicles } from './vehicles';
import { WATER_TEMPERATURE_POLL_MS, fetchWaterTemperature } from './water';
import { WEATHER_POLL_MS, fetchCurrentWeather } from './weather';
import {
  TMS_HISTORY_STALE_TIME_MS,
  TMS_POLL_MS,
  fetchTmsHistoryBundle,
  fetchTmsStations,
} from './tms';
import type {
  Category,
  MapResponse,
  SituationDetail,
  SituationListResponse,
  SourceHealthResponse,
  VehicleMode,
} from './types';

/** Pollausväli: aktiivinen tilannekuva päivittyy 30 sekunnin välein. */
const POLL_MS = 30_000;

export interface SituationQuery {
  category?: Category | undefined;
  status?: string | undefined;
  area?: string | undefined;
  limit?: number | undefined;
}

export function useSituations(query: SituationQuery = {}) {
  return useQuery({
    queryKey: ['situations', query],
    queryFn: () =>
      apiGet<SituationListResponse>('/v1/situations', {
        category: query.category,
        status: query.status ?? 'ACTIVE',
        area: query.area,
        limit: query.limit ?? 100,
      }),
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });
}

export function useSituation(id: string | undefined) {
  return useQuery({
    queryKey: ['situation', id],
    queryFn: () => apiGet<SituationDetail>(`/v1/situations/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useMapFeatures() {
  return useQuery({
    queryKey: ['map'],
    queryFn: () => apiGet<MapResponse>('/v1/map'),
    refetchInterval: POLL_MS,
  });
}

export function useSourceHealth() {
  return useQuery({
    queryKey: ['source-health'],
    queryFn: () => apiGet<SourceHealthResponse>('/v1/health/sources'),
    refetchInterval: 60_000,
  });
}

/**
 * Kelikamerat Digitrafficilta (suoraan selaimesta, ks. api/cameras.ts).
 *
 * Kaksi kutsua rinnakkain:
 * - `fetchCameraStations` — asemien nimet, sijainnit ja kamerat
 * - `fetchCameraData` — kameroiden todelliset kuvausajat (`measuredTime`);
 *   asemaluettelon oma `dataUpdatedTime` on metatietoa ja voi olla tunteja vanha
 *
 * Ei automaattista pollausta: kamerakuvat ovat raskaita, joten uudet kuvat
 * haetaan vain käyttäjän "Päivitä kuvat" -painikkeella tai kun välilehti
 * avataan uudelleen (oletus `refetchOnWindowFocus: true` on kytketty pois,
 * jotta välilehdelle palaaminen ei lataa kymmeniä kuvia uudelleen).
 */
export function useCameraData() {
  return useQuery({
    queryKey: ['cameras'],
    queryFn: async ({ signal }) => {
      const [stations, data] = await Promise.all([
        fetchCameraStations(signal),
        fetchCameraData(signal),
      ]);
      return { stations, data };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Joukkoliikenteen ajoneuvot kartalle (§27).
 *
 * - Pollaus 5 s (ks. `VEHICLE_POLL_MS`); oma Lambda vaimmentaa Waltti-kutsut
 *   välimuistilla, joten useampi avoin selain ei lisää upstream-kuormaa.
 * - `refetchIntervalInBackground: false`: taustalla oleva välilehti ei pollaa.
 * - Välimuistia ei jaeta muodon yli (`queryKey` sisältää muodon), joten
 *   Ratikat/Bussit-vaihto ei näytä hetkeäkään väärää aineistoa — kartalla
 *   säilyy sen ajan edellinen piirto.
 */
export function useVehicles(mode: VehicleMode) {
  return useQuery({
    queryKey: ['vehicles', mode],
    queryFn: () => fetchVehicles(mode),
    refetchInterval: VEHICLE_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: VEHICLE_POLL_MS,
  });
}

/**
 * Pysäkkirekisteri kartalle (§28).
 *
 * Haetaan **vain kun käyttäjä valitsee "Näytä pysäkit"** (`enabled`): vastaus on
 * ~430 kt GeoJSONia (3 423 pysäkkiä), joten sitä ei ladata turhaan. Rekisteri
 * muuttuu käytännössä päivittäin, joten `staleTime` on 24 h eikä
 * taustapollausta tehdä.
 */
export function useStops(enabled: boolean) {
  return useQuery({
    queryKey: ['stops'],
    queryFn: fetchStops,
    enabled,
    staleTime: STOPS_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * Yhden pysäkin reaaliaikaiset lähdöt (§28).
 *
 * Haku käynnistyy vasta kun pysäkki on valittu, ja pollaus on 15 s — sama kuin
 * Lambdan välimuisti, eli useampi avoin selain ei lisää Waltti-kutsuja.
 * Taustavälilehti ei pollaa.
 */
export function useStopDepartures(stopId: string | null) {
  return useQuery({
    queryKey: ['stop-departures', stopId],
    queryFn: () => {
      if (!stopId) throw new Error('Pysäkkiä ei ole valittu');
      return fetchStopDepartures(stopId);
    },
    enabled: Boolean(stopId),
    refetchInterval: STOP_DEPARTURES_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: STOP_DEPARTURES_POLL_MS,
  });
}

/**
 * Liikenteen mittausasemat (§30).
 *
 * Pollaus 60 s: lähde päivittyy minuutin välein ja Lambdan välimuisti on 60 s,
 * joten tiuhempi pollaus ei toisi tuoreempaa tietoa mutta kertautuisi jokaisen
 * avoimen selaimen myötä. Taustavälilehti ei pollaa.
 */
export function useTmsStations() {
  return useQuery({
    queryKey: ['tms-stations'],
    queryFn: fetchTmsStations,
    refetchInterval: TMS_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: TMS_POLL_MS,
  });
}

/**
 * Yhden mittausaseman historia: vuorokausivolyymit, tuntijakauma JA
 * kuukausikeskinopeudet **yhdellä pyynnöllä** (`type=all`).
 *
 * Yksi pyyntö kolmen sijaan on tarkoituksellinen: sivun avaus tekisi muuten
 * neljä rinnakkaista kutsua (1 tilannekuva + 3 historiaa), ja kylmällä
 * Lambdalla kolme niistä ehti throttlautua (käyttäjä näki 503:n, havaittu
 * 27.9.2026). Lambdassa rinnakkaisuus on sisäistä, joten se ei kuluta
 * varattua concurrencya.
 *
 * Haetaan vain valitulle asemalle, ja koska tilastot muuttuvat tunneittain,
 * `staleTime` on 30 min eikä taustapollausta tehdä. Lambda pitää oman 6 tunnin
 * välimuistinsa, joten aseman vaihtelu ei aiheuta uusia Digitraffic-kutsuja.
 */
export function useTmsHistoryBundle(tmsNumber: number | null) {
  return useQuery({
    queryKey: ['tms-history', tmsNumber],
    queryFn: () => {
      if (tmsNumber === null) throw new Error('Asemaa ei ole valittu');
      return fetchTmsHistoryBundle(tmsNumber);
    },
    enabled: tmsNumber !== null,
    staleTime: TMS_HISTORY_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * Tampereen nykyinen sää Nyt-sivun otsikkoriville (§31).
 *
 * Pollaus 5 min: FMI päivittää havainnot ~10 min välein ja Lambdan välimuisti
 * on 5 min, joten tiuhempi pollaus ei toisi tuoreempaa tietoa mutta
 * kertautuisi jokaisen avoimen selaimen myötä. Taustavälilehti ei pollaa.
 */
export function useCurrentWeather() {
  return useQuery({
    queryKey: ['weather', 'current'],
    queryFn: fetchCurrentWeather,
    refetchInterval: WEATHER_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: WEATHER_POLL_MS,
  });
}

/**
 * Saunat (§33).
 *
 * Ei automaattipollausta: aukioloajat ja hinnat muuttuvat harvoin, joten tieto
 * haetaan kerran istunnossa ja päivitetään käyttäjän "Päivitä tiedot"
 * -painikkeella. `refetchOnWindowFocus: false`, jotta välilehdelle palaaminen ei
 * tee turhaa hakua; Lambdan välimuisti pitää upstream-kutsut kurissa.
 */
export function useSaunas() {
  return useQuery({
    queryKey: ['saunas'],
    queryFn: fetchSaunas,
    staleTime: SAUNAS_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * Näsijärven pintaveden lämpötila (§34), Saunat-sivun leadin alle.
 *
 * Pollaus 5 min (sama kuin Lambdan välimuisti). Havainto on päivittäinen, joten
 * tiuhempi pollaus ei toisi tuoreempaa tietoa. Taustavälilehti ei pollaa.
 */
export function useWaterTemperature() {
  return useQuery({
    queryKey: ['water-temperature'],
    queryFn: fetchWaterTemperature,
    refetchInterval: WATER_TEMPERATURE_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: WATER_TEMPERATURE_POLL_MS,
  });
}
