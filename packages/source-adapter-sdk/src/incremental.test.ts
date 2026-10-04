import { describe, expect, it } from 'vitest';

import { buildSentItems, dropSentItems, selectChangedItems } from './incremental';

/**
 * Kustannusoptimoinnin ydin: muuttumattomia tietueita ei lähetetä uudelleen.
 * Nämä testit lukitsevat valintalogiikan (ks. incremental.ts).
 */

const item = (sourceId: string, contentHash: string) => ({ sourceId, contentHash });

describe('selectChangedItems', () => {
  it('valitsee uuden tietueen, jota ei ole aiemmassa kartassa', () => {
    const changed = selectChangedItems([item('a', 'h1')], {});
    expect(changed).toHaveLength(1);
  });

  it('ohittaa tietueen, jonka tarkiste on ennallaan', () => {
    const changed = selectChangedItems([item('a', 'h1')], { a: 'h1' });
    expect(changed).toHaveLength(0);
  });

  it('valitsee tietueen, jonka sisältö on muuttunut', () => {
    const changed = selectChangedItems([item('a', 'h2')], { a: 'h1' });
    expect(changed.map((c) => c.sourceId)).toEqual(['a']);
  });

  it('käsittelee joukon, jossa osa muuttui ja osa ei', () => {
    const changed = selectChangedItems([item('a', 'h1'), item('b', 'h2'), item('c', 'h3')], {
      a: 'h1',
      b: 'x',
      c: 'h3',
    });
    expect(changed.map((c) => c.sourceId)).toEqual(['b']);
  });

  it('säilyttää muut kentät (esim. processingKey) valituissa tietueissa', () => {
    const rich = [{ sourceId: 'a', contentHash: 'h2', processingKey: 'SRC:a:h2' }];
    const changed = selectChangedItems(rich, { a: 'h1' });
    expect(changed[0]?.processingKey).toBe('SRC:a:h2');
  });
});

describe('buildSentItems', () => {
  it('muodostaa kartan sourceId → contentHash', () => {
    expect(buildSentItems([item('a', 'h1'), item('b', 'h2')])).toEqual({ a: 'h1', b: 'h2' });
  });

  it('siivoaa syötteestä kadonneet tietueet (kartta ei kasva rajatta)', () => {
    // Aiemmassa ajossa oli a, b ja c; nyt vain a ja b.
    const next = buildSentItems([item('a', 'h1'), item('b', 'h2')]);
    expect(Object.keys(next).sort()).toEqual(['a', 'b']);
  });

  it('palauttaa tyhjän kartan tyhjästä syötteestä', () => {
    expect(buildSentItems([])).toEqual({});
  });
});

describe('dropSentItems', () => {
  it('poistaa epäonnistuneet lähetykset, jotta ne yritetään uudelleen', () => {
    const map = { a: 'h1', b: 'h2', c: 'h3' };
    expect(dropSentItems(map, ['b'])).toEqual({ a: 'h1', c: 'h3' });
  });

  it('ei muuta alkuperäistä karttaa (puhdas funktio)', () => {
    const map = { a: 'h1' };
    dropSentItems(map, ['a']);
    expect(map).toEqual({ a: 'h1' });
  });

  it('palauttaa saman sisällön, kun virheitä ei ole', () => {
    const map = { a: 'h1' };
    expect(dropSentItems(map, [])).toEqual(map);
  });
});
