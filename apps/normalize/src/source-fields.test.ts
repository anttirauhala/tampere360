import { describe, expect, it } from 'vitest';

import { descriptionIfDistinct, extractSourceUrl, isSafeHttpUrl, stripHtml } from './source-fields';

describe('stripHtml', () => {
  it('poistaa tagit ja tiivistää välilyönnit', () => {
    expect(stripHtml('<p>Jalankulkija kuoli   Tampereella</p>')).toBe(
      'Jalankulkija kuoli Tampereella',
    );
  });

  it('käsittelee tyhjät arvot', () => {
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml(null)).toBe('');
    expect(stripHtml('<p></p>')).toBe('');
  });
});

describe('extractSourceUrl', () => {
  it('poimii RSS:n link-kentän', () => {
    expect(
      extractSourceUrl({ link: 'https://poliisi.fi/-/jalankulkija-kuoli-tampereella' }),
    ).toBe('https://poliisi.fi/-/jalankulkija-kuoli-tampereella');
  });

  it('hyväksyy myös url-kentän (valmiiksi normalisoitu muoto)', () => {
    expect(extractSourceUrl({ url: 'https://example.com/a' })).toBe('https://example.com/a');
  });

  it('hylkää vaaralliset ja kelvottomat arvot', () => {
    expect(extractSourceUrl({ link: 'javascript:alert(1)' })).toBeUndefined();
    expect(extractSourceUrl({ link: 'ei-url' })).toBeUndefined();
    expect(extractSourceUrl({ link: '' })).toBeUndefined();
    expect(extractSourceUrl({})).toBeUndefined();
    expect(extractSourceUrl(undefined)).toBeUndefined();
  });

  it('isSafeHttpUrl hyväksyy vain http(s)', () => {
    expect(isSafeHttpUrl('https://poliisi.fi')).toBe(true);
    expect(isSafeHttpUrl('http://poliisi.fi')).toBe(true);
    expect(isSafeHttpUrl('ftp://poliisi.fi')).toBe(false);
    expect(isSafeHttpUrl(42)).toBe(false);
  });
});

describe('descriptionIfDistinct', () => {
  it('jättää kuvauksen pois, kun se toistaa otsikon (poliisin syöte)', () => {
    const raw = {
      title: 'Jalankulkija kuoli liikenneonnettomuudessa Tampereella',
      description: '<p>Jalankulkija kuoli liikenneonnettomuudessa Tampereella</p>',
    };
    expect(
      descriptionIfDistinct(raw, 'Jalankulkija kuoli liikenneonnettomuudessa Tampereella'),
    ).toBeUndefined();
  });

  it('säilyttää kuvauksen, kun se tuo lisätietoa', () => {
    const raw = { description: '<p>Poliisi tutkii tapausta.</p>' };
    expect(descriptionIfDistinct(raw, 'Otsikko')).toBe('Poliisi tutkii tapausta.');
  });

  it('palauttaa undefined, jos kuvausta ei ole', () => {
    expect(descriptionIfDistinct({}, 'Otsikko')).toBeUndefined();
    expect(descriptionIfDistinct(undefined, 'Otsikko')).toBeUndefined();
  });
});
