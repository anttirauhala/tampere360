import { describe, expect, it } from 'vitest';

import {
  parseIsoDurationSeconds,
  parseSiriFeed,
  parseSiriVehicleMonitoring,
  stripOnwardCalls,
  toUtcIso,
} from './siri';
import type { SiriVehicle } from './types';

/**
 * Ote oikeasta Waltti SIRI VehicleMonitoring -vastauksesta (26.9.2026).
 * Mukana kolme ajoneuvoa, joista kolmas on tarkoituksella puutteellinen
 * (ei sijaintia) — se on ohitettava.
 */
const SIRI_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="1.3">
  <ServiceDelivery>
    <ResponseTimestamp>2026-09-26T19:28:34.796+03:00</ResponseTimestamp>
    <ProducerRef>MTSLIVE</ProducerRef>
    <VehicleMonitoringDelivery version="1.3">
      <ResponseTimestamp>2026-09-26T19:28:34.796+03:00</ResponseTimestamp>
      <Status>true</Status>
      <VehicleActivity>
        <RecordedAtTime>2026-09-26T19:28:42.174+03:00</RecordedAtTime>
        <ValidUntilTime>2026-09-26T19:29:42.174+03:00</ValidUntilTime>
        <MonitoredVehicleJourney>
          <LineRef>80</LineRef>
          <DirectionRef>1</DirectionRef>
          <OperatorRef>6990</OperatorRef>
          <OriginName xml:lang="fi">Moisio</OriginName>
          <DestinationName xml:lang="fi">Keskustori G</DestinationName>
          <Monitored>true</Monitored>
          <VehicleLocation><Longitude>23.5813770</Longitude><Latitude>61.5704918</Latitude></VehicleLocation>
          <Bearing>295.0</Bearing>
          <Delay>P0Y0M0DT0H1M24.000S</Delay>
          <VehicleRef>6990_350</VehicleRef>
          <OnwardCalls>
            <OnwardCall>
              <StopPointRef>6131</StopPointRef>
              <Order>4</Order>
              <StopPointName xml:lang="fi">Pitkäperäntie</StopPointName>
              <ExpectedDepartureTime>2026-09-26T19:28:40.178+03:00</ExpectedDepartureTime>
            </OnwardCall>
          </OnwardCalls>
        </MonitoredVehicleJourney>
      </VehicleActivity>
      <VehicleActivity>
        <RecordedAtTime>2026-09-26T19:28:43.000+03:00</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>1</LineRef>
          <DirectionRef>2</DirectionRef>
          <OperatorRef>56920</OperatorRef>
          <OriginName xml:lang="fi">Sorin aukio A</OriginName>
          <DestinationName xml:lang="fi">Hervantajärvi A</DestinationName>
          <VehicleLocation><Longitude>23.7833456</Longitude><Latitude>61.4491876</Latitude></VehicleLocation>
          <Bearing>152</Bearing>
          <Delay>-PT1M</Delay>
          <VehicleRef>56920_10</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>
      <VehicleActivity>
        <RecordedAtTime>2026-09-26T19:28:43.000+03:00</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>99</LineRef>
          <VehicleRef>6990_999</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>
    </VehicleMonitoringDelivery>
  </ServiceDelivery>
