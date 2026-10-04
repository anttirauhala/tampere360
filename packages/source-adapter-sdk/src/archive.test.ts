import { describe, expect, it } from 'vitest';

import { buildRawArchive, rawArchiveKey } from './archive';

/**
 * Yksi S3-objekti per ajokerta (kustannusoptimointi 4.10.2026): aiemmin
 * jokainen tietue kirjoitettiin omana objektinaan → ~2 M PUT-pyyntöä/kk.
 */

describe('buildRawArchive', () => {
  it('paketoi koko tietuejoukon yhteen JSON-kirjekuoreen', () => {
    const json = buildRawArchive({
      source: 'TAMPERE_TRAFFIC',
      batchId: 'B1',
      fetchedAt: '2026-10-04T08:00:00.000Z',
      items: [
        { sourceId: 'a', processingKey: 'TAMPERE_TRAFFIC:a:1', raw: { id: 'a' } },
        { sourceId: 'b', processingKey: 'TAMPERE_TRAFFIC:b:1', raw: { id: 'b' } },
      ],
    });
    const parsed = JSON.parse(json) as {
      schemaVersion: string;
      source: string;
      batchId: string;
      fetchedAt: string;
      itemCount: number;
      items: { sourceId: string; raw: unknown; sourceText?: string }[];
    };
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.source).toBe('TAMPERE_TRAFFIC');
    expect(parsed.batchId).toBe('B1');
    expect(parsed.fetchedAt).toBe('2026-10-04T08:00:00.000Z');
    expect(parsed.itemCount).toBe(2);
    expect(parsed.items.map((i) => i.sourceId)).toEqual(['a', 'b']);
    expect(parsed.items[0]?.raw).toEqual({ id: 'a' });
  });

  it('säilyttää alkuperäisen lähdetekstin (FMI CAP-XML)', () => {
    const json = buildRawArchive({
      source: 'FMI_CAP',
      batchId: 'B2',
      fetchedAt: '2026-10-04T08:00:00.000Z',
      items: [
        { sourceId: 'x', processingKey: 'FMI_CAP:x:1', raw: { a: 1 }, sourceText: '<alert/>' },
      ],
    });
    const parsed = JSON.parse(json) as { items: { sourceText?: string }[] };
    expect(parsed.items[0]?.sourceText).toBe('<alert/>');
  });

  it('merkitsee tyhjän joukon itemCount-nollaksi', () => {
    const json = buildRawArchive({
      source: 'POLICE_RSS',
      batchId: 'B3',
      fetchedAt: '2026-10-04T08:00:00.000Z',
      items: [],
    });
    expect((JSON.parse(json) as { itemCount: number }).itemCount).toBe(0);
  });
});

describe('rawArchiveKey', () => {
  it('noudattaa samaa hierarkiaa kuin ennen (elinkaarisäännöt osuvat)', () => {
    const key = rawArchiveKey('tampere-traffic', 'B1', new Date('2026-10-04T08:09:00Z'));
    expect(key).toBe('source=tampere-traffic/year=2026/month=10/day=04/hour=08/B1.json');
  });

  it('nollaa kuukauden ja päivän kahdella numerolla', () => {
    const key = rawArchiveKey('nysse', 'B2', new Date('2026-01-09T03:00:00Z'));
    expect(key).toContain('month=01/day=09/hour=03');
  });

  it('päättyy aina .json-päätteeseen', () => {
    expect(rawArchiveKey('police', 'B3', new Date('2026-10-04T08:00:00Z'))).toMatch(/B3\.json$/);
  });
});
