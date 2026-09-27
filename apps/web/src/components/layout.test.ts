import { describe, expect, it } from 'vitest';

import { NAV } from './Layout';

/**
 * Päänavigaation regressiosuoja (§29).
 *
 * Järjestys ja nimet muutettiin käyttäjän pyynnöstä 27.9.2026: "Nysse kartalla"
 * → "Nysse", "Liikennekamerat" → "Kamerat", ja "Joukkoliikenne
 * poikkeustilanteet" -välilehti poistettiin (sisältö on Nysse-välilehden
 * sivupaneelissa). Testi varmistaa, ettei järjestys tai nimet muutu vahingossa.
 */
describe('NAV', () => {
  it('on pyydetyssä järjestyksessä ja nimillä', () => {
    expect(NAV.map((item) => item.label)).toEqual([
      'Nyt',
      'Kartta',
      'Nysse',
      'Kamerat',
      'Poliisi',
      'Liikenne',
      'Säävaroitukset',
      'Lähteiden tila',
    ]);
  });

  it('ei sisällä omaa välilehteä joukkoliikenteen poikkeustilanteille', () => {
    expect(NAV.some((item) => item.to === '/joukkoliikenne')).toBe(false);
    expect(NAV.some((item) => /poikkeustilanteet/i.test(item.label))).toBe(false);
  });

  it('osoittaa Nysse- ja Kamerat-välilehdet olemassa oleviin reitteihin', () => {
    expect(NAV.find((item) => item.label === 'Nysse')?.to).toBe('/nysse-kartta');
    expect(NAV.find((item) => item.label === 'Kamerat')?.to).toBe('/kamerat');
  });

  it('merkitsee vain etusivun tarkaksi osumaksi (`end`)', () => {
    expect(NAV.filter((item) => item.end).map((item) => item.to)).toEqual(['/']);
  });
});
