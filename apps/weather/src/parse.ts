/**
 * FMI WaterML 2.0 -jäsennys (arkkitehtuuri §31).
 *
 * FMI:n WFS palauttaa `fmi::observations::weather::timevaluepair`-kyselystä
 * WaterML 2.0 -XML:ää, jossa **jokainen parametri on oma `wfs:member`**:
 *
 *   <wfs:member>
 *     <omso:PointTimeSeriesObservation>
 *       <om:observedProperty xlink:href="…&param=temperature&…"/>
 *       <om:featureOfInterest>… <gml:identifier>101118</gml:identifier> …
 *         <gml:name codeSpace="…locationcode/name">Pirkkala Tampere-Pirkkala lentoasema</gml:name>
 *         <gml:pos>61.41940 23.62256 </gml:pos> …</om:featureOfInterest>
 *       <om:result><wml2:MeasurementTimeseries>
 *         <wml2:point><wml2:MeasurementTVP>
 *           <wml2:time>2026-10-01T16:50:00Z</wml2:time>
 *           <wml2:value>11.8</wml2:value>
 *         </wml2:MeasurementTVP></wml2:point> …
 *       </wml2:MeasurementTimeseries></om:result>
 *     </omso:PointTimeSeriesObservation>
 *   </wfs:member>
 *
 * **Puuttuva arvo on `<wml2:value>NaN</wml2:value>`** — se ei ole nolla eikä
 * nollan sijainen. Jäsennys poimii kustakin parametrista **viimeisimmän
 * ei-puuttuvan** havainnon; puuttuva jää kokonaan pois (§20: aikaleimoja ja
 * arvoja ei koskaan arvata).
 */

import { XMLParser } from 'fast-xml-parser';

/** FMI WFS -havaintoparametrit, joita Tampere 247 käyttää (WFS-nimet). */
export const FMI_PARAMETERS = [
  'temperature',
  'windspeedms',
  'windgust',
  'winddirection',
  'humidity',
  'pressure',
  'precipitation1h',
  'n_man',
] as const;

export type FmiParameter = (typeof FMI_PARAMETERS)[number];

const PARAMETER_SET: ReadonlySet<string> = new Set(FMI_PARAMETERS);

/** Onko WFS-parametrinimi yksi tuetuista. */
export function isFmiParameter(value: string): value is FmiParameter {
  return PARAMETER_SET.has(value);
}

/** Havaintoasema, luettuna ensimmäisestä datamemberistä. */
export interface ParsedStation {
  fmisid: string | null;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ParsedWeather {
  station: ParsedStation;
  /** Viimeisin arvo per parametri (vain ei-puuttuvat). */
  values: Partial<Record<FmiParameter, number>>;
  /** Viimeisimmän havainnon aika (UTC ISO) tai null. */
  observedAt: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Namespace-etuliitteet pois: `wml2:value` → `value`, `xlink:href` → `@_href`.
  removeNSPrefix: true,
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

function asArray(value: unknown): XmlNode[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is XmlNode => typeof item === 'object' && item !== null);
  }
  if (value && typeof value === 'object') return [value as XmlNode];
  return [];
}

function asNode(value: unknown): XmlNode | null {
  return value && typeof value === 'object' ? (value as XmlNode) : null;
}

/** Tekstisisältö merkkijonona (myös `{'#text': …}`-muodosta) tai null. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  const node = asNode(value);
  if (node && '#text' in node) return text(node['#text']);
  return null;
}

/** `observedProperty`-href: `…&param=temperature&…` → `temperature`. */
export function parameterFromHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const match = /[?&]param=([A-Za-z0-9_]+)/.exec(href);
  return match?.[1] ?? null;
}

/** Numeerinen arvo tai null, kun arvo on tyhjä tai `NaN`. */
export function numericValue(value: unknown): number | null {
  const raw = text(value);
  if (!raw || raw.toLowerCase() === 'nan') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function toDateMs(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Kerää kaikki `tag`-nimiset jälkeläiset myös syvemmältä kuin suorat lapset.
 *
 * FMI:n WaterML:ssa asematiedot **eivät ole `featureOfInterest`in suoria
 * lapsia**, vaan esim:
 *
 *   featureOfInterest → SF_SpatialSamplingFeature → sampledFeature →
 *   LocationCollection → member → Location → gml:identifier
 *
 * ja koordinaatti: `… → SF_SpatialSamplingFeature → shape → gml:Point → gml:pos`.
 * Siksi haku tehdään rekursiivisesti.
 */
function collectByTag(node: XmlNode, tag: string, out: unknown[] = []): unknown[] {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    if (key === tag) {
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
    for (const child of asArray(value)) collectByTag(child, tag, out);
  }
  return out;
}

function readStation(feature: XmlNode | null): ParsedStation {
  const station: ParsedStation = { fmisid: null, name: null, latitude: null, longitude: null };
  if (!feature) return station;

  station.fmisid = text(collectByTag(feature, 'identifier')[0]);

  const pos = text(collectByTag(feature, 'pos')[0]);
  if (pos) {
    const [lat, lon] = pos.split(/\s+/);
    station.latitude = numericValue(lat);
    station.longitude = numericValue(lon);
  }

  // gml:name esiintyy useita kertoja (fmisid, geoid, wmo, nimi). Virallinen
  // nimi tunnistetaan codeSpace-arvosta; varalla otetaan ensimmäinen ei-tyhjä.
  for (const nameNode of collectByTag(feature, 'name')) {
    const value = text(nameNode);
    if (!value) continue;
    const codeSpace = asNode(nameNode)?.['@_codeSpace'];
    if (typeof codeSpace === 'string' && codeSpace.includes('locationcode/name')) {
      station.name = value;
    } else if (!station.name) {
      station.name = value;
    }
  }

  return station;
}

/**
 * Jäsentää WaterML 2.0 -vasteen. Palauttaa tyhjän rakenteen, jos datamembereitä
 * ei ole — tyhjä vastaus ei ole virhe vaan tieto (sääkortti jää tyhjäksi).
 */
export function parseTimeValuePairs(xml: string): ParsedWeather {
  const document = parser.parse(xml) as XmlNode;
  const collection = asNode(document['FeatureCollection']);

  const station: ParsedStation = { fmisid: null, name: null, latitude: null, longitude: null };
  const values: Partial<Record<FmiParameter, number>> = {};
  const chosenMs: Partial<Record<FmiParameter, number>> = {};
  let observedAt: string | null = null;
  let observedAtMs = 0;

  for (const member of asArray(collection?.['member'])) {
    const observation = asNode(member['PointTimeSeriesObservation']);
    if (!observation) continue;

    const param = parameterFromHref(asNode(observation['observedProperty'])?.['@_href']);
    if (!param || !isFmiParameter(param)) continue;

    // Asematiedot toistuvat jokaisessa jäsenessä → luetaan kerran.
    if (!station.fmisid) {
      Object.assign(station, readStation(asNode(observation['featureOfInterest'])));
    }

    const series = asNode(asNode(observation['result'])?.['MeasurementTimeseries']);
    for (const point of asArray(series?.['point'])) {
      const tvp = asNode(point['MeasurementTVP']);
      if (!tvp) continue;

      const value = numericValue(tvp['value']);
      if (value === null) continue;

      const time = text(tvp['time']);
      const ms = toDateMs(time);
      if (ms >= (chosenMs[param] ?? -1)) {
        chosenMs[param] = ms;
        values[param] = value;
        if (time && ms >= observedAtMs) {
          observedAtMs = ms;
          observedAt = time;
        }
      }
    }
  }

  return { station, values, observedAt };
}
