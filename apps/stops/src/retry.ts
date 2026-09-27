/**
 * Uudelleenyritys Waltti-kutsuille (arkkitehtuuri §28, vianetsintä 27.9.2026).
 *
 * **Miksi tämä on olemassa:** Walttin SIRI-yhdyskäytävä vastaa ajoittain
 * HTTP 500:lla ("Something went wrong") pysäkille, joka sekunteja myöhemmin
 * vastaa normaalisti 200. Lokista mitattuna 27.9.2026 samat pysäkit (6154,
 * 6155, 1027) epäonnistuivat kolmen minuutin ajan ja toimivat sen jälkeen —
 * kyse oli siis tilapäisestä lähdevirheestä, ei pysäkistä.
 *
 * Yksi uusintayritys lyhyellä viiveellä poistaa valtaosan tällaisista
 * käyttäjälle näkyvistä virheistä ilman että pyyntöketju pitkittyy: Waltti
 * vastaa normaalisti 30–60 ms:ssa, joten 250 ms tauko ei tunnu käyttöliittymässä.
 *
 * **Mitä ei yritetä uudelleen:** 4xx-vastauksia. Ne tarkoittavat, että
 * *pyyntömme* on väärä (esim. 406 puuttuvasta `PreviewInterval`ista tai 401
 * väärästä avaimesta) — sama pyyntö tuottaisi saman tuloksen uudelleen.
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
 * Viimeinen virhe heitetään sellaisenaan (`throw lastError`), jotta kutsuja näkee
 * alkuperäisen syyn — myös silloin, kun `isRetryable` on estänyt uusinnan heti.
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
 * Statuskoodi luetaan virheolion `status`-kentästä (ks. `SiriUpstreamError`).
 * Ilman statuskoodia oleva virhe on verkko- tai aikakatkaisuvirhe — myös se
 * kannattaa yrittää uudelleen, koska sama pyyntö voi onnistua hetken päästä.
 */
export function isRetryableUpstreamError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status === 'number') return status >= 500;
  return true;
}
