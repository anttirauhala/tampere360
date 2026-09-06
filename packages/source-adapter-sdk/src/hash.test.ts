import { describe, expect, it } from 'vitest';

import { buildProcessingKey, sha256Hex } from './hash';

describe('sha256Hex', () => {
  it('tuottaa tunnetun tarkisteen tyhjälle merkkijonolle', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('tuottaa tunnetun tarkisteen "abc"-merkkijonolle', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('tuottaa eri tarkisteen eri sisällöille', () => {
    expect(sha256Hex('sisältö A')).not.toBe(sha256Hex('sisältö B'));
  });
});

describe('buildProcessingKey', () => {
  it('käyttää revisiota, kun sellainen on', () => {
    const key = buildProcessingKey({
      source: 'TAMPERE_TRAFFIC',
      sourceId: 'incident-12345',
      revision: '3',
    });
    expect(key).toBe('TAMPERE_TRAFFIC:incident-12345:3');
  });

  it('muodostaa tarkistepohjaisen avaimen ilman revisiota', () => {
    const key = buildProcessingKey({
      source: 'FMI_CAP',
      sourceId: 'urn:oid:2.49.0.1.246.0.0.2026.example',
      content: 'Keltainen tuulivaroitus',
    });
    expect(key).toMatch(/^FMI_CAP:urn:oid:2\.49\.0\.1\.246\.0\.0\.2026\.example:[0-9a-f]{16}$/);
  });

  it('on deterministinen samoilla syötteillä', () => {
    const input = { source: 'POLICE_RSS', sourceId: 'tiedote-1', content: 'sama' };
    expect(buildProcessingKey(input)).toBe(buildProcessingKey(input));
  });

  it('eri sisältö tuottaa eri avaimen ilman revisiota', () => {
    const a = buildProcessingKey({ source: 'POLICE_RSS', sourceId: 'x', content: 'A' });
    const b = buildProcessingKey({ source: 'POLICE_RSS', sourceId: 'x', content: 'B' });
    expect(a).not.toBe(b);
  });
});
