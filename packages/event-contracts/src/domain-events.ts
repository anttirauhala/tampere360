/**
 * Tampere247 — EventBridge custom busin domain-tapahtumat (arkkitehtuuri §3).
 *
 * Lähde: 'tampere247', detailType kertoo tapahtuman tyypin.
 * Uudet prosessorit (ilmoitukset, tilastot) liitetään uusina
 * EventBridge-sääntöinä ilman muutoksia putkeen.
 */

import type { EventCategory, Severity, SituationStatus, SourceSystem } from './enums';

/** EventBridge event busin `source`-kenttä. */
export const EVENT_SOURCE = 'tampere247';

/** Domain-tapahtumatyypit. */
export const DomainEventType = {
  /** Raakatapahtuma on jäsennetty ja lähetetty normalisointiin. */
  SourceEventIngested: 'SourceEventIngested',
  /** Normalisoitu lähdetapahtuma (ennen Situation-käsittelyä). */
  SourceEventNormalized: 'SourceEventNormalized',
  /** Uusi kanoninen tilanne havaittu. */
  SituationDiscovered: 'SituationDiscovered',
  /** Kanoninen tilanne päivittynyt (uusi revisio / lähdetapahtuma). */
  SituationUpdated: 'SituationUpdated',
  /** Kanoninen tilanne päättynyt. */
  SituationEnded: 'SituationEnded',
  /** Kanoninen tilanne peruttu lähteessä. */
  SituationCancelled: 'SituationCancelled',
  /** Kaksi tai useampi tilanne yhdistetty (dedup, arkkitehtuuri §4.2). */
  SituationMerged: 'SituationMerged',
} as const;
export type DomainEventType = (typeof DomainEventType)[keyof typeof DomainEventType];

/** `SourceEventIngested`-tapahtuman detail. */
export interface SourceEventIngestedDetail {
  processingKey: string;
  source: SourceSystem;
  sourceId: string;
  batchId: string;
  occurredAt: string;
}

/** Kanonisen tilanteen domain-eventtien yhteinen detail. */
export interface SituationDomainDetail {
  situationId: string;
  category: EventCategory;
  severity: Severity;
  status: SituationStatus;
  /** Otsikko (fi) nopeaan reititykseen ja näyttöön. */
  title: string;
  municipality?: string | null;
  /** Tilanteeseen liitettyjen lähdetapahtumien processingKey:t. */
  sourceEvents: string[];
  occurredAt: string;
}

/**
 * EventBridge-eventin envelope (muoto vastaa AWS:n standardia,
 * `detailType` ja `detail` täyttyvät putkessa).
 */
export interface DomainEventEnvelope<TDetail> {
  version: '0';
  id: string;
  source: typeof EVENT_SOURCE;
  detailType: DomainEventType;
  time: string;
  detail: TDetail;
}
