/**
 * Tampere247Event-runtime-validointi (kevyt, ei ulkoisia riippuvuuksia).
 * Käytetään normalisoinnissa ja prosessorissa ennen DynamoDB-kirjoitusta.
 */

import {
  EventCategory,
  EventType,
  LifecycleStatus,
  Severity,
  SituationStatus,
  SourceSystem,
} from './enums';
import type { Tampere247Event } from './event';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isIsoDate = (value: unknown): boolean =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validoi tuntemattoman arvon Tampere247Event-mallia vasten. */
export function validateTampere247Event(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { ok: false, errors: ['event must be an object'] };
  }

  if (!isNonEmptyString(value.schemaVersion)) errors.push('schemaVersion missing or empty');
  if (!isNonEmptyString(value.id)) errors.push('id missing or empty');
  if (!isNonEmptyString(value.canonicalKey)) errors.push('canonicalKey missing or empty');
  if (!isNonEmptyString(value.processingKey)) errors.push('processingKey missing or empty');
  if (!isNonEmptyString(value.contentHash)) errors.push('contentHash missing or empty');

  // Lähde
  if (!isRecord(value.source)) {
    errors.push('source missing');
  } else {
    const source = value.source;
    if (!isNonEmptyString(source.system) || !(source.system in SourceSystem)) {
      errors.push('source.system invalid');
    }
    if (!isNonEmptyString(source.sourceId)) errors.push('source.sourceId missing or empty');
    if (!isIsoDate(source.fetchedAt)) errors.push('source.fetchedAt invalid timestamp');
  }

  // Enumeraatiot
  if (!isNonEmptyString(value.type) || !(value.type in EventType)) errors.push('type invalid');
  if (!isNonEmptyString(value.category) || !(value.category in EventCategory)) {
    errors.push('category invalid');
  }
  if (!isNonEmptyString(value.severity) || !(value.severity in Severity)) {
    errors.push('severity invalid');
  }
  if (!isNonEmptyString(value.status) || !(value.status in SituationStatus)) {
    errors.push('status invalid');
  }
  if (!isNonEmptyString(value.lifecycle) || !(value.lifecycle in LifecycleStatus)) {
    errors.push('lifecycle invalid');
  }

  // Otsikko: fi pakollinen
  if (!isRecord(value.title) || !isNonEmptyString(value.title.fi)) {
    errors.push('title.fi missing or empty');
  }

  // Sijainti: areaCodes-array pakollinen
  if (!isRecord(value.location)) {
    errors.push('location missing');
  } else if (!Array.isArray(value.location.areaCodes)) {
    errors.push('location.areaCodes must be an array');
  }

  // Aikaleimat
  if (!isIsoDate(value.publishedAt)) errors.push('publishedAt invalid timestamp');
  if (!isIsoDate(value.updatedAt)) errors.push('updatedAt invalid timestamp');

  return { ok: errors.length === 0, errors };
}

/** Tyyppivartija: palauttaa true jos arvo on validi Tampere247Event. */
export function isTampere247Event(value: unknown): value is Tampere247Event {
  return validateTampere247Event(value).ok;
}
