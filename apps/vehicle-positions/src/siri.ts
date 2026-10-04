/**
 * Walttin SIRI VehicleMonitoring -vastauksen jäsennys (arkkitehtuuri §27).
 *
 * Miksi SIRI eikä GTFS-RT: GTFS-RT `vehicleposition` antaa vain
 * `routeId`n (`806990`), jonka linja+operaattori-koodaus on dokumentoimaton,
 * eikä määränpäätä lainkaan. SIRI antaa suoraan `LineRef`n (linjan numero),
 * `DestinationName`in (kyttikyltti) ja `Delay`n. Muoto on XML, ja
 * `fast-xml-parser` on jo käytössä FMI CAP -adapterissa.
 *
 * Suorituskyky: koko vastaus on ~1,8 Mt XML:ää, josta `<OnwardCalls>` (seuraavat
 * pysäkit, ~1,6 Mt / 4 100 elementtiä) on jäsentämisen kannalta turhaa.
 * Siivoamalla se pois ennen jäsennystä päästään mitattuun 415 ms → 36 ms
 * (verifioitu 26.9.2026). Jos siivottu dokumentti ei tuota yhtään ajoneuvoa,
 * jäsennetään koko dokumentti — näin lähdemuutos ei riko putkea hiljaisesti.
 */

import { XMLParser } from 'fast-xml-parser';

import type { SiriVehicle } from './types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Arvot pidetään merkkijonoina: linjanumero "80" ei saa muuttua numeroksi
  // 80 (numerot ovat myös muotoa "40A") eikä "61.5704918" pyöristy
  // tarkkuudeltaan eri tavalla. Numeeriset kentät muunnetaan eksplisiittisesti.
  parseTagValue: false,
  parseAttributeValue: false,
});

/** Poistaa `<OnwardCalls>`-lohkot ennen jäsennystä (ks. tiedoston yläkommentti). */
export function stripOnwardCalls(xml: string): string {
  return xml.replace(/<OnwardCalls\b[\s\S]*?<\/OnwardCalls>/g, '');
}

/** ISO 8601 -kesto sekunteina (`Delay`). Palauttaa `null`, jos arvoa ei voi tulkita. */
export function parseIsoDurationSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match =
    /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      raw.trim(),
    );
  if (!match) return null;
  const [, sign, years, months, days, hours, minutes, seconds] = match;
  // Vuodet ja kuukaudet eivät ole muunnettavissa sekunneiksi — palautetaan
  // `null` sen sijaan että arvattaisiin (§20: aikaleimoja ei arvata).
  // HUOM: SIRI kirjoittaa nollakomponentit näkyviin (P0Y0M0D...), joten
  // pelkkä olemassaolo ei riitä — arvon on oltava nollasta poikkeava.
  if (Number(years ?? 0) > 0 || Number(months ?? 0) > 0) return null;
  if (!days && !hours && !minutes && !seconds) return null;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return sign ? -total : total;
}

/** Normalisoi lähdeajan UTC-ISO-muotoon (SIRI antaa `+03:00`-siirtymän). */
export function toUtcIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** SIRI-elementin teksti: arvo voi olla merkkijono tai `{#text, @_xml:lang}`-objekti. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && value !== null) return text(asRecord(value)['#text']);
  return undefined;
}

function toNullableText(value: unknown): string | null {
  return text(value) ?? null;
}

function toNumber(value: unknown): number | null {
  const raw = text(value);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export interface ParsedSiriFeed {
  /** Walttin tuotantoaika (`ResponseTimestamp`), UTC-ISO tai null. */
  generatedAt: string | null;
  vehicles: SiriVehicle[];
}

/**
 * Jäsentää SIRI VehicleMonitoring -vastauksen.
 *
 * Ajoneuvo ohitetaan, jos sen tunniste, linja, sijainti tai havaintoaika
 * puuttuu — puutteellisella rivillä ei ole kartalla mitään järkevää esitystapaa.
 */
export function parseSiriVehicleMonitoring(xml: string): ParsedSiriFeed {
  const delivery = asRecord(
    asRecord(asRecord(asRecord(parser.parse(xml))['Siri'])['ServiceDelivery'])[
      'VehicleMonitoringDelivery'
    ],
  );
  const generatedAt = toUtcIso(text(delivery['ResponseTimestamp']));

  const vehicles: SiriVehicle[] = [];
  for (const entry of toArray(delivery['VehicleActivity'])) {
    const activity = asRecord(entry);
    const journey = asRecord(activity['MonitoredVehicleJourney']);
    const location = asRecord(journey['VehicleLocation']);

    const vehicleId = text(journey['VehicleRef']);
    const line = text(journey['LineRef']);
    const latitude = toNumber(location['Latitude']);
    const longitude = toNumber(location['Longitude']);
    const recordedAt = toUtcIso(text(activity['RecordedAtTime']));
    if (!vehicleId || !line || latitude === null || longitude === null || !recordedAt) continue;

    vehicles.push({
      vehicleId,
      line,
      operatorRef: toNullableText(journey['OperatorRef']),
      destination: toNullableText(journey['DestinationName']),
      origin: toNullableText(journey['OriginName']),
      direction: toNumber(journey['DirectionRef']),
      latitude,
      longitude,
      bearing: toNumber(journey['Bearing']),
      delaySeconds: parseIsoDurationSeconds(text(journey['Delay'])),
      recordedAt,
    });
  }

  return { generatedAt, vehicles };
}

/**
 * Jäsentää syötteen siivotusta dokumentista ja tarvittaessa koko dokumentista.
 *
 * `parse`-parametri on injektoitavissa, jotta varajärjestely on yksikkötestattavissa.
 */
export function parseSiriFeed(
  xml: string,
  parse: (document: string) => ParsedSiriFeed = parseSiriVehicleMonitoring,
): ParsedSiriFeed {
  const fromStripped = parse(stripOnwardCalls(xml));
  if (fromStripped.vehicles.length > 0) return fromStripped;
  return parse(xml);
}
