import { describe, expect, it } from 'vitest';

import { NAV, NAV_SELECT_PLACEHOLDER, activeNavPath } from './Layout';

/**
 * Päänavigaation regressiosuoja.
 *
 * Järjestys ja nimet ovat muuttuneet käyttäjän pyynnöstä useasti:
 * §29 lyhensi nimet ja poisti "Joukkoliikenne poikkeustilanteet" -välilehden
 * (sisältö on Nysse-välilehden sivupaneelissa), commit 808d50e tarkensi nimiä
 * ja §30 lisäsi Liikennemäärät-välilehden. Testi varmistaa, ettei järjestys,
 * nimet tai reitit muutu vahingossa.
 */
describe('NAV', () => {
  it('on pyydetyssä järjestyksessä ja nimillä', () => {
    expect(NAV.map((item) => item.label)).toEqual([
      'Etusivu',
      'Tapahtumat kartalla',
      'Nysse kartalla',
      'Kamerat',
      'Liikennemäärät',
      'Saunat',
      'Lähteiden tila',
    ]);
  });

  it('ei sisällä omaa välilehteä joukkoliikenteen poikkeustilanteille', () => {
    expect(NAV.some((item) => item.to === '/joukkoliikenne')).toBe(false);
    expect(NAV.some((item) => /poikkeustilanteet/i.test(item.label))).toBe(false);
  });

  it('osoittaa välilehdet olemassa oleviin reitteihin', () => {
    expect(NAV.find((item) => item.label === 'Nysse kartalla')?.to).toBe('/nysse-kartta');
    expect(NAV.find((item) => item.label === 'Kamerat')?.to).toBe('/kamerat');
    expect(NAV.find((item) => item.label === 'Liikennemäärät')?.to).toBe('/liikennemaarat');
    expect(NAV.find((item) => item.label === 'Saunat')?.to).toBe('/saunat');
  });

  it('merkitsee vain etusivun tarkaksi osumaksi (`end`)', () => {
    expect(NAV.filter((item) => item.end).map((item) => item.to)).toEqual(['/']);
  });
});

/**
 * Kapean näytön osiovalitsin (§38) näyttää `activeNavPath`-funktion tuloksen.
 * Testi varmistaa, ettei valitsin näytä väärää osiota sivuilla, jotka eivät
 * ole päänavigaatiossa (/liikenne, /saa, /poliisi, /joukkoliikenne).
 */
describe('activeNavPath', () => {
  it('tunnistaa jokaisen navigaatiokohdan omaksi polukseen', () => {
    for (const item of NAV) {
      expect(activeNavPath(item.to)).toBe(item.to);
    }
  });

  it('ei sekoita /liikenne- ja /liikennemaarat-reittejä keskenään', () => {
    expect(activeNavPath('/liikenne')).toBe(NAV_SELECT_PLACEHOLDER);
    expect(activeNavPath('/liikennemaarat')).toBe('/liikennemaarat');
  });

  it('palauttaa paikanvaraajan, kun polku ei ole päänavigaatiossa', () => {
    for (const path of ['/liikenne', '/saa', '/poliisi', '/joukkoliikenne', '/tuntematon']) {
      expect(activeNavPath(path)).toBe(NAV_SELECT_PLACEHOLDER);
    }
  });

  it('tunnistaa alipolut ja päätösvinon vain ei-tarkoille kohteille', () => {
    expect(activeNavPath('/kartta/123')).toBe('/kartta');
    expect(activeNavPath('/nysse-kartta/x')).toBe('/nysse-kartta');
    expect(activeNavPath('/kartta/')).toBe('/kartta');
    /* Etusivu on tarkka (`end`), joten se ei nappaa alipolkuja. */
    expect(activeNavPath('/kartta')).not.toBe('/');
  });

  it('paikanvaraaja ei osu mihinkään navigaatiokohtaan', () => {
    expect(NAV.some((item) => item.to === NAV_SELECT_PLACEHOLDER)).toBe(false);
  });
});
