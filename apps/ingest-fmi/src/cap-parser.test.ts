import { describe, expect, it } from 'vitest';

import {
  capLifecycleStatus,
  capMsgTypeToInternal,
  capStatusToInternal,
  parseCapXml,
  parseReferences,
} from './cap-parser';

/** FMI:n todellinen rakenne: status/msgType/references ovat **alert-tasolla**. */
function capXml(opts: {
  status?: string;
  msgType?: string;
  references?: string;
  areaDesc?: string;
  event?: string;
  severity?: string;
  expires?: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>urn:oid:2.49.0.1.246.0.0.2026.22688883.22296924345210491597258633185039</identifier>
  <sender>urn:oid:2.49.0.0.246.0</sender>
  <sent>2026-09-20T17:28:03+03:00</sent>
  ${opts.status ? `<status>${opts.status}</status>` : ''}
  ${opts.msgType ? `<msgType>${opts.msgType}</msgType>` : ''}
  ${opts.references ? `<references>${opts.references}</references>` : ''}
  <scope>Public</scope>
  <info>
    <language>fi-FI</language>
    <event>${opts.event ?? 'Tuulivaroitus maa-alueille'}</event>
    <severity>${opts.severity ?? 'Severe'}</severity>
    <certainty>Likely</certainty>
    <urgency>Expected</urgency>
    <onset>2026-09-20T14:54:00+03:00</onset>
    ${opts.expires ? `<expires>${opts.expires}</expires>` : ''}
    <area><areaDesc>${opts.areaDesc ?? 'Pirkanmaa'}</areaDesc></area>
  </info>
</alert>`;
}

const ORIGINAL_ID =
  'urn:oid:2.49.0.1.246.0.0.2026.22679640.22296924345210491597258633185039950592';
const CANCEL_CAP = capXml({
  status: 'Actual',
  msgType: 'Cancel',
  references: `urn:oid:2.49.0.0.246.0,${ORIGINAL_ID}`,
});

describe('parseCapXml — elinkaaritila', () => {
  it('tunnistaa peruutuksen: status Actual + msgType Cancel → CANCELLED', () => {
    // FMI:n todellinen muoto poistetulle varoitukselle (tarkistettu 20.9.2026).
    const parsed = parseCapXml(CANCEL_CAP);
    expect(parsed?.msgType).toBe('Cancel');
    expect(parsed?.status).toBe('CANCELLED');
  });

  it('palauttaa viitatun varoituksen identifierin (peruutuksen kohde)', () => {
    expect(parseCapXml(CANCEL_CAP)?.referencedIdentifiers).toEqual([ORIGINAL_ID]);
  });

  it('aktiivinen päivitys (msgType Update) on ACTIVE', () => {
    const parsed = parseCapXml(capXml({ status: 'Actual', msgType: 'Update' }));
    expect(parsed?.status).toBe('ACTIVE');
  });

  it('ilman msgType-kenttää status Actual → ACTIVE', () => {
    expect(parseCapXml(capXml({ status: 'Actual' }))?.status).toBe('ACTIVE');
  });

  it('lukee voimassaoloajan ja alueen', () => {
    const parsed = parseCapXml(
      capXml({ status: 'Actual', msgType: 'Update', expires: '2026-09-20T20:00:00+03:00' }),
    );
    expect(parsed?.expires).toBe('2026-09-20T20:00:00+03:00');
    expect(parsed?.relevantForTampereRegion).toBe(true);
  });

  it('merialuevaroitusta ei pidetä Tampereen seudun varoituksena', () => {
    const parsed = parseCapXml(capXml({ status: 'Actual', msgType: 'Update', areaDesc: 'Perämeren eteläosa' }));
    expect(parsed?.relevantForTampereRegion).toBe(false);
  });

  it('palauttaa null kelvottomasta XML:stä', () => {
    expect(parseCapXml('ei xml')).toBeNull();
  });
});

describe('elinkaaritilan apurit', () => {
  it('capLifecycleStatus: msgType voittaa status-kentän', () => {
    expect(capLifecycleStatus('Cancel', 'Actual')).toBe('CANCELLED');
    expect(capLifecycleStatus('Update', 'Actual')).toBe('ACTIVE');
    expect(capLifecycleStatus(undefined, 'Cancel')).toBe('CANCELLED');
    expect(capLifecycleStatus(undefined, 'Actual')).toBe('ACTIVE');
  });

  it('capMsgTypeToInternal: vain Cancel on terminaalinen', () => {
    expect(capMsgTypeToInternal('Cancel')).toBe('CANCELLED');
    expect(capMsgTypeToInternal('cancel')).toBe('CANCELLED');
    expect(capMsgTypeToInternal('Alert')).toBe('ACTIVE');
    expect(capMsgTypeToInternal(undefined)).toBe('ACTIVE');
  });

  it('capStatusToInternal: END → ENDED, CANCEL → CANCELLED', () => {
    expect(capStatusToInternal('End')).toBe('ENDED');
    expect(capStatusToInternal('Cancel')).toBe('CANCELLED');
    expect(capStatusToInternal('Actual')).toBe('ACTIVE');
  });
});

describe('parseReferences', () => {
  it('palauttaa viitatut identifierit ilman lähettäjää', () => {
    expect(parseReferences(`urn:oid:2.49.0.0.246.0,${ORIGINAL_ID}`)).toEqual([ORIGINAL_ID]);
  });

  it('käsittelee usean viittauksen (sender,id,sent,…)', () => {
    const refs = `urn:oid:2.49.0.0.246.0,${ORIGINAL_ID},2026-09-20T14:28:03+03:00,urn:oid:2.49.0.0.246.0,urn:oid:2.49.0.1.246.0.0.2026.2:3`;
    expect(parseReferences(refs)).toEqual([ORIGINAL_ID, 'urn:oid:2.49.0.1.246.0.0.2026.2:3']);
  });

  it('tyhjä tai puuttuva references → []', () => {
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences('')).toEqual([]);
  });
});
