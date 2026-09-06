/**
 * EventSourceAdapter-rajapinta (arkkitehtuuri §10).
 *
 * Jokaisella tietolähteellä on oma adapterinsa. Pelastustoimen lähteen
 * vaihtaminen (Peto → uusi mediapalvelu) tarkoittaa vain uutta toteutusta
 * tähän rajapintaan — normalisoija ja käyttöliittymä näkevät saman tyypin.
 *
 * Adapteri vastaa vain:
 * - datan hakeminen
 * - lähteen formaatin jäsentäminen
 * - teknisen metadatan lisääminen
 * - raakadatan tallentaminen (S3)
 * - raakatapahtuman lähettäminen käsittelyjonoon (SQS)
 *
 * Adapteri EI tee lopullista liiketoimintaluokittelua.
 */

import type {
  FetchContext,
  ParsedSourceEvent,
  RawSourceBatch,
  SourceCheckpoint,
  SourceSystem,
} from '@tampere247/event-contracts';

export interface EventSourceAdapter {
  /** Lähdejärjestelmä, jota adapteri edustaa. */
  readonly source: SourceSystem;

  /**
   * Hakee raakadatan lähteestä ja tallentaa sen S3:een.
   * Palauttaa erän metadatan (batchId, s3Key, contentHash, ...).
   */
  fetch(context: FetchContext): Promise<RawSourceBatch>;

  /**
   * Jäsentää raakaerän koneellisesti käsiteltäviksi tapahtumiksi.
   * Adapteri lisää teknisen metadatan (sourceId, revision, processingKey),
   * mutta EI tee liiketoimintaluokittelua.
   */
  parse(batch: RawSourceBatch): Promise<ParsedSourceEvent[]>;

  /**
   * Muodostaa lähdekohtaisen tilatiedon IngestionState-tauluun.
   */
  checkpoint(batch: RawSourceBatch): Promise<SourceCheckpoint>;
}

/**
 * Luo FetchContextin Lambda-käsittelijälle.
 * @param environment Ympäristö: dev | test | prod
 * @param invocationId Lambda-invokaation ULID-tunniste
 */
export function createFetchContext(
  environment: string,
  invocationId: string,
): FetchContext {
  return {
    invocationId,
    environment,
    startedAt: new Date().toISOString(),
  };
}
