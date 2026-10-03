import { describe, expect, it } from 'vitest';

import type { Sauna, SaunaOpeningHours } from '../api/saunas';
import { sourceLink } from './format';
import {
  SAUNA_SOURCE_URL,
  formatAddress,
  formatClock,
  formatPrice,
  formatSession,
  formatSessions,
  isOpenToday,
  priceTypeLabel,
  saunaPrices,
  saunaTodayStatus,
  saunaTodayTone,
  sortSaunas,
  todayWeekday,
  todaysSessions,
} from './saunas';

function sauna(overrides: Partial<Sauna> = {}): Sauna {
  return {
    id: 's1',
    name: 'Testisauna',
    streetAddress: 'Testikatu 1',
    postalCode: '33100',
    city: 'Tampere',
    openingHours: [],
    phone: '',
    webPage: '',
    info: '',
    kiosk: false,
    restaurant: false,
    isNew: false,
    ...overrides,
  };
}

function hours(
  weekday: string,
  openingTime: string,
  closingTime: string,
  prices: { priceType: string; price: number }[] = [],
): SaunaOpeningHours {
  return { weekday, openingTime, closingTime, prices };
}

describe('todayWeekday', () => {
  it('laskee viikonpäivän Suomen ajassa, ei selaimen aikavyöhykkeellä', () => {
    // 1.10.2026 klo 21:30 UTC = 2.10.2026 klo 00:30 Suomessa → perjantai,
    // vaikka UTC-selaimen kello näyttäisi vielä torstaita.
    expect(todayWeekday(new Date('2026-10-01T21:30:00Z'))).toBe('FRIDAY');
    expect(todayWeekday(new Date('2026-10-01T09:00:00Z'))).toBe('THURSDAY');
  });

  it('toimii myös talviajassa', () => {
    expect(todayWeekday(new Date('2026-01-15T09:00:00Z'))).toBe('THURSDAY');
  });
});

describe('formatClock', () => {
  it('muotoilee kellonajan suomalaisittain', () => {
    expect(formatClock('14:00:00')).toBe('14.00');
    expect(formatClock('9:05')).toBe('09.05');
    expect(formatClock('23:30:00')).toBe('23.30');
  });

  it('palauttaa tyhjän, jos muoto ei täsmää', () => {
    expect(formatClock('')).toBe('');
    expect(formatClock('suljettu')).toBe('');
    expect(formatClock(null)).toBe('');
  });
});

describe('formatSession / formatSessions', () => {
  it('muotoilee yhden jakson ajatusviivalla', () => {
    expect(formatSession(hours('MONDAY', '12:00:00', '21:45:00'))).toBe('12.00–21.45');
  });

  it('yhdistää päivän useat jaksot pilkulla', () => {
    const sessions = [
      hours('TUESDAY', '08:00:00', '12:00:00'),
      hours('TUESDAY', '16:00:00', '22:00:00'),
    ];
    expect(formatSessions(sessions)).toBe('08.00–12.00, 16.00–22.00');
  });
});

describe('todaysSessions / saunaTodayStatus', () => {
  it('poimii vain päivän jaksot', () => {
    const s = sauna({
      openingHours: [
        hours('MONDAY', '10:00:00', '18:00:00'),
        hours('TUESDAY', '10:00:00', '18:00:00'),
      ],
    });
    expect(todaysSessions(s, 'TUESDAY')).toHaveLength(1);
  });

  it('näyttää päivän aukioloajan', () => {
    const s = sauna({ openingHours: [hours('TUESDAY', '14:00:00', '21:00:00')] });
    expect(saunaTodayStatus(s, 'TUESDAY')).toBe('14.00–21.00');
  });

  it('kertoo, ettei aukioloa ole tänään, jos saunalla on muita päiviä', () => {
    const s = sauna({ openingHours: [hours('MONDAY', '10:00:00', '18:00:00')] });
    expect(saunaTodayStatus(s, 'TUESDAY')).toBe('Ei aukioloa tänään');
  });

  it('kertoo, ettei aukioloaikoja ole, kun lähde ei anna yhtään (esim. remontti)', () => {
    const s = sauna({ openingHours: [] });
    expect(saunaTodayStatus(s, 'TUESDAY')).toBe('Ei aukioloaikoja');
  });
});

