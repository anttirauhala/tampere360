/**
 * API-client.
 *
 * API-osoite luetaan ajonaikaisesti /config.json-tiedostosta, jonka CDK
 * kirjoittaa frontend-bucketiin (FrontendStack) — näin sama build toimii
 * eri ympäristöissä ilman uudelleenkääntöä.
 */

let apiBaseUrl = '';

/** Lataa ajonaikainen konfiguraatio (kutsutaan ennen sovelluksen renderöintiä). */
export async function loadConfig(): Promise<void> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (res.ok) {
      const cfg = (await res.json()) as { apiBaseUrl?: string };
      if (cfg.apiBaseUrl) {
        apiBaseUrl = cfg.apiBaseUrl;
        return;
      }
    }
  } catch {
    // config.json puuttuu (esim. paikalliskehitys) — jatketaan
  }

  // Paikalliskehitys: Vite-ympäristömuuttuja
  const fromEnv = import.meta.env['VITE_API_URL'] as string | undefined;
  apiBaseUrl = fromEnv ?? '';
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

type QueryValue = string | number | boolean | undefined | null;

/**
 * API-virhe, jossa HTTP-tilakoodi on mukana oliona.
 *
 * Pelkkä virheteksti (`API-virhe 502`) ei riitä käyttöliittymälle: pysäkin
 * lähtötiedoissa 5xx tarkoittaa "lähde ei vastannut, yritetään uudelleen" kun
 * taas 4xx tarkoittaa pysyvää virhettä. Tilakoodi kuljetetaan siksi kentässä,
 * eikä sitä tarvitse kaivaa tekstistä.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`API-virhe ${status} (${path})`);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Virheen HTTP-tilakoodi tai `null`, jos virhe ei tullut API:sta.
 *
 * Tekstivarmistus (`API-virhe 502`) on tarkoituksellinen: se toimii myös
 * silloin, kun virheolio on syntynyt toisessa moduuli-instanssissa eikä
 * `instanceof` enää täsmää.
 */
export function apiErrorStatus(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  const message = error instanceof Error ? error.message : '';
  const match = /API-virhe (\d{3})/.exec(message);
  return match?.[1] ? Number(match[1]) : null;
}

/** GET-pyyntö API:lle. Heittää `ApiError`in, jos vastaus ei ole 2xx. */
export async function apiGet<T>(path: string, params?: Record<string, QueryValue>): Promise<T> {
  const url = new URL(`${apiBaseUrl}${path}`, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw new ApiError(res.status, path);
  }
  return (await res.json()) as T;
}
