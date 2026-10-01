/**
 * Uudelleenyritys Digitraffic-kutsuille (arkkitehtuuri §30, mittaus 27.9.2026).
 *
 * **Miksi tämä on olemassa:** Digitrafficin historia-rajapinta
 * (`/api/tms/v1/history`) vastaa **hyvin vaihtelevalla viiveellä**. Sama kutsu
 * mitattiin 27.9.2026 sekä 45 ms että **7 597 ms** — ero ei johdu meidän
 * koodistamme vaan siitä, että lähde muodostaa CSV:n pyynnön yhteydessä.
 * Lambdaa tämä haittasi konkreettisesti: kolmen rinnakkaisen historianhaun
 * sarjassa `keskinopeus`-kutsu aikakatkaisi (10 s) ja käyttäjä näki 503:n.
 *
 * Yksi uusintayritys lyhyellä viiveellä poistaa valtaosan tällaisista
 * käyttäjälle näkyvistä virheistä: kun lähde on jo lämmennyt, uusinta vastaa
 * kymmenissä millisekunneissa.
 *
 * **Mitä ei yritetä uudelleen:** 4xx-vastauksia. Ne tarkoittavat, että
 * *pyyntömme* on väärä (esim. 400 väärästä parametrista), joten sama pyyntö
 * tuottaisi saman tuloksen.
 */

/** Kuinka monta yritystä ja kuinka pitkä tauko niiden välissä. */
export interface RetryOptions {
  /** Kokonaisyritysten määrä (`1` = ei uusintaa lainkaan). */
  attempts: number;
  /** Odotus yritysten välissä millisekunteina. */
  backoffMs: number;
  /** Saako virheen jälkeen yrittää uudelleen. */
  isRetryable: (error: unknown) => boolean;
  /** Odotusfunktio — testeissä korvataan, jotta testi ei odota oikeasti. */
  sleep?: (ms: number) => Promise<void>;
  /** Kutsutaan ennen jokaista uusintayritystä (logitus). */
  onRetry?: (error: unknown, attempt: number) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Yrittää `run`-funktiota enintään `attempts` kertaa.
 *
 * Viimeinen virhe heitetään sellaisenaan, jotta kutsuja näkee alkuperäisen
 * syyn — myös silloin, kun `isRetryable` on estänyt uusinnan heti.
 */
export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !options.isRetryable(error)) break;
      options.onRetry?.(error, attempt);
      await sleep(options.backoffMs);
    }
  }

  throw lastError;
}

/**
 * Onko virhe sellainen, että uusinta kannattaa.
 *
 * Statuskoodi luetaan virheolion `status`-kentästä (ks. `DigitrafficError`).
 * Ilman statuskoodia oleva virhe on verkko- tai aikakatkaisuvirhe — myös se
 * kannattaa yrittää uudelleen, koska sama pyyntö voi onnistua hetken päästä
 * (juuri näin kävi 27.9.2026 mitatussa 7,6 sekunnin tapauksessa).
 */
export function isRetryableUpstreamError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status === 'number') return status >= 500;
  return true;
}
