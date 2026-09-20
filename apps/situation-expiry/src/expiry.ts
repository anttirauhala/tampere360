/**
 * Tilanteiden vanhentumisen suunnittelu (puhdas logiikka, testattavissa).
 *
 * **Miksi tämä on olemassa:** lähteet eivät aina ilmoita tapahtuman päättymistä.
 * FMI esimerkiksi *poistaa* päättyneet varoitukset syötteestä, joten lopetusta
 * ei koskaan saavu — ja kun normalisoija kirjoitti tilan aina `ACTIVE`, varoitus
 * jäi näkyviin aktiivisena ikuisesti (dev 20.9.2026: `endsAt` 10:00, yhä
 * ACTIVE klo 17).
 *
 * Siivous hoitaa kaksi tapausta:
 *  1. **Aika:** tilanteen oma `validity.endsAt` on ohitettu (`VALIDITY_ENDED`).
 *  2. **Lähde:** samalla `canonicalKey`llä on jo terminaalitilainen rivi
 *     (`ENDED`/`CANCELLED`) — esim. FMI:n peruutusviesti (`VALIDITY_ENDED` sijaan
 *     lähdetila), jolloin vanha ACTIVE-rivi pitää sulkea samalla statuksella.
 *
 * HUOM: tämä ei muuta taulun rakennetta eikä vaadi uutta GSI:tä — taulukko on
 * pieni ja skannaus tehdään harvoin (oletus 5 min välein).
 */

/** Taulun rivi siltä osin kuin siivous tarvitsee. */
export interface SituationRow {
  situationId: string;
  status: string;
  canonicalKey?: string | null;
  /** Tapahtuman päättymisaika (event.validity.endsAt), ISO 8601 tai null. */
  endsAt?: string | null;
}

export type RetirementReason = 'VALIDITY_ENDED' | 'SOURCE_ENDED' | 'SOURCE_CANCELLED';

export interface Retirement {
  situationId: string;
  status: 'ENDED' | 'CANCELLED';
  reason: RetirementReason;
}

const TERMINAL = new Set(['ENDED', 'CANCELLED']);

/** Kertoo, onko aikaleima menneisyydessä suhteessa `nowMs`. */
function isPast(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms < nowMs;
}

/**
 * Suunnittelee vanhentuneiden tilanteiden sulkemisen.
 *
 * @param items taulun rivit (kaikki, myös terminaaliset)
 * @param nowMs nykyhetki millisekunteina
 * @returns suljettavat rivit (tyhjä, jos mitään ei tarvitse tehdä)
 */
export function planExpirations(items: SituationRow[], nowMs: number): Retirement[] {
  // Terminaaliset tilat canonicalKeyn mukaan: suljetaan niiden ACTIVE-sisarukset.
  // CANCELLED voittaa ENDEDin, jos molempia esiintyy.
  const terminalByKey = new Map<string, 'ENDED' | 'CANCELLED'>();
  for (const item of items) {
    const key = item.canonicalKey;
    if (!key || !TERMINAL.has(item.status)) continue;
    const status = item.status as 'ENDED' | 'CANCELLED';
    if (status === 'CANCELLED' || !terminalByKey.has(key)) {
      terminalByKey.set(key, status);
    }
  }

  const retirements: Retirement[] = [];
  for (const item of items) {
    if (item.status !== 'ACTIVE' || !item.situationId) continue;

    const sibling = item.canonicalKey ? terminalByKey.get(item.canonicalKey) : undefined;
    if (sibling) {
      retirements.push({
        situationId: item.situationId,
        status: sibling,
        reason: sibling === 'CANCELLED' ? 'SOURCE_CANCELLED' : 'SOURCE_ENDED',
      });
      continue;
    }

    if (isPast(item.endsAt, nowMs)) {
      retirements.push({ situationId: item.situationId, status: 'ENDED', reason: 'VALIDITY_ENDED' });
    }
  }
  return retirements;
}
