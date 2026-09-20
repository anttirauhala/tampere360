import { describe, expect, it } from 'vitest';

import { asHttpUrl, situationSourceUrl } from './links';

describe('asHttpUrl', () => {
  it('hyväksyy http(s)-osoitteet', () => {
    expect(asHttpUrl('https://poliisi.fi/-/tiedote')).toBe('https://poliisi.fi/-/tiedote');
    expect(asHttpUrl('http://example.com/a')).toBe('http://example.com/a');
  });

  it('hylkää muut protokollat ja kelvottomat arvot', () => {
    expect(asHttpUrl('javascript:alert(1)')).toBeNull();
    expect(asHttpUrl('ftp://poliisi.fi')).toBeNull();
    expect(asHttpUrl('ei-url')).toBeNull();
    expect(asHttpUrl('')).toBeNull();
    expect(asHttpUrl(undefined)).toBeNull();
    expect(asHttpUrl(42)).toBeNull();
  });
});

describe('situationSourceUrl', () => {
  it('käyttää event.source.url-kenttää', () => {
    expect(
      situationSourceUrl({ source: { url: 'https://poliisi.fi/-/tiedote', sourceId: 'guid-1' } }),
    ).toBe('https://poliisi.fi/-/tiedote');
  });

  it('käyttää sourceId:tä, kun se on URL (poliisin RSS: guid on linkki)', () => {
    // Vanhat rivit (ennen source.url-käyttöönottoa) saavat linkin näin.
    expect(
      situationSourceUrl({ source: { sourceId: 'https://poliisi.fi/-/jalankulkija-kuoli' } }),
    ).toBe('https://poliisi.fi/-/jalankulkija-kuoli');
  });

  it('ei palauta linkkiä, kun kumpikaan ei ole kelvollinen osoite', () => {
    expect(situationSourceUrl({ source: { sourceId: 'urn:oid:2.49.0.1' } })).toBeNull();
    expect(situationSourceUrl({ source: {} })).toBeNull();
    expect(situationSourceUrl({})).toBeNull();
    expect(situationSourceUrl(undefined)).toBeNull();
  });

  it('ei koskaan palauta javascript-osoitetta', () => {
    expect(situationSourceUrl({ source: { url: 'javascript:alert(1)', sourceId: 'x' } })).toBeNull();
  });
});
