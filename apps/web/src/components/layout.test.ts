import { describe, expect, it } from 'vitest';

import { NAV } from './Layout';

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
