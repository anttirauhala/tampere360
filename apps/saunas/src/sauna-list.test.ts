import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SAUNA_LIST_URL,
  SaunaUpstreamError,
  fetchSaunaList,
  normalizeSauna,
  normalizeSaunaList,
} from './sauna-list';

/** Yksi sauna lähdemuodossa (rakenteena aidon vastauksen kaltainen). */
function rawSauna(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '19132d75-07d3-42fe-b072-14f56be104af',
    name: 'Apian sauna',
    streetAddress: 'Urheilukatu 20',
    postalCode: '37600',
    city: 'Valkeakoski',
    openingHours: [
      {
        id: 'h1',
        weekday: 'TUESDAY',
        openingTime: '14:00:00',
        closingTime: '21:00:00',
        prices: [{ id: 'p1', priceType: 'ADULT', price: 8 }],
      },
    ],
    phone: '',
    webPage: 'https://apianavantouimarit.fi/',
    info: 'Sauna on avoinna tiistaisin.',
    kiosk: false,
    restaurant: false,
    ...overrides,
  };
}

describe('normalizeSauna', () => {
  it('normalisoi aidon rakenteen ja trimmaa merkkijonot', () => {
    const sauna = normalizeSauna(
      rawSauna({ name: '  Apian sauna  ', kiosk: true, restaurant: true, isNew: true }),
    );
    expect(sauna).not.toBeNull();
    expect(sauna?.name).toBe('Apian sauna');
    expect(sauna?.kiosk).toBe(true);
    expect(sauna?.restaurant).toBe(true);
    expect(sauna?.isNew).toBe(true);
    expect(sauna?.openingHours).toEqual([
      {
        weekday: 'TUESDAY',
        openingTime: '14:00:00',
        closingTime: '21:00:00',
        prices: [{ priceType: 'ADULT', price: 8 }],
      },
    ]);
  });

  it('hyväksyy desimaalihinnat ja pudottaa kelvottomat hinnat', () => {
    const sauna = normalizeSauna(
      rawSauna({
        openingHours: [
          {
            weekday: 'MONDAY',
            openingTime: '10:00:00',
            closingTime: '18:00:00',
            prices: [
              { priceType: 'ADULT', price: 11.7 },
              { priceType: '', price: 5 },
              { priceType: 'CHILD', price: null },
              { priceType: 'STUDENT', price: 5 },
            ],
          },
        ],
      }),
    );
    expect(sauna?.openingHours[0]?.prices).toEqual([
      { priceType: 'ADULT', price: 11.7 },
      { priceType: 'STUDENT', price: 5 },
    ]);
  });

  it('palauttaa tyhjän aukiololistan, kun lähde ei anna aukioloaikoja', () => {
    const sauna = normalizeSauna(rawSauna({ openingHours: [] }));
    expect(sauna?.openingHours).toEqual([]);
  });

  it('hylkää jakson, josta puuttuu viikonpäivä tai kellonaika', () => {
    const sauna = normalizeSauna(
      rawSauna({
        openingHours: [
          { weekday: '', openingTime: '10:00:00', closingTime: '18:00:00', prices: [] },
          { weekday: 'MONDAY', openingTime: '', closingTime: '18:00:00', prices: [] },
          { weekday: 'MONDAY', openingTime: '10:00:00', closingTime: '18:00:00', prices: [] },
        ],
      }),
    );
    expect(sauna?.openingHours).toHaveLength(1);
    expect(sauna?.openingHours[0]?.weekday).toBe('MONDAY');
  });

  it('palauttaa null, jos id tai nimi puuttuu', () => {
    expect(normalizeSauna(rawSauna({ id: '' }))).toBeNull();
    expect(normalizeSauna(rawSauna({ name: '   ' }))).toBeNull();
    expect(normalizeSauna(null)).toBeNull();
    expect(normalizeSauna('ei-olio')).toBeNull();
  });
});

describe('normalizeSaunaList', () => {
  it('normalisoi listan ja pudottaa kelvottomat tietueet', () => {
    const list = normalizeSaunaList([
      rawSauna(),
      { name: 'Ei id:tä' },
      null,
      rawSauna({ id: 'x' }),
    ]);
    expect(list).toHaveLength(2);
    expect(list.map((sauna) => sauna.id)).toEqual(['19132d75-07d3-42fe-b072-14f56be104af', 'x']);
  });

  it('heittää virheen (status 0), jos juurimuoto ei ole taulukko', () => {
    // Tyhjä vastaus ei ole oikea tulkinta muotovirheelle — se on hälytys siitä,
    // että rajapinta on muuttunut (§20: puuttuvaa ei arvata).
    try {
      normalizeSaunaList({ saunas: [] });
      expect.unreachable('pitäisi heittää');
    } catch (error) {
      expect(error).toBeInstanceOf(SaunaUpstreamError);
      expect((error as SaunaUpstreamError).status).toBe(0);
    }
  });

  it('palauttaa tyhjän listan, jos taulukko on tyhjä', () => {
    expect(normalizeSaunaList([])).toEqual([]);
  });
});

describe('fetchSaunaList', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hakee ja normalisoi listan osoitteesta, joka on HTTPS ja application/json', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([rawSauna(), { id: 'x', name: 'Toinen', openingHours: [] }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const list = await fetchSaunaList(5000);

    expect(list).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SAUNA_LIST_URL);
    expect(SAUNA_LIST_URL.startsWith('https://')).toBe(true);
    expect((init.headers as Record<string, string>)['accept']).toBe('application/json');
  });

  it('heittää SaunaUpstreamErrorin tilakoodilla, kun vastaus ei ole 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );

    await expect(fetchSaunaList(5000)).rejects.toMatchObject({
      name: 'SaunaUpstreamError',
      status: 503,
    });
  });
});
