/**
 * Situation-rivin upsert-logiikka (puhdas, testattavissa).
 *
 * **Miksi olemassa:** aiemmin prosessori loi **aina uuden** `situationId`-ULIDin
 * ja kirjoitti rivin `PutCommand`illa. Lähteet, jotka lähettävät samasta
 * tapahtumasta päivityksiä (FMI: `Alert` + toistuvat `Update`-viestit), tuottivat
 * siksi uuden tilannerivin joka päivityksellä — dev 3.10.2026 sama
 * "Tuulivaroitus maa-alueille" näkyi 12 kertaa.
 *
 * Korjaus: tunniste johdetaan **deterministisesti** `canonicalKey`stä, jolloin
 * sama looginen tilanne osuu aina samaan riviin, ja kirjoitus tehdään
 * `UpdateCommand`illa. Ensimmäinen havainto säilyy (`if_not_exists`), joten
 * päivitys ei nollaa `createdAt`ia eikä `firstSeenAt`ia.
 *
 * Deterministinen tunniste välttää myös uuden GSI:n tarpeen: DynamoDB sallii
 * vain yhden GSI-luonnin tai -poiston per `UpdateTable` (ks. suunnitelma §20),
 * joten `canonicalKey`-indeksiä ei oteta käyttöön.
 */

import { sha256Hex } from '@tampere360/source-adapter-sdk';
import type { Tampere360Event } from '@tampere360/event-contracts';

/** Kuinka kauan suljettu tilanne säilyy taulussa (TTL-päiviä). */
export const RETENTION_DAYS = 30;

/** `UpdateCommand`in parametrit ilman taulun nimeä (Key + lausekkeet). */
export interface SituationUpsert {
  Key: { situationId: string };
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
}

/**
 * Deterministinen tilanteen tunniste `canonicalKey`stä.
 *
 * 26 merkkiä (130 bittiä) on riittävän törmäysturvallinen ja URL-turvallinen
 * (vain hex-merkkejä), joten sitä voi käyttää sellaisenaan polussa
 * (`/v1/situations/{id}`) ja React-avaimena.
 */
export function deriveSituationId(canonicalKey: string): string {
  return sha256Hex(canonicalKey).slice(0, 26);
}

/**
 * Rivin `startsAt` on GSI1–GSI4:n lajitteluavain, ja DynamoDB vaatii sille aina
 * arvon → siihen kirjoitetaan **järjestysaika** (tapahtuman oma aika →
 * julkaisuaika → havaintoaika). Tämä EI ole tapahtuman alkuaika: oikea alkuaika
 * on `event.validity.startsAt`, joka on `null` kun lähde ei kerro sitä (§20).
 */
function sortTimeOf(e: Tampere360Event): string {
  return e.validity?.startsAt ?? e.publishedAt ?? e.firstSeenAt;
}

/**
 * Rakentaa Situation-rivin upsertin.
 *
 * @param e normalisoitu tapahtuma
 * @param nowIso nykyhetki ISO-merkkijonona (päivitysaika)
 * @param nowEpochSeconds nykyhetki sekunteina (TTL-laskentaa varten)
 */
export function buildSituationUpsert(
  e: Tampere360Event,
  nowIso: string,
  nowEpochSeconds: number,
): SituationUpsert {
  const names: Record<string, string> = {
    '#event': 'event',
    '#status': 'status',
    '#category': 'category',
    '#severity': 'severity',
    '#startsAt': 'startsAt',
    '#publishedAt': 'publishedAt',
    '#updatedAt': 'updatedAt',
    '#processingKey': 'processingKey',
    '#canonicalKey': 'canonicalKey',
    '#createdAt': 'createdAt',
    '#firstSeenAt': 'firstSeenAt',
  };
  const values: Record<string, unknown> = {
    ':event': e,
    ':status': e.status,
    ':category': e.category,
    ':severity': e.severity,
    ':startsAt': sortTimeOf(e),
    ':publishedAt': e.publishedAt,
    ':updatedAt': nowIso,
    ':processingKey': e.processingKey,
    ':canonicalKey': e.canonicalKey,
    ':createdAt': nowIso,
    ':firstSeenAt': e.firstSeenAt,
  };
  const sets: string[] = [
    '#event = :event',
    '#status = :status',
    '#category = :category',
    '#severity = :severity',
    '#startsAt = :startsAt',
    '#publishedAt = :publishedAt',
    '#updatedAt = :updatedAt',
    '#processingKey = :processingKey',
    '#canonicalKey = :canonicalKey',
    // Ensimmäinen havainto säilyy: päivitys ei nollaa rivin luontia eikä
    // tapahtuman ensihavaintoa.
    '#createdAt = if_not_exists(#createdAt, :createdAt)',
    '#firstSeenAt = if_not_exists(#firstSeenAt, :firstSeenAt)',
  ];
  const removes: string[] = [];

  // municipality ja geohash ovat sparse-GSI:iden avaimia: arvo asetetaan vain
  // jos se on olemassa, muuten avain poistetaan (REMOVE puuttuvasta attribuutista
  // on DynamoDB:ssä no-op).
  names['#municipality'] = 'municipality';
  if (e.location?.municipality) {
    values[':municipality'] = e.location.municipality;
    sets.push('#municipality = :municipality');
  } else {
    removes.push('#municipality');
  }

  names['#geohash'] = 'geohash';
  if (e.location?.geohash) {
    values[':geohash'] = e.location.geohash;
    sets.push('#geohash = :geohash');
  } else {
    removes.push('#geohash');
  }

  // Suljetulle tilanteelle TTL; aktiiviselta TTL poistetaan (se voi olla jäänyt
  // aiemmasta terminaalitilasta, jos sama rivi aktivoituu uudelleen).
  names['#expiresAt'] = 'expiresAt';
  if (e.status === 'ENDED' || e.status === 'CANCELLED') {
    values[':expiresAt'] = nowEpochSeconds + RETENTION_DAYS * 86400;
    sets.push('#expiresAt = :expiresAt');
  } else {
    removes.push('#expiresAt');
  }

  let updateExpression = `SET ${sets.join(', ')}`;
  if (removes.length > 0) updateExpression += ` REMOVE ${removes.join(', ')}`;

  return {
    Key: { situationId: deriveSituationId(e.canonicalKey) },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}
