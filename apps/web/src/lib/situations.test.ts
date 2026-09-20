import { describe, expect, it } from 'vitest';

import type { Category, SituationSummary } from '../api/types';
import { CATEGORY_ORDER, groupByCategory, timeKeyOf } from './situations';

function item(
  category: Category,
  title: string,
  times: Partial<Pick<SituationSummary, 'startsAt' | 'publishedAt' | 'firstSeenAt'>> = {},
): SituationSummary {
  return {
    situationId: `${category}-${title}`,
    category,
    severity: 'MINOR',
    status: 'ACTIVE',
    startsAt: times.startsAt ?? null,
    publishedAt: times.publishedAt ?? null,
    firstSeenAt: times.firstSeenAt ?? null,
    title,
  };
}

describe('timeKeyOf', () => {
  it('käyttää alkuaikaa, sitten julkaisuaikaa, sitten havaintoaikaa', () => {
    expect(timeKeyOf(item('TRAFFIC', 'a', { startsAt: '2026-09-20T08:00:00.000Z' }))).toBe(
      '2026-09-20T08:00:00.000Z',
    );
    expect(timeKeyOf(item('POLICE', 'b', { publishedAt: '2026-09-17T07:56:00.000Z' }))).toBe(
      '2026-09-17T07:56:00.000Z',
    );
    expect(timeKeyOf(item('POLICE', 'c', { firstSeenAt: '2026-09-18T19:48:00.000Z' }))).toBe(
      '2026-09-18T19:48:00.000Z',
    );
    expect(timeKeyOf(item('POLICE', 'd'))).toBe('');
  });
});

describe('groupByCategory', () => {
  it('ryhmittelee kategorioittain ja uusin ensin', () => {
    const grouped = groupByCategory([
      item('TRAFFIC', 'vanha', { startsAt: '2026-09-10T10:00:00.000Z' }),
      item('POLICE', 'poliisi', { publishedAt: '2026-09-17T07:56:00.000Z' }),
      item('TRAFFIC', 'uusi', { startsAt: '2026-09-20T08:00:00.000Z' }),
    ]);

    expect([...grouped.keys()]).toEqual(['POLICE', 'TRAFFIC']);
    expect(grouped.get('TRAFFIC')?.map((i) => i.title)).toEqual(['uusi', 'vanha']);
    expect(grouped.get('POLICE')?.map((i) => i.title)).toEqual(['poliisi']);
  });

  it('noudattaa CATEGORY_ORDER-järjestystä, ei syötteen järjestystä', () => {
    const grouped = groupByCategory([
      item('PUBLIC_TRANSPORT', 'nysse'),
      item('POLICE', 'poliisi'),
      item('WEATHER', 'saa'),
      item('TRAFFIC', 'liikenne'),
    ]);
    expect([...grouped.keys()]).toEqual(['POLICE', 'WEATHER', 'TRAFFIC', 'PUBLIC_TRANSPORT']);
    expect(CATEGORY_ORDER[0]).toBe('POLICE');
  });

  it('palauttaa tyhjän ryhmittelyn tyhjälle syötteelle', () => {
    expect(groupByCategory([]).size).toBe(0);
  });

  it('ei muokkaa alkuperäistä järjestystä kategorioiden sisällä', () => {
    const grouped = groupByCategory([item('WEATHER', 'vain yksi')]);
    expect(grouped.get('WEATHER')).toHaveLength(1);
  });
});
