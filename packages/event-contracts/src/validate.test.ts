import { describe, expect, it } from 'vitest';

import { createSampleEvent } from './sample';
import { isTampere360Event, validateTampere360Event } from './validate';

describe('validateTampere360Event', () => {
  it('hyväksyy kelvollisen tapahtuman', () => {
    const result = validateTampere360Event(createSampleEvent());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('tyyppivartija toimii', () => {
    expect(isTampere360Event(createSampleEvent())).toBe(true);
    expect(isTampere360Event({})).toBe(false);
    expect(isTampere360Event(null)).toBe(false);
  });

  it('hylkää puuttuvan title.fi-kentän', () => {
    const event = createSampleEvent({ title: { fi: '' } });
    const result = validateTampere360Event(event);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('title.fi missing or empty');
  });

  it('hylkää virheellisen kategorian', () => {
    const event = createSampleEvent({ category: 'UNKNOWN' as never });
    const result = validateTampere360Event(event);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('category invalid');
  });

  it('hylkää virheellisen severity-arvon', () => {
    const event = createSampleEvent({ severity: 'CATASTROPHIC' as never });
    const result = validateTampere360Event(event);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('severity invalid');
  });

  it('hylkää puuttuvan source.sourceId-kentän', () => {
    const event = createSampleEvent();
    event.source.sourceId = '';
    const result = validateTampere360Event(event);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('source.sourceId missing or empty');
  });

  it('hylkää virheellisen aikaleiman', () => {
    const event = createSampleEvent({ publishedAt: 'ei-aikaleima' });
    const result = validateTampere360Event(event);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('publishedAt invalid timestamp');
  });

  it('hylkää ei-olio-arvon', () => {
    expect(validateTampere360Event('string').ok).toBe(false);
    expect(validateTampere360Event(null).ok).toBe(false);
    expect(validateTampere360Event([1, 2, 3]).ok).toBe(false);
  });

  it('kerää useita virheitä kerralla', () => {
    const event = createSampleEvent({
      id: '',
      canonicalKey: '',
      contentHash: '',
    });
    const result = validateTampere360Event(event);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
