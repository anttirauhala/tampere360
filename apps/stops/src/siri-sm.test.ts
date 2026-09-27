import { describe, expect, it } from 'vitest';

import {
  buildStopMonitoringRequest,
  parseIsoDurationSeconds,
  parseStopMonitoring,
  parseStopMonitoringFeed,
  stripOnwardCalls,
  toUtcIso,
} from './siri-sm';

/** Ote oikeasta Walttin StopMonitoring-vastauksesta (pysäkki 0015, 27.9.2026). */
const SM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri">
  <ServiceDelivery>
    <ResponseTimestamp>2026-09-27T12:54:19.171+03:00</ResponseTimestamp>
    <StopMonitoringDelivery version="1.3">
      <ResponseTimestamp>2026-09-27T12:54:19.171+03:00</ResponseTimestamp>
      <Status>true</Status>
      <ValidUntil>2026-09-27T12:54:49.171+03:00</ValidUntil>
      <MonitoredStopVisit>
        <RecordedAtTime>2026-09-27T12:54:19.263+03:00</RecordedAtTime>
        <MonitoringRef>0015</MonitoringRef>
        <MonitoredVehicleJourney>
          <LineRef>8A</LineRef>
          <OperatorRef>6921</OperatorRef>
          <OriginName xml:lang="fi">Levonmäki</OriginName>
          <DestinationName xml:lang="fi">Haukiluoma</DestinationName>
          <Monitored>true</Monitored>
          <Delay>P0Y0M0DT0H3M0.000S</Delay>
          <MonitoredCall>
            <VehicleAtStop>true</VehicleAtStop>
            <AimedArrivalTime>2026-09-27T12:58:12+03:00</AimedArrivalTime>
            <ExpectedArrivalTime>2026-09-27T13:01:12+03:00</ExpectedArrivalTime>
            <AimedDepartureTime>2026-09-27T12:58:12+03:00</AimedDepartureTime>
            <ExpectedDepartureTime>2026-09-27T13:01:12+03:00</ExpectedDepartureTime>
          </MonitoredCall>
          <OnwardCalls>
            <OnwardCall>
              <StopPointRef>0519</StopPointRef>
              <StopPointName xml:lang="fi">Koskipuisto C</StopPointName>
            </OnwardCall>
          </OnwardCalls>
        </MonitoredVehicleJourney>
        <StopVisitNote xml:lang="fi">Keskustori D</StopVisitNote>
      </MonitoredStopVisit>
      <MonitoredStopVisit>
        <RecordedAtTime>2026-09-27T12:54:19.290+03:00</RecordedAtTime>
        <MonitoringRef>0015</MonitoringRef>
        <MonitoredVehicleJourney>
          <LineRef>2</LineRef>
          <DestinationName xml:lang="fi">Särkänniemi C</DestinationName>
          <Monitored>false</Monitored>
          <MonitoredCall>
            <VehicleAtStop>false</VehicleAtStop>
            <AimedDepartureTime>2026-09-27T13:10:00+03:00</AimedDepartureTime>
          </MonitoredCall>
        </MonitoredVehicleJourney>
        <StopVisitNote xml:lang="fi">Keskustori D</StopVisitNote>
      </MonitoredStopVisit>
    </StopMonitoringDelivery>
  </ServiceDelivery>
