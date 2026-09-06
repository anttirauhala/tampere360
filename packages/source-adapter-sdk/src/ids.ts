/**
 * ULID-tunnisteiden generointi (ei ulkoisia riippuvuuksia).
 * ULID: 26 merkkiä, Crockford base32, aikajärjestystä säilyttävä.
 * Rakenne: 10 merkkiä aikaleima (48 bittiä) + 16 merkkiä satunnaisuus (80 bittiä).
 */

import { randomInt } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let remaining = now;
  let result = '';
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    const mod = remaining % ENCODING_LEN;
    result = ENCODING.charAt(mod) + result;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return result;
}

function encodeRandom(): string {
  let result = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    result += ENCODING.charAt(randomInt(ENCODING_LEN));
  }
  return result;
}

/**
 * Generoi ULID-tunnisteen.
 * @param timestamp Valinnainen aikaleima (ms); oletuksena nykyhetki.
 */
export function ulid(timestamp: number = Date.now()): string {
  return encodeTime(timestamp) + encodeRandom();
}

/** Onko merkkijono kelvollinen ULID (muoto, ei sisältösemantiikkaa)? */
export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
