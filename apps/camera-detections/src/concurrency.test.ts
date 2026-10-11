import { describe, expect, it } from 'vitest';

import { mapLimit } from './concurrency';

describe('mapLimit', () => {
  it('säilyttää järjestyksen', async () => {
    const result = await mapLimit([3, 1, 2], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 10;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it('ei ylitä annettua rinnakkaisuutta', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('käsittelee tyhjän listan ja rajan 0 (tulkitaan 1:ksi)', async () => {
    expect(await mapLimit([], 4, async (value: number) => value)).toEqual([]);
    const result = await mapLimit([1, 2], 0, async (value) => value * 2);
    expect(result).toEqual([2, 4]);
  });

  it('välittää virheen kutsujalle', async () => {
    await expect(
      mapLimit([1, 2], 2, async (value) => {
        if (value === 2) throw new Error('rikki');
        return value;
      }),
    ).rejects.toThrow('rikki');
  });
});
