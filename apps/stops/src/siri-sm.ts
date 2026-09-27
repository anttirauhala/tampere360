/**
 * Walttin SIRI **StopMonitoring** -pyyntö ja -vastauksen jäsennys (arkkitehtuuri §28).
 *
 * Sama päätepiste kuin ajoneuvomonitoroinnissa (`POST .../sirirealtime/v1.3/ws`)
 * mutta eri pyyntöelementti. Pyyntö on dokumentoitu Nyssen kehittäjäportaalissa
 * (dev.publictransport.tampere.fi/docs → "Siri - Stop Monitoring"), ja
 * **`PreviewInterval` on pakollinen**: ilman sitä Walttin yhdyskäytävä vastaa
 * HTTP 406. Dokumentoidut rajat ja aikataulut:
 *
 *  - enintään 100 pysäkkiä yhdessä pyynnössä (yksi `StopMonitoringRequest`
 *    jokaiselle pysäkille)
 *  - päivitysväli 30 s ("Stop calls are estimated with accuracy of one minute"),
 *    minkä vuoksi vastauksen `ValidUntil` on ~30 s pyynnön hetkestä
 *
 * Vastaus on XML: `<StopMonitoringDelivery><MonitoredStopVisit>…`, jossa
 * jokainen `MonitoredStopVisit` on yksi vuoro matkalla pyydetylle pysäkille.
 * `<OnwardCalls>`-lohko (vuoron kaikki seuraavat pysäkit) leikataan pois ennen
 * jäsennystä — se on vastauksen suurin osa eikä sisällä pysäkin lähtötietoja.
 */

import { XMLParser } from 'fast-xml-parser';

import type { ParsedStopMonitoring, SiriStopVisit } from './types';

/** Walttin dokumentoitu SIRI-päätepiste (POST, Basic-auth) — sama kuin §27:ssä. */
export const SIRI_URL = 'https://data.waltti.fi/tampere/api/sirirealtime/v1.3/ws';

/**
 * Walttin SIRI-vastauksen virheellinen tilakoodi.
 *
 * Statuskoodi kuljetetaan olion mukana, jotta kutsuja voi päättää uusinnasta
 * (`retry.ts`): 5xx = tilapäinen, 4xx = oma pyyntö on väärä. Runko leikataan
 * talteen lyhyenä, koska se on diagnostiikkaa varten (`Something went wrong`).
 */
