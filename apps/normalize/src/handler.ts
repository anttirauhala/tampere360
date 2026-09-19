/**
 * normalize — normalisointi-Lambda (arkkitehtuuri §2–3).
 * Tukee FMI_CAP, TAMPERE_TRAFFIC, VISIT_TAMPERE, NYSSE_ALERTS, POLICE_RSS.
 */

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { createLogger } from '@tampere360/observability';
import { sha256Hex, ulid } from '@tampere360/source-adapter-sdk';
import type {
  GeoJsonGeometry,
  IngestMessage,
  LocationMethod,
  Tampere360Event,
} from '@tampere360/event-contracts';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

const logger = createLogger({ service: 'normalize', environment: process.env['ENVIRONMENT'] ?? 'dev' });
const eventbridge = new EventBridgeClient({});

/** Pirkanmaan kunnat (kuntanimi → aluekoodit). */
const PIRKANMAA_MUNICIPALITIES = new Set([
  'Nokia', 'Pirkkala', 'Ylöjärvi', 'Lempäälä', 'Kangasala', 'Vesilahti',
  'Akaa', 'Valkeakoski', 'Sastamala', 'Ikaalinen', 'Parkano', 'Ruovesi',
  'Mänttä-Vilppula', 'Urjala', 'Hämeenkyrö', 'Juupajoki', 'Kihniö',
  'Kuhmoinen', 'Orivesi', 'Punkalaidun', 'Virrat',
]);

/**
 * Muuntaa kunnan nimen validiksi areaCodes-listaksi (AreaLevel-enum).
 * Tampere → TAMPERE + seutu + maakunta; muu Pirkanmaa → seutu + maakunta.
 */
function areaCodesFor(municipality: string | null | undefined): string[] {
  if (!municipality) return ['TAMPERE', 'PIRKANMAA'];
  if (municipality === 'Tampere') return ['TAMPERE', 'TAMPERE_REGION', 'PIRKANMAA'];
  if (PIRKANMAA_MUNICIPALITIES.has(municipality)) return ['TAMPERE_REGION', 'PIRKANMAA'];
  return ['PIRKANMAA'];
}

/** Sallitut GeoJSON-geometriatyypit (ks. GeoJsonGeometry). */
const GEOMETRY_TYPES = ['Point', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];

/** Kerää kaikki [lon, lat]-parit mistä tahansa GeoJSON-koordinaattirakenteesta. */
function collectPositions(input: unknown, out: [number, number][] = []): [number, number][] {
  if (!Array.isArray(input)) return out;
  const [first, second] = input as unknown[];
  if (typeof first === 'number' && typeof second === 'number') {
    out.push([first, second]);
    return out;
  }
  for (const item of input) collectPositions(item, out);
  return out;
}

/**
 * Poimii lähteen oman GeoJSON-geometrian ja laskee sitä vastaavan sijainnin.
 *
 * Digitraffic antaa osalle ilmoituksista Point- ja osalle LineString-geometrian
 * (tiejakso). Viivalle ja alueelle käytetään pisteiden keskipistettä — se on
 * lähdeaineiston keskikohta, ei tekstistä geokoodattu arvio (§5).
 */
function sourceGeometry(raw: Record<string, unknown> | undefined): {
  geometry: GeoJsonGeometry | null;
  latitude: number | null;
  longitude: number | null;
} {
  const geom = raw?.['geometry'] as { type?: unknown; coordinates?: unknown } | undefined;
  const type = typeof geom?.type === 'string' ? geom.type : null;
  if (!type || !GEOMETRY_TYPES.includes(type) || !Array.isArray(geom?.coordinates)) {
    return { geometry: null, latitude: null, longitude: null };
  }
  const positions = collectPositions(geom.coordinates);
  if (positions.length === 0) return { geometry: null, latitude: null, longitude: null };

  let sumLon = 0;
  let sumLat = 0;
  for (const p of positions) {
    sumLon += p[0];
    sumLat += p[1];
  }
  const round = (n: number) => Number(n.toFixed(6));
  return {
    geometry: { type, coordinates: geom.coordinates } as unknown as GeoJsonGeometry,
    latitude: round(sumLat / positions.length),
    longitude: round(sumLon / positions.length),
  };
}

