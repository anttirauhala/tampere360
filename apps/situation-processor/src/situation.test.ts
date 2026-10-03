import { describe, expect, it } from 'vitest';

import { createSampleEvent } from '@tampere360/event-contracts';

import { buildSituationUpsert, deriveSituationId } from './situation';

const NOW_ISO = '2026-10-03T09:00:00.000Z';
const NOW_EPOCH = Math.floor(Date.parse(NOW_ISO) / 1000);

describe('deriveSituationId', () => {
  it('on deterministinen: sama canonicalKey → sama tunniste', () => {
    const key = 'FMI_CAP:304779733920130434618294129618267851721';
    expect(deriveSituationId(key)).toBe(deriveSituationId(key));
  });

  it('antaa eri tunnisteen eri avaimille', () => {
    expect(deriveSituationId('FMI_CAP:a')).not.toBe(deriveSituationId('FMI_CAP:b'));
  });

  it('on URL-turvallinen hex ja 26 merkkiä', () => {
    const id = deriveSituationId('FMI_CAP:304779733920130434618294129618267851721');
    expect(id).toMatch(/^[0-9a-f]{26}$/);
  });
});

describe('buildSituationUpsert', () => {
  it('avain johdetaan canonicalKeystä (päivitys osuu samaan riviin)', () => {
    const key = 'FMI_CAP:304779733920130434618294129618267851721';
    const upsert = buildSituationUpsert(
      createSampleEvent({ canonicalKey: key }),
      NOW_ISO,
      NOW_EPOCH,
    );
    expect(upsert.Key.situationId).toBe(deriveSituationId(key));
  });

  it('säilyttää ensimmäisen havainnon (createdAt/firstSeenAt if_not_exists)', () => {
    const upsert = buildSituationUpsert(createSampleEvent(), NOW_ISO, NOW_EPOCH);
    expect(upsert.UpdateExpression).toContain('#createdAt = if_not_exists(#createdAt, :createdAt)');
    expect(upsert.UpdateExpression).toContain(
      '#firstSeenAt = if_not_exists(#firstSeenAt, :firstSeenAt)',
    );
  });

  it('käyttää alkuaikaa lajitteluavaimena, kun se on tiedossa', () => {
    const upsert = buildSituationUpsert(
      createSampleEvent({
        validity: { startsAt: '2026-09-06T09:00:00.000Z', endsAt: null },
      }),
      NOW_ISO,
      NOW_EPOCH,
    );
    expect(upsert.ExpressionAttributeValues[':startsAt']).toBe('2026-09-06T09:00:00.000Z');
  });

  it('putoaa julkaisuaikaan, kun alkuaika puuttuu', () => {
    const upsert = buildSituationUpsert(
      createSampleEvent({
        validity: { startsAt: null, endsAt: null },
        publishedAt: '2026-09-06T08:46:15.000Z',
      }),
      NOW_ISO,
      NOW_EPOCH,
    );
    expect(upsert.ExpressionAttributeValues[':startsAt']).toBe('2026-09-06T08:46:15.000Z');
  });

  it('putoaa havaintoaikaan, kun alkuaika ja julkaisuaika puuttuvat', () => {
    const upsert = buildSituationUpsert(
      createSampleEvent({
        validity: { startsAt: null, endsAt: null },
        publishedAt: null,
        firstSeenAt: '2026-09-06T08:50:00.000Z',
      }),
      NOW_ISO,
      NOW_EPOCH,
    );
    expect(upsert.ExpressionAttributeValues[':startsAt']).toBe('2026-09-06T08:50:00.000Z');
  });

  it('aktiivinen tilanne: expiresAt poistetaan (REMOVE)', () => {
    const upsert = buildSituationUpsert(
      createSampleEvent({ status: 'ACTIVE' }),
      NOW_ISO,
      NOW_EPOCH,
    );
    expect(upsert.UpdateExpression).toContain('REMOVE');
    expect(upsert.UpdateExpression).toContain('#expiresAt');
    expect(upsert.ExpressionAttributeValues[':expiresAt']).toBeUndefined();
  });

  it('terminaalinen tilanne: expiresAt asetetaan (SET, 30 pv)', () => {
    const upsert = buildSituationUpsert(
      createSampleEvent({ status: 'CANCELLED' }),
      NOW_ISO,
      NOW_EPOCH,
    );
    expect(upsert.UpdateExpression).toContain('#expiresAt = :expiresAt');
    expect(upsert.ExpressionAttributeValues[':expiresAt']).toBe(NOW_EPOCH + 30 * 86400);
  });

  it('municipality asetetaan kun se on olemassa', () => {
    const upsert = buildSituationUpsert(
      createSampleEvent({
        location: {
          municipality: 'Tampere',
          district: null,
          address: null,
          latitude: null,
          longitude: null,
          geometry: null,
          areaCodes: ['TAMPERE'],
        },
      }),
      NOW_ISO,
      NOW_EPOCH,
    );
    expect(upsert.UpdateExpression).toContain('#municipality = :municipality');
    expect(upsert.ExpressionAttributeValues[':municipality']).toBe('Tampere');
  });

  it('municipality poistetaan kun sitä ei ole (sparse-GSI)', () => {
    const upsert = buildSituationUpsert(
      createSampleEvent({
        location: {
          municipality: null,
          district: null,
          address: null,
          latitude: null,
          longitude: null,
          geometry: null,
          areaCodes: ['PIRKANMAA'],
        },
      }),
      NOW_ISO,
      NOW_EPOCH,
    );
    expect(upsert.UpdateExpression).toContain('REMOVE');
    expect(upsert.UpdateExpression).toContain('#municipality');
    expect(upsert.ExpressionAttributeValues[':municipality']).toBeUndefined();
  });

  it('päivittää tapahtuman sisällön ja tilan', () => {
    const event = createSampleEvent({ status: 'ACTIVE' });
    const upsert = buildSituationUpsert(event, NOW_ISO, NOW_EPOCH);
    expect(upsert.ExpressionAttributeValues[':event']).toBe(event);
    expect(upsert.ExpressionAttributeValues[':status']).toBe('ACTIVE');
    expect(upsert.ExpressionAttributeValues[':updatedAt']).toBe(NOW_ISO);
    expect(upsert.ExpressionAttributeValues[':processingKey']).toBe(event.processingKey);
  });
});
