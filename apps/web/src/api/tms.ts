/**
 * Liikenteen mittausasemat (`GET /v1/tms/stations`,
 * `GET /v1/tms/stations/{tmsNumber}/history`, arkkitehtuuri §30).
 *
 * Selain ei hae mittausdataa suoraan Digitrafficilta, vaikka se olisi
 * teknisesti mahdollista:
 *  - kaikkien asemien reaaliaikavastaus on 3,4 Mt pakkaamattomana
 *  - historia-rajapinta palauttaa CSV:tä (puolipiste, BOM), jonka jäsennys
 *    kuuluu palvelimelle
 *  - oma Lambda suodattaa Tampereen seudun asemat ja vaimmentaa
 *    upstream-kutsut välimuistilla (N selainta → 1 kutsu per TTL)
 */

import { apiGet } from './client';

/**
 * Pollausväli reaaliaikanäkymälle. Lähde päivittyy noin minuutin välein ja
 * Lambdan välimuisti on 60 s, joten tiuhempi pollaus ei toisi tuoreempaa tietoa.
 */
export const TMS_POLL_MS = 60_000;

/**
 * Historiaa ei pollata: se muuttuu tunneittain ja koskee päättyneitä jaksoja
 * (vuorokausia ja kuukausia). Siksi pitkä `staleTime`.
 */
export const TMS_HISTORY_STALE_TIME_MS = 30 * 60_000;

export type FlowLevel = 'SUJUVAA' | 'HIDASTUNUT' | 'RUUHKAUTUNUT' | 'TUNTEMATON';

export interface DirectionSnapshot {
  direction: 1 | 2;
  municipality: string | null;
  freeFlowSpeed: number | null;
  speed: number | null;
  volume: number | null;
  speedRatio: number | null;
  level: FlowLevel;
}

export interface StationSnapshot {
  id: number;
  tmsNumber: number;
  name: string;
  title: string;
  road: string | null;
  municipality: string | null;
  province: string | null;
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  directions: [DirectionSnapshot, DirectionSnapshot];
  measuredAt: string | null;
  ageMinutes: number | null;
}

export interface StationsResponse {
  stations: StationSnapshot[];
  counts: { stations: number; congested: number; unknown: number };
  generatedAt: string | null;
  fetchedAt: string;
  stale: boolean;
}

export interface HourlyPoint {
  hour: number;
  value: number | null;
}

export interface DailyPoint {
  date: string;
  total: number | null;
  light: number | null;
  heavy: number | null;
}

export interface DirectionSpeed {
  direction: string;
  municipality: string | null;
  speedLimit: string | null;
  total: number | null;
  light: number | null;
  heavy: number | null;
  avgSpeed: number | null;
  avgSpeedLight: number | null;
  avgSpeedHeavy: number | null;
}

export interface HistoryBase {
  tmsNumber: number;
  name: string | null;
  generatedAt: string | null;
  fetchedAt: string;
  stale: boolean;
}

export interface DailyHistory extends HistoryBase {
  type: 'daily';
  range: { from: string; to: string };
  days: DailyPoint[];
}

export interface HourlyHistory extends HistoryBase {
  type: 'hourly';
  date: string;
  hours: HourlyPoint[];
  total: number | null;
}

export interface SpeedHistory extends HistoryBase {
  type: 'speed';
  month: string;
  directions: DirectionSpeed[];
}

export type HistoryResponse = DailyHistory | HourlyHistory | SpeedHistory;

/**
 * Koko historian nippu (`type=all`), jota sivu käyttää.
 *
 * Yksi pyyntö kolmen sijaan: asemakortin valinta tarvitsee kaikki kolme
 * näkymää, ja kolme rinnakkaista pyyntöä ehtisi throttlautua kylmällä
 * Lambdalla (havaittu 27.9.2026 käyttäjän näkemänä 503:na).
 */
export interface HistoryBundle {
  type: 'all';
  tmsNumber: number;
  name: string | null;
  generatedAt: string | null;
  fetchedAt: string;
  stale: boolean;
  /** true = ainakin yksi kolmesta jaksosta puuttuu (näytetään huomautus). */
  partial: boolean;
  daily: DailyHistory;
  hourly: HourlyHistory;
  speed: SpeedHistory;
}

export async function fetchTmsStations(): Promise<StationsResponse> {
  const response = await apiGet<StationsResponse>('/v1/tms/stations');
  if (!Array.isArray(response.stations)) {
    throw new Error('Mittausasemavastauksen muoto oli odottamaton');
  }
  return response;
}

/**
 * Aseman historia yhdellä kutsulla: vuorokausivolyymit (14 vrk), tuntijakauma
 * (viimeisin täysi vuorokausi) ja kuukauden keskinopeudet suunnittain.
 */
export async function fetchTmsHistoryBundle(tmsNumber: number): Promise<HistoryBundle> {
  const response = await apiGet<HistoryBundle>(
    `/v1/tms/stations/${encodeURIComponent(String(tmsNumber))}/history`,
    { type: 'all' },
  );
  if (response.type !== 'all' || !response.daily || !response.hourly || !response.speed) {
    throw new Error('Historiavastauksen muoto oli odottamaton');
  }
  return response;
}