export class SiriUpstreamError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Waltti SIRI SM vastasi ${status}`);
    this.name = 'SiriUpstreamError';
    this.status = status;
    this.body = body.trim().slice(0, 120);
  }
}

/** Dokumentoitu enimmäismäärä pysäkkejä yhdessä pyynnössä. */
export const SIRI_MAX_STOPS_PER_REQUEST = 100;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Arvot merkkijonoina: linjanumero "8A" ei saa muuttua, eikä "0015" pudottaa
  // etunolliaan numeroksi 15 (tunniste on merkkijono myös GTFS:ssä).
  parseTagValue: false,
  parseAttributeValue: false,
});

/** Poistaa `<OnwardCalls>`-lohkot ennen jäsennystä (ks. tiedoston yläkommentti). */
export function stripOnwardCalls(xml: string): string {
  return xml.replace(/<OnwardCalls\b[\s\S]*?<\/OnwardCalls>/g, '');
}

/** XML-escape arvolle, joka upotetaan pyyntöön (pysäkkitunniste). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Rakentaa StopMonitoring-pyynnön.
 *
 * `stopIds` on jo validoitu (`params.ts`) ja arvot escapetaan tässä — näin
 * virheellinen tunniste ei voi rikkoa XML-rakennetta kummastakaan syystä.
 * Tyhjä lista on ohjelmointivirhe eikä käyttäjän syöte, joten se heittää.
 */
export function buildStopMonitoringRequest(stopIds: string[], previewMinutes: number): string {
  if (stopIds.length === 0) throw new Error('StopMonitoring-pyyntö vaatii vähintään yhden pysäkin');
  if (stopIds.length > SIRI_MAX_STOPS_PER_REQUEST) {
    throw new Error(`StopMonitoring tukee enintään ${SIRI_MAX_STOPS_PER_REQUEST} pysäkkiä/pyyntö`);
  }

  const interval = `PT${Math.max(1, Math.round(previewMinutes))}M00S`;
  const requests = stopIds
    .map(
      (id) =>
        '<StopMonitoringRequest version="1.3">' +
        `<PreviewInterval>${interval}</PreviewInterval>` +
        `<MonitoringRef>${escapeXml(id)}</MonitoringRef>` +
        '</StopMonitoringRequest>',
    )
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Siri xmlns="http://www.siri.org.uk/siri" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'version="1.3" xsi:schemaLocation="http://www.kizoom.com/standards/siri/schema/1.3/siri.xsd">' +
    `<ServiceRequest>${requests}</ServiceRequest></Siri>`
  );
}

/** ISO 8601 -kesto sekunteina (`Delay`), esim. `P0Y0M0DT0H1M30S` → 90. */
export function parseIsoDurationSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match =
    /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      raw.trim(),
    );
  if (!match) return null;
  const [, sign, years, months, days, hours, minutes, seconds] = match;
  // Vuosia ja kuukausia ei voi muuntaa sekunneiksi. SIRI kirjoittaa
  // nollakomponentit näkyviin (`P0Y0M0DT0H0M0.000S` = "ei poikkeamaa"), joten
  // pelkkä kentän olemassaolo ei riitä — arvon on oltava nollasta poikkeava.
  if (Number(years ?? 0) > 0 || Number(months ?? 0) > 0) return null;
  if (!days && !hours && !minutes && !seconds) return null;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return sign ? -total : total;
}

/** Normalisoi lähdeajan UTC-ISO-muotoon (Waltti antaa `+03:00`-siirtymän). */
export function toUtcIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** SIRI-elementin teksti: arvo voi olla merkkijono tai `{#text, @_xml:lang}`. */
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

/** SIRI:n totuusarvo (`true`/`false` merkkijonona). */
function toBoolean(value: unknown): boolean {
  return text(value)?.toLowerCase() === 'true';
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Jäsentää StopMonitoring-vastauksen.
 *
 * Vuoro ohitetaan, jos pysäkkitunniste tai linja puuttuu — puutteellisella
 * rivillä ei ole pysäkkimonitorissa mitään järkevää esitystapaa.
 */
export function parseStopMonitoring(xml: string): ParsedStopMonitoring {
  const delivery = asRecord(
    asRecord(asRecord(asRecord(parser.parse(xml))['Siri'])['ServiceDelivery'])[
      'StopMonitoringDelivery'
    ],
  );

  const generatedAt = toUtcIso(text(delivery['ResponseTimestamp']));
  const validUntil = toUtcIso(text(delivery['ValidUntil']));

  const visits: SiriStopVisit[] = [];
  for (const entry of toArray(delivery['MonitoredStopVisit'])) {
    const visit = asRecord(entry);
    const journey = asRecord(visit['MonitoredVehicleJourney']);
    const call = asRecord(journey['MonitoredCall']);

    const stopId = text(visit['MonitoringRef']);
    const line = text(journey['LineRef']);
    if (!stopId || !line) continue;

    visits.push({
      recordedAt: toUtcIso(text(visit['RecordedAtTime'])),
      stopId,
      line,
      destination: toNullableText(journey['DestinationName']),
      origin: toNullableText(journey['OriginName']),
      stopName: toNullableText(visit['StopVisitNote']),
      realtime: toBoolean(journey['Monitored']),
      delaySeconds: parseIsoDurationSeconds(text(journey['Delay'])),
      aimedArrivalTime: toUtcIso(text(call['AimedArrivalTime'])),
      aimedDepartureTime: toUtcIso(text(call['AimedDepartureTime'])),
      expectedArrivalTime: toUtcIso(text(call['ExpectedArrivalTime'])),
      expectedDepartureTime: toUtcIso(text(call['ExpectedDepartureTime'])),
      vehicleAtStop: toBoolean(call['VehicleAtStop']),
    });
  }

  return { generatedAt, validUntil, visits };
}

/**
 * Jäsentää syötteen siivotusta dokumentista ja tarvittaessa koko dokumentista.
 *
 * Jos siivottu dokumentti ei tuota yhtään vuoroa, jäsennetään koko dokumentti —
 * näin lähdemuutos (esim. `<OnwardCalls>`-rakenteen muuttuminen) ei muutu
 * hiljaiseksi tyhjäksi pysäkkimonitoriksi.
 */
export function parseStopMonitoringFeed(
  xml: string,
  parse: (document: string) => ParsedStopMonitoring = parseStopMonitoring,
): ParsedStopMonitoring {
  const fromStripped = parse(stripOnwardCalls(xml));
  if (fromStripped.visits.length > 0) return fromStripped;
  return parse(xml);
}
