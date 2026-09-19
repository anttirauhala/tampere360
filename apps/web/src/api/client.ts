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

/** GET-pyyntö API:lle. Heittää virheen, jos vastaus ei ole 2xx. */
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
    throw new Error(`API-virhe ${res.status} (${path})`);
  }
  return (await res.json()) as T;
}
