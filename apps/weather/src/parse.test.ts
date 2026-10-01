import { describe, expect, it } from 'vitest';

import { numericValue, parameterFromHref, parseTimeValuePairs } from './parse';

/**
 * Testifixtuurit jäljittelevät FMI:n aitoa WaterML 2.0 -rakennetta
 * (verifioitu 1.10.2026, ks. parse.ts:n dokumentaatio): jokainen parametri on
 * oma `wfs:member`, jonka `observedProperty`-href kertoo parametrin ja
 * `MeasurementTimeseries` aikasarjan.
 */
function member(
  param: string,
  points: Array<[string, string]>,
  station = {
    id: '101118',
    name: 'Pirkkala Tampere-Pirkkala lentoasema',
    pos: '61.41940 23.62256 ',
  },
): string {
  const tvps = points
    .map(
      ([time, value]) =>
        `<wml2:point><wml2:MeasurementTVP><wml2:time>${time}</wml2:time><wml2:value>${value}</wml2:value></wml2:MeasurementTVP></wml2:point>`,
    )
    .join('');

  // Rakenne jäljittelee FMI:n aitoa WaterML:aa: asematiedot ovat syvällä
  // `SF_SpatialSamplingFeature`issa, eivät `featureOfInterest`in suoria lapsia.
  // `parameter/NamedValue/name` on mukana harhautuksena — sitä ei saa lukea.
  return (
    '<wfs:member><omso:PointTimeSeriesObservation>' +
    `<om:observedProperty xlink:href="https://opendata.fmi.fi/meta?observableProperty=observation&amp;param=${param}&amp;language=eng"/>` +
    '<om:parameter><om:NamedValue><om:name>ei aseman nimi</om:name></om:NamedValue></om:parameter>' +
    '<om:featureOfInterest><sam:SF_SpatialSamplingFeature>' +
    '<sam:sampledFeature><ompr:LocationCollection><wfs:member><ompr:Location>' +
    `<gml:identifier codeSpace="http://xml.fmi.fi/namespace/stationcode/fmisid">${station.id}</gml:identifier>` +
    '<gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/geoid">-16000006</gml:name>' +
    `<gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">${station.name}</gml:name>` +
    '</ompr:Location></wfs:member></ompr:LocationCollection></sam:sampledFeature>' +
    `<sam:shape><gml:Point><gml:pos>${station.pos}</gml:pos></gml:Point></sam:shape>` +
    '</sam:SF_SpatialSamplingFeature></om:featureOfInterest>' +
    `<om:result><wml2:MeasurementTimeseries>${tvps}</wml2:MeasurementTimeseries></om:result>` +
    '</omso:PointTimeSeriesObservation></wfs:member>'
  );
}

function collection(...members: string[]): string {
  return (
    '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" ' +
    'xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:om="http://www.opengis.net/om/2.0" ' +
    'xmlns:omso="http://www.opengis.net/om/2.0" xmlns:wml2="http://www.opengis.net/waterml/2.0" ' +
    'xmlns:sam="http://www.opengis.net/sampling/2.0" ' +
    'xmlns:ompr="http://inspire.ec.europa.eu/schemas/ompr/3.0" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink">' +
    members.join('') +
    '</wfs:FeatureCollection>'
  );
}

describe('parseTimeValuePairs', () => {
  it('poimii viimeisimmän arvon per parametri', () => {
    const parsed = parseTimeValuePairs(
      collection(
        member('temperature', [
          ['2026-10-01T16:40:00Z', '11.9'],
          ['2026-10-01T16:50:00Z', '11.8'],
        ]),
        member('windspeedms', [['2026-10-01T16:50:00Z', '1.8']]),
      ),
    );

    expect(parsed.values.temperature).toBe(11.8);
    expect(parsed.values.windspeedms).toBe(1.8);
  });

  it('ohittaa NaN-arvot ja käyttää viimeisintä kelvollista havaintoa', () => {
    const parsed = parseTimeValuePairs(
      collection(
        member('temperature', [
          ['2026-10-01T16:30:00Z', '12.7'],
          ['2026-10-01T16:40:00Z', 'NaN'],
          ['2026-10-01T16:50:00Z', 'NaN'],
        ]),
      ),
    );

    expect(parsed.values.temperature).toBe(12.7);
    // Viimeisin kelvollinen aikaleima, ei NaN-rivin aika.
    expect(parsed.observedAt).toBe('2026-10-01T16:30:00Z');
  });

  it('jättää parametrin pois, jos kaikki arvot ovat puuttuvia', () => {
    const parsed = parseTimeValuePairs(
      collection(member('humidity', [['2026-10-01T16:50:00Z', 'NaN']])),
    );

    expect(parsed.values.humidity).toBeUndefined();
    expect(parsed.observedAt).toBeNull();
  });

  it('lukee aseman tunnisteen, nimen ja koordinaatit', () => {
    const parsed = parseTimeValuePairs(
      collection(member('temperature', [['2026-10-01T16:50:00Z', '11.8']])),
    );

    expect(parsed.station).toEqual({
      fmisid: '101118',
      name: 'Pirkkala Tampere-Pirkkala lentoasema',
      latitude: 61.4194,
      longitude: 23.62256,
    });
  });

  it('observedAt on viimeisin kelvollinen aikaleima yli parametrien', () => {
    const parsed = parseTimeValuePairs(
      collection(
        member('temperature', [['2026-10-01T16:30:00Z', '12.0']]),
        member('windspeedms', [['2026-10-01T16:50:00Z', '2.5']]),
      ),
    );

    expect(parsed.observedAt).toBe('2026-10-01T16:50:00Z');
  });

  it('ohittaa tuntemattomat parametrit (esim. FMI:n muut suureet)', () => {
    const parsed = parseTimeValuePairs(
      collection(member('some_new_parameter', [['2026-10-01T16:50:00Z', '5']])),
    );

    expect(parsed.values).toEqual({});
  });

  it('palauttaa tyhjän rakenteen tyhjästä tai virheellisestä vastauksesta', () => {
    for (const xml of ['<wfs:FeatureCollection/>', '<ExceptionReport/>', '']) {
      const parsed = parseTimeValuePairs(xml);
      expect(parsed.values).toEqual({});
      expect(parsed.observedAt).toBeNull();
      expect(parsed.station.fmisid).toBeNull();
    }
  });
});

describe('parameterFromHref', () => {
  it('poimii parametrin observedProperty-hrefistä', () => {
    expect(
      parameterFromHref(
        'https://opendata.fmi.fi/meta?observableProperty=observation&param=n_man&language=eng',
      ),
    ).toBe('n_man');
    expect(parameterFromHref('…?param=windspeedms')).toBe('windspeedms');
  });

  it('palauttaa null, jos href puuttuu tai siinä ei ole param-kohtaa', () => {
    expect(parameterFromHref(undefined)).toBeNull();
    expect(parameterFromHref('https://example.com/meta')).toBeNull();
  });
});

describe('numericValue', () => {
  it('tulkitsee NaN:n ja tyhjän puuttuvaksi (ei nollaksi)', () => {
    expect(numericValue('NaN')).toBeNull();
    expect(numericValue('')).toBeNull();
    expect(numericValue(undefined)).toBeNull();
  });

  it('hyväksyy negatiiviset ja desimaaliarvot', () => {
    expect(numericValue('-1.0')).toBe(-1);
    expect(numericValue('11.8')).toBe(11.8);
    expect(numericValue(0)).toBe(0);
  });
});