describe('priceTypeLabel', () => {
  it('kääntää tunnetut hintaluokat suomeksi', () => {
    expect(priceTypeLabel('ADULT')).toBe('Aikuinen');
    expect(priceTypeLabel('CHILD')).toBe('Lapsi');
    expect(priceTypeLabel('STUDENT')).toBe('Opiskelija');
    expect(priceTypeLabel('PENSIONER')).toBe('Eläkeläinen');
    expect(priceTypeLabel('UNEMPLOYED')).toBe('Työtön');
    // Lähteen kirjoitusasu on CONSRIPT (sic) — se on tunnettu, ei kaadeta.
    expect(priceTypeLabel('CONSRIPT')).toBe('Varusmies');
  });

  it('näyttää tuntemattoman luokan siistittynä', () => {
    expect(priceTypeLabel('FAMILY')).toBe('Family');
    expect(priceTypeLabel('')).toBe('Hinta');
  });
});

describe('formatPrice', () => {
  it('näyttää tasaeuron ilman desimaaleja', () => {
    expect(formatPrice(8)).toBe('8 €');
  });

  it('näyttää desimaalit suomalaisella pilkulla', () => {
    expect(formatPrice(11.7)).toBe('11,70 €');
  });
});

describe('saunaPrices', () => {
  it('näyttää päivän hinnat ja poistaa toistot', () => {
    const s = sauna({
      openingHours: [
        hours('TUESDAY', '08:00:00', '12:00:00', [
          { priceType: 'ADULT', price: 15 },
          { priceType: 'STUDENT', price: 13 },
        ]),
        hours('TUESDAY', '16:00:00', '22:00:00', [
          { priceType: 'ADULT', price: 15 },
          { priceType: 'STUDENT', price: 13 },
        ]),
      ],
    });
    const prices = saunaPrices(s, 'TUESDAY');
    expect(prices.map((p) => `${p.label} ${p.price}`)).toEqual(['Aikuinen 15', 'Opiskelija 13']);
  });

  it('palauttaa koko viikon hinnat, jos tänään ei ole aukioloa (hinta ei katoa)', () => {
    const s = sauna({
      openingHours: [hours('MONDAY', '10:00:00', '18:00:00', [{ priceType: 'ADULT', price: 10 }])],
    });
    expect(saunaPrices(s, 'TUESDAY')).toEqual([
      { priceType: 'ADULT', label: 'Aikuinen', price: 10 },
    ]);
  });

  it('palauttaa tyhjän, jos hintoja ei ole', () => {
    const s = sauna({ openingHours: [hours('MONDAY', '10:00:00', '18:00:00')] });
    expect(saunaPrices(s, 'MONDAY')).toEqual([]);
  });
});

describe('formatAddress', () => {
  it('kokoaa katuosoitteen ja postinumeron kaupungin', () => {
    expect(
      formatAddress(
        sauna({ streetAddress: 'Urheilukatu 20', postalCode: '37600', city: 'Valkeakoski' }),
      ),
    ).toBe('Urheilukatu 20, 37600 Valkeakoski');
  });

  it('jättää puuttuvat osat pois', () => {
    expect(formatAddress(sauna({ streetAddress: 'Katu 1', postalCode: '', city: 'Nokia' }))).toBe(
      'Katu 1, Nokia',
    );
  });
});

