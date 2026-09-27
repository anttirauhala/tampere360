import { describe, expect, it } from 'vitest';

import { createStopCoverageTracker } from './coverage';

/** Keksitty kello, jota siirretään käsin — testi ei riipu oikeasta ajasta. */
function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Oletusasetukset: 3 epäonnistumista 2 min sisällä, merkintä 30 min. */
function createTracker(overrides: Partial<Parameters<typeof createStopCoverageTracker>[0]> = {}) {
  const clock = createClock();
  const tracker = createStopCoverageTracker({
    failureThreshold: 3,
    failureWindowMs: 120_000,
    uncoveredTtlMs: 30 * 60_000,
    maxEntries: 10,
    now: clock.now,
    ...overrides,
  });
  return { clock, tracker };
}

describe('createStopCoverageTracker', () => {
  it('merkitsee pysäkin vasta kolmannesta peräkkäisestä epäonnistumisesta', () => {
    const { tracker } = createTracker();
    // Toinen pysäkki vastasi onnistuneesti → vika ei ole koko lähteessä.
    tracker.recordSuccess('1409');

    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.recordFailure('6833')).toBe(true);
    expect(tracker.isUncovered('6833')).toBe(true);
  });

  it('ei merkitse pysäkkiä, jos yksikään toinen pysäkki ei ole vastannut', () => {
    const { tracker } = createTracker();

    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.recordFailure('6833')).toBe(false);
    // Koko lähde on alhaalla: 3. virhe ei merkitse pysäkkiä.
    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.isUncovered('6833')).toBe(false);
  });

  it('merkitsee, kun toinen pysäkki vastaa epäonnistumisten aikana', () => {
    const { tracker } = createTracker();

    tracker.recordFailure('6833');
    // Lähde vastaa toiselle pysäkille → vika on tässä pysäkissä.
    tracker.recordSuccess('1409');
    tracker.recordFailure('6833');

    expect(tracker.recordFailure('6833')).toBe(true);
    expect(tracker.isUncovered('6833')).toBe(true);
  });

  it('ei merkitse, jos onnistunut haku on vanhempi kuin ensimmäinen epäonnistuminen', () => {
    const { clock, tracker } = createTracker();
    tracker.recordSuccess('1409');
    clock.advance(10_000);

    tracker.recordFailure('6833');
    tracker.recordFailure('6833');
    // Onnistumisesta kului 10 s ennen virheiden alkua → ei todistetta siitä,
    // että lähde toimisi juuri nyt.
    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.isUncovered('6833')).toBe(false);
  });

  it('nollaa laskurin, kun onnistunut haku tulee välissä', () => {
    const { tracker } = createTracker();
    tracker.recordSuccess('1409');

    tracker.recordFailure('6833');
    tracker.recordFailure('6833');
    tracker.recordSuccess('6833');
    expect(tracker.isUncovered('6833')).toBe(false);

    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.recordFailure('6833')).toBe(true);
  });

  it('nollaa laskurin, kun epäonnistumiset ovat liian kaukana toisistaan', () => {
    const { clock, tracker } = createTracker();
    tracker.recordSuccess('1409');

    tracker.recordFailure('6833');
    clock.advance(121_000);
    tracker.recordFailure('6833');
    clock.advance(121_000);
    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.isUncovered('6833')).toBe(false);
  });

  it('poistaa merkinnän, kun sen voimassaoloaika on kulunut', () => {
    const { clock, tracker } = createTracker();
    tracker.recordSuccess('1409');
    tracker.recordFailure('6833');
    tracker.recordFailure('6833');
    tracker.recordFailure('6833');
    expect(tracker.isUncovered('6833')).toBe(true);

    clock.advance(30 * 60_000);
    expect(tracker.isUncovered('6833')).toBe(false);

    // Merkinnän jälkeen laskenta alkaa alusta: yksi virhe ei riitä uuteen.
    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.isUncovered('6833')).toBe(false);
  });

  it('palauttaa false, kun pysäkki on jo merkitty', () => {
    const { tracker } = createTracker();
    tracker.recordSuccess('1409');
    tracker.recordFailure('6833');
    tracker.recordFailure('6833');
    tracker.recordFailure('6833');

    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.isUncovered('6833')).toBe(true);
  });

  it('käsittelee pysäkit erillään toisistaan', () => {
    const { tracker } = createTracker();
    tracker.recordSuccess('1409');

    tracker.recordFailure('6833');
    tracker.recordFailure('6837');
    tracker.recordFailure('6833');
    tracker.recordFailure('6837');
    tracker.recordFailure('6833');
    tracker.recordFailure('6837');

    expect(tracker.isUncovered('6833')).toBe(true);
    expect(tracker.isUncovered('6837')).toBe(true);
    expect(tracker.isUncovered('1409')).toBe(false);
    expect(tracker.isUncovered('0015')).toBe(false);
  });

  it('rajaa muistissa pidettävien pysäkkien määrän', () => {
    const { tracker } = createTracker({ maxEntries: 2 });
    tracker.recordSuccess('1409');

    tracker.recordFailure('a');
    tracker.recordFailure('a');
    tracker.recordFailure('a');
    tracker.recordFailure('b');
    tracker.recordFailure('c');

    // Vanhin (a) putosi pois rajauksen takia → merkintäkin katosi.
    expect(tracker.isUncovered('a')).toBe(false);
    expect(tracker.isUncovered('b')).toBe(false);
  });

  it('kunnioittaa mukautettua kynnystä', () => {
    const { tracker } = createTracker({ failureThreshold: 2 });
    tracker.recordSuccess('1409');

    expect(tracker.recordFailure('6833')).toBe(false);
    expect(tracker.recordFailure('6833')).toBe(true);
  });
});
