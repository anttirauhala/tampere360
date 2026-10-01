/**
 * FMI avoimen datan WFS -yhteys (arkkitehtuuri §31).
 *
 * Kysely: `fmi::observations::weather::timevaluepair` yhdelle asemalle
 * (`fmisid`). Avoin ja ilmainen, **ei API-avainta** → ei SSM- eikä
 * Secrets Manager -tarvetta. Lisenssi CC BY 4.0 (attribuutio vaaditaan).
 *
 * **Pyyntörajat:** FMI:n WFS view -palvelulla on 10 000 pyyntöä/vrk ja
 * yhdessä download-palvelun kanssa 600 pyyntöä / 5 min. Siksi haku tehdään
 * palvelimella ja pidetään välimuistissa (ks. `handler.ts`), ei jokaisesta
 * selaimesta.
 */

export const FMI_WFS_URL = 'https://opendata.fmi.fi/wfs';

/** FMI:n stored query: havainnot aikasarjana (WaterML 2.0). */
export const FMI_OBSERVATION_QUERY = 'fmi::observations::weather::timevaluepair';

export interface ObservationQuery {
  /** Asematunniste, esim. `101118` (Tampere-Pirkkala lentoasema). */
  fmisid: string;
  /** WFS-parametrinimet, esim. `['temperature','windspeedms']`. */
  parameters: readonly string[];
  /** Kuinka monta tuntia taaksepäin haetaan (valitaan viimeisin arvo). */
  hours: number;
  /** Testattava "nykyhetki"; oletus `new Date()`. */
  now?: Date;
}

/** Rakentaa WFS-pyynnön URL:in. */
export function buildObservationUrl(query: ObservationQuery): string {
  const now = query.now ?? new Date();
  const start = new Date(now.getTime() - query.hours * 3_600_000);

  const url = new URL(FMI_WFS_URL);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('version', '2.0.0');
  url.searchParams.set('request', 'getFeature');
  url.searchParams.set('storedquery_id', FMI_OBSERVATION_QUERY);
  url.searchParams.set('fmisid', query.fmisid);
  url.searchParams.set('parameters', query.parameters.join(','));
  url.searchParams.set('starttime', start.toISOString());
  return url.toString();
}

/** Lähteetön WFS-virhe (HTTP-tilakoodi tai ExceptionReport). */
export class FmiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'FmiError';
    this.status = status;
  }
}

/**
 * Hakee havainto-XML:n. FMI vastaa virheestä joko HTTP-virhekoodilla tai
 * `ExceptionReport`-rungolla (esim. tuntematon parametri) — molemmat tulkitaan
 * virheeksi, jotta jäsennys ei palauta hiljaista tyhjää vastausta.
 */
export async function fetchObservationXml(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'application/xml' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new FmiError(response.status, `FMI WFS vastasi ${response.status}`);
  }

  const body = await response.text();
  if (body.includes('ExceptionReport')) {
    throw new FmiError(400, 'FMI WFS palautti ExceptionReportin');
  }
  return body;
}
