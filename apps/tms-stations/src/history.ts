/**
 * Historia-CSV:n jäsennys (arkkitehtuuri §30).
 *
 * Digitrafficin historia-rajapinta palauttaa **CSV:tä**, ei JSONia:
 *
 *   - erotinmerkki on puolipiste (`;`)
 *   - vastaus alkaa UTF-8 BOM -merkillä (`\uFEFF`)
 *   - tyhjä solu tarkoittaa puuttuvaa arvoa (esim. `;;`), **ei nollaa**
 *   - sarakkeet riippuvat `tyyppi`-parametrista, joten nimet luetaan
 *     otsikkoriviltä eikä indeksejä kovakoodata
 *
 * Jäsennys ei koskaan heitä virhettä puutteellisesta datasta: puuttuva solu
 * muuttuu `null`iksi ja tuntematon muoto tuottaa tyhjän sarjan. Näin käyttäjä
 * näkee "ei tietoja" sen sijaan, että koko sivu hajoaisi.
 *
 * Aidot esimerkkirivit (asema 438, 27.9.2026):
 *
 *   tunti:  438;vt12_Tre_Paasikiventie;20260926;*;;*;Kaikki;kaikki;1058;797;…;39904
 *   vrk:    438;vt12_Tre_Paasikiventie;20260913;*;;*;36768;36597;171;36224;…
 *   kk:     438;vt12_Tre_Paasikiventie;2026;09;1;Lahti;70/70;25646;25292;354;65.1;65.2;61.0
 */

import type { DailyPoint, DirectionSpeed, HourlyPoint } from './types';

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

/** Pilkkoo CSV:n otsikoksi ja riveiksi (BOM pois, tyhjät rivit pois). */
export function parseCsv(text: string | null | undefined): ParsedCsv {
  const cleaned = (text ?? '').replace(/^\uFEFF/, '');
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const [headerLine, ...rowLines] = lines;
  if (!headerLine) return { header: [], rows: [] };

  const header = headerLine.split(';').map((cell) => cell.trim());
  const rows = rowLines
    .filter((line) => !line.startsWith('pistetunnus;'))
    .map((line) => line.split(';').map((cell) => cell.trim()));

  return { header, rows };
}

/** Sarakkeen indeksi otsikon perusteella, tai `-1`. */
export function columnIndex(header: string[], name: string): number {
  return header.indexOf(name);
}

/** Solu → luku. Tyhjä tai kelvoton solu on `null` (ei nolla). */
export function numberCell(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const value = cell.trim().replace(',', '.');
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Solu → merkkijono tai `null`, jos solu on tyhjä. */
export function textCell(cell: string | undefined): string | null {
  const value = cell?.trim();
  return value ? value : null;
}

/** `20260926` → `2026-09-26`. Kelvoton muoto → `null` (ei arvausta). */
export function compactDateToIso(value: string | undefined): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;
  const [, year, month, day] = match;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/** Tuntisarakkeet (`00_01` … `23_24`) otsikon perusteella. */
export function hourColumns(header: string[]): { hour: number; index: number }[] {
  const columns: { hour: number; index: number }[] = [];
  header.forEach((name, index) => {
    const match = /^(\d{2})_(\d{2})$/.exec(name);
    if (!match) return;
    const hour = Number(match[1]);
    if (Number.isFinite(hour)) columns.push({ hour, index });
  });
  return columns;
}

/**
 * Tuntijakauma (`tyyppi=h`): valitaan rivi, jossa `jaottelu` on `Kaikki` ja
 * `ajoneuvoluokka` on `kaikki` — se on kaikkien ajoneuvojen summa. Yksittäiset
 * ajoneuvoluokat (HA - PA, KAIP, Linja-autot, …) jätetään pois, koska
 * käyttöliittymä näyttää kokonaismäärän.
 */
export function parseHourlySeries(text: string): { hours: HourlyPoint[]; total: number | null } {
  const { header, rows } = parseCsv(text);
  const hours = hourColumns(header);
  const groupingIndex = columnIndex(header, 'jaottelu');
  const classIndex = columnIndex(header, 'ajoneuvoluokka');
  const totalIndex = columnIndex(header, 'yhteensa');

  const sumRow = rows.find(
    (row) => textCell(row[groupingIndex]) === 'Kaikki' || textCell(row[classIndex]) === 'kaikki',
  );

  const series: HourlyPoint[] = hours.map(({ hour, index }) => ({
    hour,
    value: sumRow ? numberCell(sumRow[index]) : null,
  }));

  return {
    hours: series,
    total: sumRow && totalIndex >= 0 ? numberCell(sumRow[totalIndex]) : null,
  };
}

/**
 * Vuorokausisarja (`tyyppi=vrk`, aikaväli `pvm`–`loppu`): yksi rivi per päivä.
 * Suodatetaan `suunta=*`-riveihin, koska ne ovat molempien suuntien summa.
 */
export function parseDailySeries(text: string): DailyPoint[] {
  const { header, rows } = parseCsv(text);
  const dateIndex = columnIndex(header, 'pvm');
  const directionIndex = columnIndex(header, 'suunta');
  const totalIndex = columnIndex(header, 'kaikki');
  const lightIndex = columnIndex(header, 'kevyet');
  const heavyIndex = columnIndex(header, 'raskaat');

  const points: DailyPoint[] = [];
  for (const row of rows) {
    const date = compactDateToIso(row[dateIndex]);
    if (!date) continue;

    const direction = textCell(row[directionIndex]);
    if (direction && direction !== '*') continue;

    points.push({
      date,
      total: numberCell(row[totalIndex]),
      light: numberCell(row[lightIndex]),
      heavy: numberCell(row[heavyIndex]),
    });
  }

  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Kuukausikeskinopeudet suunnittain (`api=keskinopeus`, `tyyppi=kk`).
 * Suunnan nimi (esim. "Lahti") tulee suoraan lähteestä, joten sitä ei tarvitse
 * johtaa aseman metatiedoista.
 */
export function parseSpeedByDirection(text: string): DirectionSpeed[] {
  const { header, rows } = parseCsv(text);
  const index = (name: string) => columnIndex(header, name);

  return rows.map((row) => ({
    direction: textCell(row[index('suunta')]) ?? '*',
    municipality: textCell(row[index('suuntaselite')]),
    speedLimit: textCell(row[index('nopeusrajoitus')]),
    total: numberCell(row[index('kaikki')]),
    light: numberCell(row[index('kevyet')]),
    heavy: numberCell(row[index('raskaat')]),
    avgSpeed: numberCell(row[index('keskinopeus_kaikki')]),
    avgSpeedLight: numberCell(row[index('keskinopeus_kevyet')]),
    avgSpeedHeavy: numberCell(row[index('keskinopeus_raskaat')]),
  }));
}
