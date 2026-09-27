/**
 * GTFS-static-aineiston lukeminen (arkkitehtuuri §28).
 *
 * **Miksi GTFS-static eikä SIRI-pysäkkiluettelo:** SIRI SM käyttää
 * `MonitoringRef`inä GTFS-`stop_id`:tä (`0015`, `0001`), joten pysäkkirekisteri
 * ja reaaliaikainen kysely osuvat taatusti samaan tunnisteavaruuteen. Lisäksi
 * staattinen aineisto antaa nimen ja koordinaatit, joita SIRI SM ei anna.
 *
 * Aineisto on Tampereen/Nyssen GTFS-paketti (ITS Factory, CC BY 4.0):
 *   https://data.itsfactory.fi/journeys/files/gtfs/latest/gtfs_tampere.zip
 *
 * Paketti on ~17 Mt zip, josta tarvitaan vain `stops.txt`. Purku tehdään
 * `fflate`lla **suodattimella**, jolloin muiden tiedostojen sisältöä ei
 * pureta lainkaan (paketissa on ~100 Mt `stop_times.txt`, jonka purkaminen
 * turhaan veisi sekunteja Lambda-ajasta).
 */

import { unzipSync } from 'fflate';

import type { GtfsStop } from './types';

/**
 * Uskottavuusrajat (WGS84). Nysse liikennöi Tampereen, Nokian, Ylöjärven,
 * Kangasalan, Lempäälän, Pirkkalan, Vesilahden ja Oriveden alueella; rajat on
 * jätetty reilusti väljemmiksi. Rajojen ulkopuoliset rivit ovat aineiston
 * virheitä (tyypillisesti 0,0) eikä niitä näytetä kartalla.
 */
export const PLAUSIBLE_STOP_BBOX = {
  minLat: 60.5,
  maxLat: 62.5,
  minLon: 22.5,
  maxLon: 25.5,
} as const;

export function isPlausibleStopCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= PLAUSIBLE_STOP_BBOX.minLat &&
    latitude <= PLAUSIBLE_STOP_BBOX.maxLat &&
    longitude >= PLAUSIBLE_STOP_BBOX.minLon &&
    longitude <= PLAUSIBLE_STOP_BBOX.maxLon
  );
}

/**
 * RFC 4180 -tyylinen CSV-jäsennys (lainausmerkit, `""`-escape, CRLF, BOM).
 *
 * Oma toteutus siksi, että tarvitaan vain tämä yksi muoto: GTFS `stops.txt`
 * sisältää lainattuja kenttiä (pysäkkien nimet voivat sisältää pilkun) eikä
 * koko CSV-kirjastoa ole mielekästä lisätä yhden tiedoston takia.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // UTF-8-BOM pois: muuten ensimmäinen sarakeotsikko olisi "\uFEFFstop_id".
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Jäsentää GTFS `stops.txt` -sisällön pysäkeiksi.
 *
 * Pudottaa pois rivit, joilta puuttuu tunniste, nimi tai uskottava koordinaatti,
 * sekä duplikaatit tunnisteen mukaan (ensimmäinen rivi voittaa) — kartalla
 * kahden päällekkäisen samannimisen pisteen näyttäminen olisi virhe.
 */
export function parseStopsCsv(csv: string): GtfsStop[] {
  const rows = parseCsv(csv);
  const firstRow = rows[0];
  if (!firstRow) return [];

  const header = firstRow.map((name) => name.trim());
  const idIndex = header.indexOf('stop_id');
  const nameIndex = header.indexOf('stop_name');
  const latIndex = header.indexOf('stop_lat');
  const lonIndex = header.indexOf('stop_lon');
  if ([idIndex, nameIndex, latIndex, lonIndex].some((index) => index < 0)) return [];

  const stops: GtfsStop[] = [];
  const seen = new Set<string>();

  for (const row of rows.slice(1)) {
    const id = (row[idIndex] ?? '').trim();
    const name = (row[nameIndex] ?? '').trim();
    const latitude = Number((row[latIndex] ?? '').trim());
    const longitude = Number((row[lonIndex] ?? '').trim());

    if (!id || !name || seen.has(id)) continue;
    if (!isPlausibleStopCoordinate(latitude, longitude)) continue;

    seen.add(id);
    stops.push({ id, name, latitude, longitude });
  }

  return stops;
}

/** Wanted-tiedoston nimi GTFS-paketissa. */
export const STOPS_FILE_NAME = 'stops.txt';

/**
 * Purkaa `stops.txt`-sisällön zip-paketista.
 *
 * `filter` estää muiden tiedostojen purkamisen (ks. tiedoston yläkommentti).
 * Heittää virheen, jos tiedostoa ei ole — se on lähdemuutos, joka pitää nähdä
 * lokissa eikä hiljaisena tyhjänä pysäkkilistana.
 */
export function readStopsFromZip(bytes: Uint8Array, fileName: string = STOPS_FILE_NAME): string {
  const wanted = fileName.toLowerCase();
  const files = unzipSync(bytes, {
    filter: (file) => file.name.toLowerCase().endsWith(wanted),
  });
  const entry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith(wanted));
  if (!entry) throw new Error(`GTFS-aineistosta ei löytynyt tiedostoa ${fileName}`);

  return new TextDecoder('utf-8').decode(entry[1]);
}