</Siri>`;

describe('buildStopMonitoringRequest', () => {
  it('sisältää dokumentoidun PreviewInterval-elementin (pakollinen Walttilla)', () => {
    const xml = buildStopMonitoringRequest(['0015'], 60);
    expect(xml).toContain('<PreviewInterval>PT60M00S</PreviewInterval>');
    expect(xml).toContain('<MonitoringRef>0015</MonitoringRef>');
    expect(xml.match(/<StopMonitoringRequest/g)).toHaveLength(1);
  });

  it('tekee yhden StopMonitoringRequest-elementin per pysäkki', () => {
    const xml = buildStopMonitoringRequest(['0015', '0504'], 30);
    expect(xml.match(/<StopMonitoringRequest/g)).toHaveLength(2);
    expect(xml).toContain('<MonitoringRef>0015</MonitoringRef>');
    expect(xml).toContain('<MonitoringRef>0504</MonitoringRef>');
    expect(xml.match(/PT30M00S/g)).toHaveLength(2);
  });

  it('koodaa tunnisteen XML-escapeksi, jotta arvo ei riko pyyntöä', () => {
    const xml = buildStopMonitoringRequest(['a"b<c'], 60);
    expect(xml).toContain('<MonitoringRef>a&quot;b&lt;c</MonitoringRef>');
  });

  it('heittää tyhjästä listasta ja liian monesta pysäkistä', () => {
    expect(() => buildStopMonitoringRequest([], 60)).toThrow(/vähintään yhden/);
    expect(() => buildStopMonitoringRequest(Array(101).fill('0015'), 60)).toThrow(/100 pysäkkiä/);
  });
});

describe('stripOnwardCalls', () => {
  it('poistaa OnwardCalls-lohkot (vastauksen suurin osa)', () => {
    const stripped = stripOnwardCalls(SM_XML);
    expect(stripped).not.toContain('OnwardCall');
    expect(stripped).toContain('MonitoredStopVisit');
  });
});

describe('parseStopMonitoring', () => {
  const feed = parseStopMonitoringFeed(SM_XML);

  it('lukee tuotantoajan ja voimassaolon UTC:nä', () => {
    expect(feed.generatedAt).toBe('2026-09-27T09:54:19.171Z');
    expect(feed.validUntil).toBe('2026-09-27T09:54:49.171Z');
  });

  it('poimii vuoron kentät, myös xml:lang-rakenteesta', () => {
    expect(feed.visits[0]).toEqual({
      recordedAt: '2026-09-27T09:54:19.263Z',
      stopId: '0015',
      line: '8A',
      destination: 'Haukiluoma',
      origin: 'Levonmäki',
      stopName: 'Keskustori D',
      realtime: true,
      delaySeconds: 180,
      aimedArrivalTime: '2026-09-27T09:58:12.000Z',
      aimedDepartureTime: '2026-09-27T09:58:12.000Z',
      expectedArrivalTime: '2026-09-27T10:01:12.000Z',
      expectedDepartureTime: '2026-09-27T10:01:12.000Z',
      vehicleAtStop: true,
    });
  });

  it('merkitsee aikatauluvuoron ei-reaaliaikaiseksi ja käsittelee puuttuvat kentät nollina', () => {
    const second = feed.visits[1];
    expect(second.realtime).toBe(false);
    expect(second.delaySeconds).toBeNull();
    expect(second.expectedDepartureTime).toBeNull();
    expect(second.aimedArrivalTime).toBeNull();
    expect(second.vehicleAtStop).toBe(false);
  });

  it('ohittaa vuoron, jolta puuttuu linja tai pysäkkitunniste', () => {
    const xml = `<Siri><ServiceDelivery><StopMonitoringDelivery>
      <MonitoredStopVisit><MonitoringRef>0015</MonitoringRef>
        <MonitoredVehicleJourney><DestinationName>Ilman linjaa</DestinationName></MonitoredVehicleJourney>
      </MonitoredStopVisit>
      <MonitoredStopVisit><MonitoredVehicleJourney><LineRef>1</LineRef></MonitoredVehicleJourney></MonitoredStopVisit>
    </StopMonitoringDelivery></ServiceDelivery></Siri>`;
    expect(parseStopMonitoring(xml).visits).toHaveLength(0);
  });

  it('palauttaa tyhjän listan, kun pysäkillä ei ole vuoroja', () => {
    const xml =
      '<Siri><ServiceDelivery><StopMonitoringDelivery><Status>true</Status></StopMonitoringDelivery></ServiceDelivery></Siri>';
    const empty = parseStopMonitoring(xml);
    expect(empty.visits).toEqual([]);
    expect(empty.generatedAt).toBeNull();
  });
});

describe('parseStopMonitoringFeed', () => {
  it('jäsentää koko dokumentin, jos siivottu dokumentti ei tuota vuoroja', () => {
    // Simuloi lähdemuutosta: data on lohkossa, jonka siivous poistaisi.
    const xml = SM_XML.replace(/OnwardCalls/g, 'MuutCalls');
    expect(parseStopMonitoringFeed(xml).visits).toHaveLength(2);
  });
});

describe('parseIsoDurationSeconds', () => {
  it('muuntaa keston sekunneiksi', () => {
    expect(parseIsoDurationSeconds('P0Y0M0DT0H1M30S')).toBe(90);
    expect(parseIsoDurationSeconds('PT45S')).toBe(45);
    expect(parseIsoDurationSeconds('-PT2M')).toBe(-120);
  });

  it('tulkitsee nollakeston nollaksi — se on "ajassa", ei tuntematon', () => {
    // Waltti kirjoittaa "ei poikkeamaa" muodossa P0Y0M0DT0H0M0.000S. Nolla on
    // käyttäjälle merkityksellinen tieto (vuoro on aikataulussa), joten sitä ei
    // muuteta nulliksi — sama käytäntö kuin ajoneuvosijainneissa (§27).
    expect(parseIsoDurationSeconds('P0Y0M0DT0H0M0.000S')).toBe(0);
    expect(parseIsoDurationSeconds('P0Y0M0D')).toBe(0);
  });

  it('ei arvaa vuosia tai kuukausia', () => {
    expect(parseIsoDurationSeconds('P1Y')).toBeNull();
    expect(parseIsoDurationSeconds('P1M')).toBeNull();
    expect(parseIsoDurationSeconds('')).toBeNull();
    expect(parseIsoDurationSeconds(null)).toBeNull();
    expect(parseIsoDurationSeconds('kolme minuuttia')).toBeNull();
  });
});

describe('toUtcIso', () => {
  it('normalisoi siirtymän UTC:ksi', () => {
    expect(toUtcIso('2026-09-27T12:58:12+03:00')).toBe('2026-09-27T09:58:12.000Z');
  });

  it('palauttaa null puuttuvasta tai virheellisestä ajasta', () => {
    expect(toUtcIso(undefined)).toBeNull();
    expect(toUtcIso('')).toBeNull();
    expect(toUtcIso('ei-aika')).toBeNull();
  });
});