</Siri>`;

describe('parseSiriFeed', () => {
  it('poimii linjan, määränpään, suunnan, sijainnin ja viiveen', () => {
    const feed = parseSiriFeed(SIRI_XML);
    expect(feed.vehicles).toHaveLength(2);

    const bus = feed.vehicles.find((v) => v.vehicleId === '6990_350');
    expect(bus).toEqual({
      vehicleId: '6990_350',
      line: '80',
      operatorRef: '6990',
      destination: 'Keskustori G',
      origin: 'Moisio',
      direction: 1,
      latitude: 61.5704918,
      longitude: 23.581377,
      bearing: 295,
      delaySeconds: 84,
      recordedAt: '2026-09-26T16:28:42.174Z',
    });
  });

  it('normalisoi lähteen aikaleimat UTC:hen (+03:00 → Z)', () => {
    const feed = parseSiriFeed(SIRI_XML);
    expect(feed.generatedAt).toBe('2026-09-26T16:28:34.796Z');
    expect(feed.vehicles.find((v) => v.vehicleId === '56920_10')?.recordedAt).toBe(
      '2026-09-26T16:28:43.000Z',
    );
  });

  it('tulkitsee etuajassa kulkevan vuoron negatiiviseksi viiveeksi', () => {
    const feed = parseSiriFeed(SIRI_XML);
    expect(feed.vehicles.find((v) => v.vehicleId === '56920_10')?.delaySeconds).toBe(-60);
  });

  it('ohittaa ajoneuvon, jolta puuttuu sijainti', () => {
    const feed = parseSiriFeed(SIRI_XML);
    expect(feed.vehicles.map((v) => v.vehicleId)).not.toContain('6990_999');
  });

  it('palauttaa tyhjän listan, jos ajoneuvoja ei ole (ei kaada)', () => {
    const feed = parseSiriFeed(
      '<Siri xmlns="http://www.siri.org.uk/siri"><ServiceDelivery><VehicleMonitoringDelivery>' +
        '<ResponseTimestamp>2026-09-26T19:28:34.796+03:00</ResponseTimestamp>' +
        '</VehicleMonitoringDelivery></ServiceDelivery></Siri>',
    );
    expect(feed.vehicles).toEqual([]);
    expect(feed.generatedAt).toBe('2026-09-26T16:28:34.796Z');
  });

  it('jäsentää koko dokumentin, jos siivottu dokumentti ei tuota ajoneuvoja', () => {
    // Varajärjestely: jos siivottu dokumentti ei tuota yhtään ajoneuvoa
    // (esim. lähde muuttaa rakennetta), jäsennetään koko dokumentti, ettei
    // kartta tyhjene hiljaisesti. Tässä jäsennin injektoidaan, jotta
    // varajärjestely on testattavissa deterministisesti.
    const calls: string[] = [];
    const stub: SiriVehicle = {
      vehicleId: '56920_12',
      line: '3',
      operatorRef: '56920',
      destination: null,
      origin: null,
      direction: null,
      latitude: 61.45,
      longitude: 23.75,
      bearing: null,
      delaySeconds: null,
      recordedAt: '2026-09-26T16:28:42.174Z',
    };

    const feed = parseSiriFeed('<Siri><OnwardCalls>x</OnwardCalls></Siri>', (document) => {
      calls.push(document);
      return { generatedAt: null, vehicles: document.includes('OnwardCalls') ? [stub] : [] };
    });

    expect(calls).toHaveLength(2);
    expect(feed.vehicles).toHaveLength(1);
  });

  it('jäsentää siivotun dokumentin, kun se tuottaa ajoneuvoja', () => {
    const calls: string[] = [];
    parseSiriFeed(SIRI_XML, (document) => {
      calls.push(document);
      return parseSiriVehicleMonitoring(document);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('<OnwardCalls>');
  });
});

describe('stripOnwardCalls', () => {
  it('poistaa seuraavien pysäkkien lohkon (raskain osa vastausta)', () => {
    const stripped = stripOnwardCalls(SIRI_XML);
    expect(stripped).not.toContain('Pitkäperäntie');
    expect(stripped).not.toContain('<OnwardCalls>');
    // Ajoneuvot säilyvät ennallaan.
    expect(parseSiriFeed(stripped).vehicles).toHaveLength(2);
  });

  it('jättää itsensä sulkevan lohkon rauhaan', () => {
    expect(stripOnwardCalls('<OnwardCalls/>')).toBe('<OnwardCalls/>');
  });
});

describe('parseIsoDurationSeconds', () => {
  it('tulkitsee SIRI:n kestomuodon sekunneiksi', () => {
    expect(parseIsoDurationSeconds('P0Y0M0DT0H1M24.000S')).toBe(84);
    expect(parseIsoDurationSeconds('PT30S')).toBe(30);
    expect(parseIsoDurationSeconds('-PT1M')).toBe(-60);
    expect(parseIsoDurationSeconds('PT2H5M')).toBe(7500);
  });

  it('palauttaa null, jos arvoa ei voi tulkita sekunneiksi', () => {
    // Vuosia/kuukausia ei muunneta sekunneiksi — ei arvata (§20).
    expect(parseIsoDurationSeconds('P1Y')).toBeNull();
    expect(parseIsoDurationSeconds('P')).toBeNull();
    expect(parseIsoDurationSeconds('ei-kesto')).toBeNull();
    expect(parseIsoDurationSeconds('')).toBeNull();
    expect(parseIsoDurationSeconds(undefined)).toBeNull();
  });
});

describe('toUtcIso', () => {
  it('palauttaa null virheelliselle tai puuttuvalle ajalle', () => {
    expect(toUtcIso('ei-aika')).toBeNull();
    expect(toUtcIso(null)).toBeNull();
  });
});
