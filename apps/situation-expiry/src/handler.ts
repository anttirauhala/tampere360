/**
 * situation-expiry — vanhentuneiden tilanteiden sulkeminen (arkkitehtuuri §5).
 *
 * Ajetaan EventBridge Schedulerilla (oletus 5 min). Skannaa Situations-taulun
 * ja sulkee ACTIVE-rivit, jotka
 *   1. ovat ohittaneet oman `validity.endsAt`-aikansa, tai
 *   2. joiden `canonicalKey`llä on jo terminaalitilainen rivi
 *      (esim. FMI:n peruutusviesti).
 *
 * Suljetulle riville asetetaan `expiresAt`-TTL (oletus 30 pv), joten taulu
 * siivotaan itsestään eikä `/v1/situations?status=ACTIVE` enää palauta
 * päättyneitä tapahtumia.
 *
 * Ilman tätä siivousta lähteet, jotka eivät ilmoita päättymistä (FMI poistaa
 * varoituksen syötteestä, Nysse ei päivitä alerttia) jäisivät näkyviin
 * aktiivisina 90 päivän TTL:ään asti.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createLogger } from '@tampere360/observability';

import { type SituationRow, planExpirations } from './expiry';

const logger = createLogger({
  service: 'situation-expiry',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});
const client = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(client);

/** Kuinka kauan suljettu tilanne säilyy taulussa (TTL-päiviä). */
const RETENTION_DAYS = 30;

/** Lukee kaikki rivit (taulu on pieni; skannaus tehdään harvoin). */
async function readRows(tableName: string): Promise<SituationRow[]> {
  const rows: SituationRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'situationId, #s, canonicalKey, event.validity.endsAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      const validity = (item.event as { validity?: { endsAt?: unknown } } | undefined)?.validity;
      rows.push({
        situationId: typeof item.situationId === 'string' ? item.situationId : '',
        status: typeof item.status === 'string' ? item.status : '',
        canonicalKey: typeof item.canonicalKey === 'string' ? item.canonicalKey : null,
        endsAt: typeof validity?.endsAt === 'string' ? validity.endsAt : null,
      });
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return rows;
}

/** Sulkee yhden tilanteen: status + TTL. Ei kaada ajoa yksittäiseen virheeseen. */
async function retire(
  tableName: string,
  retirement: { situationId: string; status: string },
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { situationId: retirement.situationId },
        UpdateExpression: 'SET #s = :s, updatedAt = :now, expiresAt = :ttl',
        // Vain ACTIVE-rivi suljetaan — samanaikainen lähdepäivitys ei ylikirjoitu.
        ConditionExpression: '#s = :active',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': retirement.status,
          ':now': new Date().toISOString(),
          ':ttl': now + RETENTION_DAYS * 86400,
          ':active': 'ACTIVE',
        },
      }),
    );
    return true;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name !== 'ConditionalCheckFailedException') {
      logger.error('Sulkeminen epäonnistui', {
        situationId: retirement.situationId,
        error: String(err),
      });
    }
    return false;
  }
}

export async function handler(): Promise<{ checked: number; retired: number }> {
  const tableName = process.env['SITUATIONS_TABLE_NAME'] ?? '';
  const rows = await readRows(tableName);
  const retirements = planExpirations(rows, Date.now());

  let retired = 0;
  for (const retirement of retirements) {
    if (await retire(tableName, retirement)) retired += 1;
  }

  logger.info('Siivous valmis', {
    checked: rows.length,
    candidates: retirements.length,
    retired,
    reasons: retirements.map((r) => r.reason),
  });
  return { checked: rows.length, retired };
}