function mapRawToFields(source: string, raw: Record<string, unknown> | undefined) {
  if (source === 'FMI_CAP') {
    const s = String(raw?.severity ?? '').toLowerCase();
    const severity = s === 'extreme' ? 'CRITICAL' : s === 'severe' ? 'MAJOR' : s === 'moderate' ? 'MINOR' : 'INFO';
    return {
      type: 'WEATHER_WARNING' as const, category: 'WEATHER' as const, severity,
      title: { fi: String(raw?.event ?? 'Säävaroitus') },
      description: raw?.description ? { fi: String(raw.description) } : undefined,
      attribution: { name: 'Ilmatieteen laitos', required: true },
      areaCodes: ['PIRKANMAA'] as string[],
      validity: { startsAt: raw?.onset ? String(raw.onset) : null, endsAt: raw?.expires ? String(raw.expires) : null },
      location: null,
      // CAP antaa alueen (PIRKANMAA), ei pistekoordinaattia.
      locationMethod: 'SOURCE_AREA' as const,
    };
  }
  if (source === 'TAMPERE_TRAFFIC') {
    // Digitraffic on GeoJSON: kentät ovat properties-kääreen sisällä.
    // Tuetaan molempia muotoja (properties-wrapperi tai suora).
    const props = ((raw?.properties ?? raw) ?? {}) as Record<string, unknown>;
    const st = String(props.situationType ?? props.trafficAnnouncementType ?? '');
    const type = st.toLowerCase().includes('roadwork') ? 'ROADWORK' as const : 'TRAFFIC_INCIDENT' as const;
    const anns = Array.isArray(props.announcements) ? (props.announcements as Record<string, unknown>[]) : [];
    const ann = (anns[0] ?? {}) as Record<string, unknown>;
    const title = ann.title ? String(ann.title).trim() : 'Liikennetapahtuma';
    const locDetails = ann.locationDetails as Record<string, unknown> | undefined;
    const roadLoc = locDetails?.roadAddressLocation as Record<string, unknown> | undefined;
    const primary = roadLoc?.primaryPoint as Record<string, unknown> | undefined;
    const secondary = roadLoc?.secondaryPoint as Record<string, unknown> | undefined;
    const municipality = (primary?.municipality as string | undefined) ?? (secondary?.municipality as string | undefined) ?? null;
    const td = ann.timeAndDuration as Record<string, unknown> | undefined;

    // Digitraffic v2 on GeoJSON: geometria on feature-tasolla (Point tai
    // LineString). Lähdekoordinaatti → SOURCE_COORDINATE; ilman geometriaa
    // jäädään alueeseen → SOURCE_AREA (§5).
    const geomSource = (raw?.['geometry'] ? raw : props) as Record<string, unknown>;
    const { geometry: point, latitude, longitude } = sourceGeometry(geomSource);
    const locationMethod: LocationMethod =
      latitude !== null ? 'SOURCE_COORDINATE' : 'SOURCE_AREA';

    // Vakavuus: suljettu tie / kiertotie / onnettomuus → MAJOR, muuten MINOR
    const featureNames = Array.isArray(ann.features)
      ? (ann.features as Record<string, unknown>[]).map((f) => String(f.name ?? '')).join(' ')
      : '';
    const text = `${title} ${featureNames}`.toLowerCase();
    const severity = /suljettu|onnettomuus|kiertotie|vakava/.test(text) ? 'MAJOR' : 'MINOR';

    return {
      type, category: 'TRAFFIC' as const, severity,
      title: { fi: title },
      description: ann.comment ? { fi: String(ann.comment) } : undefined,
      attribution: {
        // Ilmoituksen lähettäjä (esim. Tampereen kaupunki) on ensisijainen
        // attribuution lähde; Digitraffic on jakelukanava.
        name: ann.sender ? String(ann.sender) : 'Fintraffic / Digitraffic',
        required: true,
        url: 'https://www.digitraffic.fi',
      },
      areaCodes: areaCodesFor(municipality),
      location: { municipality, latitude, longitude, geometry: point },
      locationMethod,
      validity: {
        startsAt: td?.startTime ? String(td.startTime) : null,
        endsAt: td?.endTime ? String(td.endTime) : null,
      },
    };
  }
  if (source === 'VISIT_TAMPERE') {
    return {
      type: 'PUBLIC_EVENT' as const, category: 'EVENT' as const, severity: 'INFO',
      title: { fi: String(raw?.name ?? 'Tapahtuma') },
      description: raw?.description ? { fi: String(raw.description) } : undefined,
      attribution: { name: 'Visit Tampere', required: true },
      areaCodes: ['TAMPERE'],
      location: { municipality: 'Tampere', latitude: null, longitude: null },
      locationMethod: 'SOURCE_AREA' as const,
      validity: { startsAt: raw?.startDate ? String(raw.startDate) : null, endsAt: raw?.endDate ? String(raw.endDate) : null },
    };
  }
  if (source === 'NYSSE_ALERTS') {
    const routeInfo = raw?.routeIds ? (raw.routeIds as string[]).join(', ') : '';
    return {
      type: 'TRANSIT_DISRUPTION' as const, category: 'PUBLIC_TRANSPORT' as const,
      severity: 'MINOR',
      title: { fi: String(raw?.header ?? 'Joukkoliikennehäiriö') + (routeInfo ? ` (${routeInfo})` : '') },
      description: raw?.description ? { fi: String(raw.description) } : undefined,
      attribution: { name: 'Nysse', required: true },
      areaCodes: ['TAMPERE'] as string[],
      location: { municipality: 'Tampere', latitude: null, longitude: null },
      locationMethod: 'SOURCE_AREA' as const,
      validity: { startsAt: raw?.effectiveStart ? String(raw.effectiveStart) : null, endsAt: raw?.effectiveEnd ? String(raw.effectiveEnd) : null },
    };
  }
  if (source === 'POLICE_RSS') {
    const title = String(raw?.title ?? '');
    // Yksinkertainen päättely: onko otsikossa vakava = MAJOR, muuten INFO
    const isMajor = /vakava|kuoli|kadonnut|etsitään|puukko|ase/i.test(title);
    return {
      type: 'POLICE_ANNOUNCEMENT' as const, category: 'POLICE' as const,
      severity: isMajor ? 'MAJOR' : 'INFO',
      title: { fi: title },
      description: raw?.description ? { fi: String(raw.description).replace(/<[^>]*>/g, '') } : undefined,
      attribution: { name: 'Sisä-Suomen poliisilaitos', required: true, url: 'https://poliisi.fi' },
      areaCodes: ['TAMPERE'] as string[],
      location: { municipality: null, latitude: null, longitude: null },
      // Poliisitiedotteessa ei ole koordinaattia — geokoodaus on myöhempi vaihe (§7).
      locationMethod: 'SOURCE_AREA' as const,
      validity: null,
    };
  }
  return {
    type: 'OTHER' as const, category: 'EVENT' as const, severity: 'INFO',
    title: { fi: String(raw?.name ?? String(raw?.title ?? 'Tapahtuma')) },
    attribution: { name: source, required: false },
    location: null, validity: null, areaCodes: [],
  };
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failIds: string[] = [];
  for (const record of event.Records) {
    const messageId = record.messageId;
    let ingestMessage: IngestMessage;
    try { ingestMessage = JSON.parse(record.body) as IngestMessage; } catch { failIds.push(messageId); continue; }
    if (!ingestMessage.events?.length) continue;
    for (const parsedEvent of ingestMessage.events) {
      try {
        const raw = parsedEvent.raw as Record<string, unknown> | undefined;
        const contentHash = sha256Hex(JSON.stringify(raw ?? {}));
        const now = new Date().toISOString();
        const eventId = ulid();
        const m = mapRawToFields(parsedEvent.source, raw);
        const locationMethod = 'locationMethod' in m ? m.locationMethod : undefined;
        const normalized: Tampere360Event = {
          schemaVersion: '1.0', id: eventId,
          canonicalKey: `${parsedEvent.source}:${parsedEvent.sourceId}`,
          processingKey: parsedEvent.processingKey,
          source: { system: parsedEvent.source, sourceId: parsedEvent.sourceId, fetchedAt: ingestMessage.batch.fetchedAt },
          type: m.type as Tampere360Event['type'],
          category: m.category as Tampere360Event['category'],
          severity: m.severity as Tampere360Event['severity'],
          status: 'ACTIVE', lifecycle: 'ACTIVE',
          title: m.title, description: m.description,
          location: {
            municipality: m.location?.municipality ?? null, district: null, address: null,
            latitude: m.location?.latitude ?? null, longitude: m.location?.longitude ?? null,
            geometry: m.location?.geometry ?? null,
            areaCodes: (m.areaCodes ?? []) as Tampere360Event['location']['areaCodes'],
          },
          validity: { startsAt: m.validity?.startsAt ?? null, endsAt: m.validity?.endsAt ?? null },
          publishedAt: now, updatedAt: now, tags: [],
          attribution: m.attribution, contentHash,
          ...(locationMethod ? { locationMethod } : {}),
        };
        await eventbridge.send(new PutEventsCommand({
          Entries: [{
            EventBusName: process.env['EVENT_BUS_NAME'] ?? 'tampere360-dev-events',
            Source: 'tampere360', DetailType: 'SourceEventNormalized',
            Detail: JSON.stringify({ event: normalized, batchId: ingestMessage.batch.batchId, occurredAt: now }),
          }],
        }));
        logger.info('Normalisoitu', { source: parsedEvent.source, type: m.type });
      } catch {
        failIds.push(messageId);
      }
    }
  }
  return { batchItemFailures: [...new Set(failIds)].map((id) => ({ itemIdentifier: id })) };
}
