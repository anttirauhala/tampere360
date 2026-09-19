import { describe, expect, it } from 'vitest';

import { TILE_ORIGINS, buildContentSecurityPolicy } from '../lib/csp';

const API_ORIGIN = 'https://abc123.execute-api.eu-north-1.amazonaws.com';
const csp = buildContentSecurityPolicy({ apiOrigin: API_ORIGIN });

/** Poimii yksittäisen direktiivin CSP-merkkijonosta. */
function directive(name: string): string {
  return csp.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';
}

describe('buildContentSecurityPolicy', () => {
  it('sallii karttatiilet connect-src:ssä (MapLibre hakee tiilet fetch:llä)', () => {
    // Regressiosuoja: pelkkä img-src ei riitä, koska MapLibre käyttää fetchiä.
    for (const origin of TILE_ORIGINS) {
      expect(directive('connect-src')).toContain(origin);
    }
  });

  it('sallii karttatiilet myös img-src:ssä', () => {
    for (const origin of TILE_ORIGINS) {
      expect(directive('img-src')).toContain(origin);
    }
  });

  it('sallii oman API-originin', () => {
    expect(directive('connect-src')).toContain(API_ORIGIN);
  });

  it('sallii MapLibren blob-työntekijät', () => {
    expect(directive('worker-src')).toContain('blob:');
    expect(directive('child-src')).toContain('blob:');
    expect(directive('connect-src')).toContain('blob:');
  });

  it('ei salli eval-kutsuja eikä ulkopuolisia skriptejä', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
  });

  it('kieltää objektit, kehykset ja base-uri:n kaappauksen', () => {
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
  });

  it('kunnioittaa allowBlob=false -asetusta', () => {
    const strict = buildContentSecurityPolicy({ apiOrigin: API_ORIGIN, allowBlob: false });
    expect(strict).not.toContain('blob:');
  });

  it('käyttää annettuja tiili-origineja oletusten sijaan', () => {
    const custom = buildContentSecurityPolicy({
      apiOrigin: API_ORIGIN,
      tileOrigins: ['https://tiles.example.com'],
    });
    expect(custom).toContain('https://tiles.example.com');
    expect(custom).not.toContain('tile.openstreetmap.org');
  });
});
