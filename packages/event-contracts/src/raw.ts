/**
 * Tampere247 — keräysputken raakadatatyypit (arkkitehtuuri §1–2).
 *
 * Adapteri: fetch → raakadata S3:een → RawSourceBatch → parse →
 * ParsedSourceEvent[] → SQS → normalisointi.
 */

import type { IngestionStatus, SourceSystem } from './enums';

/** Lambda-invokaation konteksti (correlation ID -ketjun alku). */
export interface FetchContext {
  /** Unikkoa kutsumistunniste (ULID). */
  invocationId: string;
  /** Ympäristö: dev | test | prod. */
  environment: string;
  /** Haun aloitusaika (ISO 8601). */
  startedAt: string;
}

/**
 * Lähde-erä: yksi onnistunut haku lähteestä.
 * Raakapayload on tallennettu S3:een (s3Key); body vain poikkeustapauksissa.
 */
export interface RawSourceBatch {
  /** Erän tunniste (ULID). */
  batchId: string;
  source: SourceSystem;
  fetchedAt: string;
  /** S3-avain raakadataan, esim. "source=fmi-cap/year=2026/month=09/...". */
  s3Key?: string;
  contentType: string;
  byteSize: number;
  /** Raakapayloadin SHA-256 (muutostunnistus + idempotenssi). */
  contentHash: string;
  /** Valinnainen inline-payload pienille vastauksille. */
  body?: string;
  /** HTTP-ehdot: seuraavan haun If-None-Match. */
  etag?: string;
  lastModified?: string;
  /** Lähdekohtainen jatkuvuusosoitin (esim. viimeisin käsitelty guid). */
  cursor?: string | null;
  itemCount?: number;
}

/** Yksi lähteestä jäsennetty tapahtuma, matkalla normalisointiin. */
export interface ParsedSourceEvent {
  /** Jäsennyksen tuottama tunniste (ULID). */
  parsedId: string;
  /** Mihin erään tapahtuma kuuluu. */
  batchId: string;
  source: SourceSystem;
  /** Lähdejärjestelmän oma tunniste. */
  sourceId: string;
  /** Lähdejärjestelmän revisio, jos sellainen on. */
  revision?: string;
  /**
   * Idempotenssiavain (arkkitehtuuri §4.1).
   * Muodostetaan source-adapter-sdk:n buildProcessingKey-funktiolla.
   */
  processingKey: string;
  /** Jäsennetty lähdetietue sellaisenaan (normalisointi tulkitsee). */
  raw: unknown;
  extractedAt: string;
}

/** Lähdekohtainen tekninen tila (IngestionState-taulu, arkkitehtuuri §6). */
export interface SourceCheckpoint {
  source: SourceSystem;
  lastSuccessfulFetch: string;
  etag?: string;
  lastModified?: string;
  cursor?: string | null;
  status: IngestionStatus;
  itemsReceived: number;
  /** Virheilmoitus, jos status = ERROR. */
  error?: string;
}