describe('isOpenToday / saunaTodayTone', () => {
  it('tunnistaa auki olevan ja suljetun päivän', () => {
    const open = sauna({ openingHours: [hours('MONDAY', '10:00:00', '18:00:00')] });
    const closed = sauna({ openingHours: [hours('TUESDAY', '10:00:00', '18:00:00')] });

    expect(isOpenToday(open, 'MONDAY')).toBe(true);
    expect(saunaTodayTone(open, 'MONDAY')).toBe('open');
    expect(isOpenToday(closed, 'MONDAY')).toBe(false);
    expect(saunaTodayTone(closed, 'MONDAY')).toBe('closed');
  });

  it('pitää saunaa, jolla ei ole yhtään aukioloa (remontti), suljettuna', () => {
    expect(saunaTodayTone(sauna({ openingHours: [] }), 'MONDAY')).toBe('closed');
  });
});

describe('sortSaunas', () => {
  it('nostaa tänään auki olevat ensin ja järjestää kummatkin ryhmät nimen mukaan', () => {
    const list = [
      sauna({
        id: '1',
        name: 'Yrjön sauna',
        openingHours: [hours('MONDAY', '10:00:00', '18:00:00')],
      }),
      sauna({
        id: '2',
        name: 'Zeta sauna',
        openingHours: [hours('TUESDAY', '10:00:00', '18:00:00')],
      }),
      sauna({
        id: '3',
        name: 'Aallon sauna',
        openingHours: [hours('MONDAY', '10:00:00', '18:00:00')],
      }),
      sauna({
        id: '4',
        name: 'Bertan sauna',
        openingHours: [hours('TUESDAY', '10:00:00', '18:00:00')],
      }),
    ];

    // Auki maanantaina: Aallon sauna, Yrjön sauna (aakkosissa).
    // Kiinni maanantaina: Bertan sauna, Zeta sauna (aakkosissa).
    expect(sortSaunas(list, 'MONDAY').map((s) => s.name)).toEqual([
      'Aallon sauna',
      'Yrjön sauna',
      'Bertan sauna',
      'Zeta sauna',
    ]);
  });

  it('järjestää ryhmän sisällä suomalaisessa aakkosjärjestyksessä (Å, Ä, Ö lopussa)', () => {
    const list = [
      sauna({
        id: '1',
        name: 'Östersundin sauna',
        openingHours: [hours('MONDAY', '10:00:00', '18:00:00')],
      }),
      sauna({
        id: '2',
        name: 'Aalto',
        openingHours: [hours('MONDAY', '10:00:00', '18:00:00')],
      }),
      sauna({
        id: '3',
        name: 'Åbyn sauna',
        openingHours: [hours('MONDAY', '10:00:00', '18:00:00')],
      }),
    ];
    expect(sortSaunas(list, 'MONDAY').map((s) => s.name)).toEqual([
      'Aalto',
      'Åbyn sauna',
      'Östersundin sauna',
    ]);
  });

  it('ei mutatoi alkuperäistä taulukkoa', () => {
    const list = [
      sauna({ id: 'b', name: 'Bertta', openingHours: [hours('TUESDAY', '10:00:00', '18:00:00')] }),
      sauna({ id: 'a', name: 'Aada', openingHours: [hours('MONDAY', '10:00:00', '18:00:00')] }),
    ];
    const sorted = sortSaunas(list, 'MONDAY');
    expect(list[0]?.id).toBe('b');
    expect(sorted[0]?.id).toBe('a');
  });
});

describe('SAUNA_SOURCE_URL', () => {
  it('osoittaa saunahaku.fi-palveluun https:nä ja antaa otsikoksi verkkotunnuksen', () => {
    // Regressiosuoja: sivun lead-teksti, alahuomautus ja footteri käyttävät
    // samaa vakiota. `sourceLink` hyväksyy vain http(s)-osoitteet, joten sen
    // tulos on turvallinen renderöidä sellaisenaan (§14).
    const link = sourceLink(SAUNA_SOURCE_URL);
    expect(link).not.toBeNull();
    expect(link?.href).toBe('https://saunahaku.fi/');
    expect(link?.label).toBe('saunahaku.fi');
  });

  it('on https-osoite (ei http, ei javascript)', () => {
    expect(SAUNA_SOURCE_URL.startsWith('https://')).toBe(true);
  });
});
