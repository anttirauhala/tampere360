import { XMLParser } from 'fast-xml-parser';
import type { Severity } from '@tampere360/event-contracts';

/** Jäsennetty tieto yhdestä CAP-varoituksesta. */
export interface ParsedCapAlert {
  /** CAP-tunniste (urn:oid:...) -> lähdetunniste */
  identifier: string;
  /** Milloin varoitus on lähetetyt */
  sent: string;
  /** Varotuksen nimi */
  event: string;
  /** Vakavuus: Minor/Moderate/Severe/Extreme */
  severity: string;
  /** Varmuus: Observed/Likely/Possible/Unlikely */
  certainty: string;
  /** Kiirellisyys: Immediate/Expected/Future/Past */
  urgency: string;
  /** Aikaleimat */
  effective?: string;
  onset?: string;
  expires?: string;
  /** Kuvaus */
  description?: string;
  /** Toimintaohje */
  instruction?: string;
  /** Alueiden nimet (AreaDesc) */
  areas: { description: string; polygon?: string }[];
  /** Onko varoitus relevantti Tampere/Pirkanmaa-seudulla */
  relevantForTampereRegion: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

interface RssItem {
  title?: string;
  link?: string;
  description?: string;
  guid?: { '#text': string } | string;
  pubDate?: string;
  author?: string;
  category?: string;
}

/**
 * Jäsentää RSS-syötteen ja palauttaa itemit, joista
 * voidaan edetä CAP-XML:n noutamiseen.
 */
export function parseRssFeed(xml: string): RssItem[] {
  const doc = parser.parse(xml);
  const rss = doc?.rss;
  if (!rss?.channel?.item) return [];
  const items = Array.isArray(rss.channel.item) ? rss.channel.item : [rss.channel.item];
  return items.map((item: Record<string, unknown>) => ({
    title: item.title as string | undefined,
    link: item.link as string | undefined,
    description: item.description as string | undefined,
    guid: item.guid as RssItem['guid'],
    pubDate: item.pubDate as string | undefined,
    category: item.category as string | undefined,
  }));
}

/**
 * Jäsentää CAP 1.2 -XML-dokumentin
 */
export function parseCapXml(xml: string): ParsedCapAlert | null {
  try {
    const doc = parser.parse(xml);
    const alert = doc?.alert;
    if (!alert) return null;

    const info = Array.isArray(alert.info) ? alert.info[0] : alert.info;
    if (!info) return null;

    const areas: { description: string; polygon?: string }[] = [];
    if (info.area) {
      const areaArr = Array.isArray(info.area) ? info.area : [info.area];
      for (const area of areaArr) {
        areas.push({
          description: (area.areaDesc ?? '') as string,
          polygon: area.polygon as string | undefined,
        });
      }
    }

    const relevantForTampereRegion = areas.some((a) =>
      /Pirkanmaa|Tampere|Tamperee/i.test(a.description),
    );

    return {
      identifier: alert.identifier as string,
      sent: alert.sent as string,
      event: (info.event ?? '') as string,
      severity: (info.severity ?? '') as string,
      certainty: (info.certainty ?? '') as string,
      urgency: (info.urgency ?? '') as string,
      effective: info.effective as string | undefined,
      onset: info.onset as string | undefined,
      expires: info.expires as string | undefined,
      description: info.description as string | undefined,
      instruction: info.instruction as string | undefined,
      areas,
      relevantForTampereRegion,
    };
  } catch {
    return null;
  }
}

/**
 * Muuntaa CAP-vakavuuden omaksi Severity-enumeratioksi
 */
export function capSeverityToInternal(capSeverity: string): Severity {
  switch (capSeverity.toLowerCase()) {
    case 'extreme':
      return 'CRITICAL';
    case 'severe':
      return 'MAJOR';
    case 'moderate':
      return 'MINOR';
    default:
      return 'INFO';
  }
}

/**
 * Muuntaa CAP-varoituksen tyypiksi EventType
 */
export function capEventToType(capEvent: string): string {
  const e = capEvent.toLowerCase();
  if (e.includes('tuuli') || e.includes('myrsky')) return 'WEATHER_WARNING';
  if (e.includes('ukkonen') || e.includes('sade')) return 'WEATHER_WARNING';
  if (e.includes('lumi') || e.includes('jää')) return 'WEATHER_WARNING';
  if (e.includes('metsäpalo')) return 'WEATHER_WARNING';
  return 'WEATHER_WARNING'; // oletus
}

/** CAP-varoituksesta status. */
export function capStatusToInternal(capStatus?: string): string {
  if (!capStatus) return 'ACTIVE';
  switch (capStatus.toUpperCase()) {
    case 'ACTUAL':
    case 'EXERCISE':
      return 'ACTIVE';
    case 'CANCEL':
    case 'EXCERSISE':
      return 'CANCELLED';
    case 'END':
      return 'ENDED';
    default:
      return 'ACTIVE';
  }
}
