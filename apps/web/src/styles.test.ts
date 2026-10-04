import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Regressiosuoja: ruudukon sarakeminimi ei saa olla kiinteä pikseliarvo.
 *
 * `repeat(auto-fill, minmax(320px, 1fr))` ei kutistu alle 320px:n, joten
 * sarake valuu säiliön reunan yli heti kun sisältöalue on kapeampi. Näin käy
 * helposti puhelimessa: 360px:n viewportissa `.main`-reunus vie 2 × 20px,
 * jolloin sisältöalueeksi jää täsmälleen 320px — eikä yhtään vähempää tilaa
 * tarvita. Heti kun käyttöjärjestelmän fonttikoko ei ole oletus, selain zoomaa
 * **koko sivun** (Chrome: "Accessibility Page Zoom"; Firefox:
 * `browser.display.os-zoom-behavior = 1`), jolloin CSS-viewport kapenee ja
 * ylivuoto kasvaa kymmeniin pikseleihin. Sama tapahtuu näytön koko/zoom
 * -asetuksella.
 *
 * `minmax(min(320px, 100%), 1fr)` rajaa minimin säiliön leveyteen: työpöydällä
 * sarake on edelleen vähintään 320px, mutta kapealla se kutistuu eikä koskaan
 * ylitä reunaa riippumatta selaimesta, fonttikoosta tai zoomauksesta.
 *
 * CSS luetaan tiedostona eikä `?raw`-importilla, koska Vitest ei prosessoi CSS:ää
 * (`test.css` oletus false) ja `?raw` palauttaisi silloin tyhjän merkkijonon.
 */
const styles = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

/** Kaikki `repeat(auto-fill, minmax(<minimi>, …))` -esiintymät. */
const AUTO_FILL_MINMAX = /repeat\(\s*auto-fill\s*,\s*minmax\(\s*([^,]+?)\s*,/g;

function autoFillMinima(): { min: string; whole: string }[] {
  return [...styles.matchAll(AUTO_FILL_MINMAX)].map((match) => ({
    min: (match[1] ?? '').trim(),
    whole: match[0],
  }));
}

describe('styles.css — ruudukoiden sarakeminimi', () => {
  it('löytää ruudukot (estää regexin hiljaisen hajoamisen)', () => {
    // Jos tämä luku putoaa, sääntöjä on nimetty uudelleen eikä testi enää
    // valvo mitään — silloin tarkistus on päivitettävä, ei poistettava.
    expect(autoFillMinima().length).toBeGreaterThanOrEqual(5);
  });

  it('jokainen auto-fill-ruudukko rajaa minimin säiliön leveyteen', () => {
    const fixedMinimums = autoFillMinima()
      .filter((entry) => !entry.min.includes('min('))
      .map((entry) => entry.whole);

    expect(fixedMinimums).toEqual([]);
  });
});

describe('styles.css — muut kiinteät minimileveydet', () => {
  it('Nyt-sivun otsikkopalsta rajaa miniminsä säiliöön', () => {
    expect(styles).toContain('min-width: min(240px, 100%)');
  });

  it('sääkortti rajaa miniminsä säiliöön', () => {
    expect(styles).toContain('min-width: min(210px, 100%)');
  });
});
