/**
 * Tarkisteet ja idempotenssiavaimet (arkkitehtuuri §4.1).
 */

import { createHash } from 'node:crypto';

/** SHA-256 heksamuodossa. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface ProcessingKeyInput {
  /** Lähdejärjestelmä, esim. "FMI_CAP". */
  source: string;
  /** Lähdejärjestelmän oma tunniste tapahtumalle. */
  sourceId: string;
  /** Lähdejärjestelmän revisio (esim. version-numero), jos saatavilla. */
  revision?: string;
  /** Relevantti sisältö tarkisteen pohjaksi, jos revisiota ei ole. */
  content?: string;
}

/**
 * Idempotentti käsittelyavain (arkkitehtuuri §4.1):
 * - jos revisio on: `source:sourceId:revision`
 * - muuten: `source:sourceId:SHA-256(source+sourceId+content)[0..16]`
 *
 * Avainta käytetään ehdollisen DynamoDB-kirjoituksen ehtona
 * (`attribute_not_exists(processingKey)`), jolloin saman lähdeviestin
 * uudelleenkäsittely ei luo uutta tapahtumaa.
 */
export function buildProcessingKey(input: ProcessingKeyInput): string {
  const { source, sourceId, revision, content } = input;
  if (revision && revision.trim().length > 0) {
    return `${source}:${sourceId}:${revision.trim()}`;
  }
  const hash = sha256Hex(`${source}:${sourceId}:${content ?? ''}`).slice(0, 16);
  return `${source}:${sourceId}:${hash}`;
}
