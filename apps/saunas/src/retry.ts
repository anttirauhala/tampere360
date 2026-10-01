/**
 * Uudelleenyritys saunahaku.fi-kutsuille (arkkitehtuuri §33).
 *
 * Sama malli kuin Waltti- (§28) ja Digitraffic-uusinnassa (§30): yksi
 * uusintayritys lyhyellä viiveellä poistaa valtaosan hetkellisistä
 * upstream-virheistä. **4xx-vastauksia ei yritetä uudelleen** — ne
 * tarkoittavat, että oma pyyntömme on väärä, joten sama pyyntö tuottaisi
 * saman tuloksen.
 */

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
 * Viimeinen virhe heitetään sellaisenaan, jotta kutsuja näkee alkuperäisen syyn.
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
 * Statuskoodi luetaan virheolion `status`-kentästä (ks. `SaunaUpstreamError`).
 * Ilman statuskoodia oleva virhe on verkko- tai aikakatkaisuvirhe — myös se
 * kannattaa yrittää uudelleen, koska sama pyyntö voi onnistua hetken päästä.
 */
export function isRetryableUpstreamError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  // Statuskoodi 0 tarkoittaa vastauksen muotovirhettä (ks. `SaunaUpstreamError`)
  // — sitä ei yritetä uudelleen, koska sama vastaus toistuisi.
  if (typeof status === 'number') return status >= 500;
  return true;
}
