/**
 * HTTP-haku uudelleenyrityksillä (eksponentiaalinen backoff + jitter).
 * Käyttää Node 22:n globaalia fetch-apiä.
 */

export interface FetchWithRetryOptions {
  /** Aikakatkaisu millisekunteina (oletus 15 000). */
  timeoutMs?: number;
  /** Uudelleenyritysten määrä ensiyritksen jälkeen (oletus 3). */
  maxAttempts?: number;
  /** Perusviive backoffiin ms (oletus 500). */
  baseDelayMs?: number;
  /** HTTP-tilakoodit, joilla yritetään uudelleen. */
  retryStatuses?: readonly number[];
  /** Otsakkeet. */
  headers?: Record<string, string>;
  /** HTTP-metodi (oletus GET). */
  method?: string;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
  attempts: number;
}

export class HttpFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
    public readonly attempts?: number,
  ) {
    super(message);
    this.name = 'HttpFetchError';
  }
}

const DEFAULT_RETRY_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];
const DEFAULT_USER_AGENT = 'tampere360-ingest/0.1 (+https://tampere360.example)';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Hakee URL:n ja yrittää uudelleen verkkovirheissä sekä retryStatuses-listan
 * tilakoodeissa. Ei-uudelleenyrityskelpoinen virhetila (esim. 404) heittää
 * HttpFetchError-virheen heti.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<HttpResult> {
  const {
    timeoutMs = 15_000,
    maxAttempts = 3,
    baseDelayMs = 500,
    retryStatuses = DEFAULT_RETRY_STATUSES,
    headers = {},
    method = 'GET',
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          accept: '*/*',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      const body = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });

      if (response.ok) {
        return { status: response.status, headers: responseHeaders, body, url, attempts: attempt };
      }

      const retryable = retryStatuses.includes(response.status);
      if (!retryable) {
        throw new HttpFetchError(`HTTP ${response.status} from ${url}`, url, response.status, attempt);
      }
      lastError = new HttpFetchError(
        `HTTP ${response.status} from ${url}`,
        url,
        response.status,
        attempt,
      );
    } catch (error) {
      // Ei-uudelleenyrityskelpoinen HTTP-virhe: heitetään heti.
      if (error instanceof HttpFetchError && error.status !== undefined) {
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < maxAttempts) {
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);
      await sleep(delay);
    }
  }

  throw new HttpFetchError(
    `Request to ${url} failed after ${maxAttempts} attempts: ${describeError(lastError)}`,
    url,
    undefined,
    maxAttempts,
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
