/**
 * Pysäkkitunnisteen validointi (`GET /v1/stops/{stopId}/departures`, §28).
 *
 * Tunniste tulee suoraan URL-polusta, ja se **upotetaan SIRI-pyynnön XML:ään**
 * (`MonitoringRef`). Siksi validointi ei ole muotoseikka: ilman tiukkaa
 * sallittujen merkkien tarkistusta polusta voisi syöttää XML-rakennetta.
 * Puolustus on kaksinkertainen — validointi täällä ja `escapeXml`
 * pyynnön rakentamisessa (`siri-sm.ts`) — jotta kumpikaan yksinään ei riitä
 * rikkomaan pyyntöä.
 *
 * Nyssen GTFS-`stop_id`:t ovat nelinumeroisia nollapadattuja (`0015`), mutta
 * mukaan hyväksytään varautuen myös kirjaimet, `:` ja `_`, koska muut Waltti-
 * kaupungit käyttävät muotoa `tampere:1234` ja tulevaisuudessa tunniste voi
 * sisältää kirjaimia (esim. `A1`).
 */
export const STOP_ID_PATTERN = /^[A-Za-z0-9:_-]{1,24}$/;

/**
 * Palauttaa validoidun pysäkkitunnisteen tai `null`, jos tunniste on
 * virheellinen (kutsuja vastaa silloin HTTP 400:lla).
 */
export function parseStopId(raw: string | null | undefined): string | null {
  let value: string;
  try {
    value = decodeURIComponent(raw ?? '').trim();
  } catch {
    // Virheellinen prosenttikoodaus (esim. `%zz`) — ei validi tunniste.
    return null;
  }
  return STOP_ID_PATTERN.test(value) ? value : null;
}
