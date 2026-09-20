/** Nyt-sivun koostekorttien ryhmittely ja järjestys. */

import type { Category, SituationSummary } from '../api/types';

/** Kategorioiden näyttöjärjestys Nyt-sivulla. */
export const CATEGORY_ORDER: Category[] = [
  'POLICE',
  'WEATHER',
  'TRAFFIC',
  'PUBLIC_TRANSPORT',
  'EVENT',
  'RAIL',
];

/** Kategorian oma välilehti; puuttuu, jos kategorialla ei ole sivua. */
export const CATEGORY_ROUTES: Partial<Record<Category, string>> = {
  TRAFFIC: '/liikenne',
  WEATHER: '/saa',
  POLICE: '/poliisi',
  PUBLIC_TRANSPORT: '/joukkoliikenne',
};

/**
 * Järjestysavain: tapahtuman oma alkuaika → lähteen julkaisuaika → havaintoaika.
 * Sama logiikka kuin taulun GSI-lajitteluavaimella, joten järjestys vastaa API:n
 * palauttamaa järjestystä.
 */
export function timeKeyOf(item: SituationSummary): string {
  return item.startsAt ?? item.publishedAt ?? item.firstSeenAt ?? '';
}

/**
 * Ryhmittelee tilanteet kategorioittain, kussakin uusin ensin.
 * Kategoriat palautetaan CATEGORY_ORDER-järjestyksessä.
 */
export function groupByCategory(items: SituationSummary[]): Map<Category, SituationSummary[]> {
  const grouped = new Map<Category, SituationSummary[]>();
  for (const item of items) {
    const existing = grouped.get(item.category);
    if (existing) existing.push(item);
    else grouped.set(item.category, [item]);
  }

  for (const list of grouped.values()) {
    list.sort((a, b) => timeKeyOf(b).localeCompare(timeKeyOf(a)));
  }

  const ordered = new Map<Category, SituationSummary[]>();
  for (const category of CATEGORY_ORDER) {
    const list = grouped.get(category);
    if (list) ordered.set(category, list);
  }
  return ordered;
}
