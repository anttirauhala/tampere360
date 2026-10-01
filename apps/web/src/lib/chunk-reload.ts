/**
 * Lazy-chunkien uudelleenlataus — deployn jälkeen ilmenevä
 * "error loading dynamically imported module".
 *
 * **Miksi virhe syntyy (havaittu 27.9.2026):**
 *
 * 1. Jokainen deploy tuottaa Vite-buildille **uudet hash-nimet**
 *    (`NysseMapPage-D7Zua3Am.js`) ja `BucketDeployment` poistaa vanhat
 *    tiedostot (`prune: true`) ja invalidoi CloudFrontin.
 * 2. Puuttuva polku ei palauta 404:ää vaan **SPA-fallbackin**: CloudFrontin
 *    `errorResponses` ohjaa 403/404 → `/index.html` **HTTP 200 +
 *    `content-type: text/html`**. Selain hylkää sen JS-moduulina, koska
 *    MIME-tyyppi on `text/html` ja sisältö on HTML:ää.
 * 3. Kauan auki ollut välilehti käyttää **muistissa olevaa vanhaa
 *    `index.html`:ää**, jonka chunk-nimet on jo poistettu bucketista. Virhe
 *    näkyy vasta, kun käyttäjä avaa lazy-ladatun sivun (Kartta / Nysse).
 *
 * **Korjaus:** kun dynaaminen import kaatuu, ladataan sivu **kerran**
 * uudelleen — uusi `index.html` osoittaa olemassa oleviin chunk-nimiin.
 * Uudelleenlataus on suojattu aikaleimalla (`CHUNK_RELOAD_WINDOW_MS`), jottei
 * synny reload-silmukkaa, jos chunk on oikeasti rikki (esim. verkko poikki).
 * Silloin näytetään selkeä ilmoitus (`components/ChunkLoadFailure`).
 *
 * CloudFrontin puolella sama vika estetään välimuistipolitiikalla: dokumentti
 * on aina tuore (`CACHING_DISABLED`, ks. `infra/lib/web-cache.ts`), joten uusi
 * välilehti saa aina olemassa olevat chunk-nimet.
 */

/** Kuinka kauan "sivu ladattiin juuri uudelleen" estää uuden automaattisen reloadin. */
export const CHUNK_RELOAD_WINDOW_MS = 30_000;

const STORAGE_KEY = 'tampere360:chunk-reload-at';

/**
 * URL-parametri, jolla uudelleenlataus merkitään.
 *
 * Miksi URL eikä pelkkä `localStorage`: parametri **säilyy dokumentin vaihdon
 * yli** eikä riipu kellosta eikä tallennuksen sallivuudesta. Jos tallennus on
 * estetty (yksityinen tila) tai kello hyppii (esim. selaimen virtuaaliaika),
 * pelkkä aikaleima ei estäisi reload-silmukkaa — parametri estää (havaittu
 * 1.10.2026, ks. docs/architecture/spa-chunk-reload.md).
 */
export const CHUNK_RETRY_PARAM = 'chunkRetry';

/** Onko osoitteessa "uudelleenlataus jo yritetty" -merkintä? */
export function hasChunkRetryFlag(href: string): boolean {
  return new URL(href).searchParams.has(CHUNK_RETRY_PARAM);
}

/** Palauttaa osoitteen, johon on lisätty uudelleenlatausmerkintä. */
export function withChunkRetryFlag(href: string): string {
  const url = new URL(href);
  url.searchParams.set(CHUNK_RETRY_PARAM, '1');
  return url.toString();
}

/** Palauttaa osoitteen ilman uudelleenlatausmerkintää. */
export function withoutChunkRetryFlag(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(CHUNK_RETRY_PARAM);
  return url.toString();
}

/** Riippuvuus-injektio, jotta logiikka on testattavissa ilman selainta. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChunkReloadGuard {
  /** Onko sivu ladattu uudelleen chunk-virheen vuoksi äskettäin? */
  recentlyReloaded(): boolean;
  /** Merkitään ajankohta ennen uudelleenlatausta. */
  markReloaded(): void;
  /** Nollataan merkintä (lataus onnistui tai käyttäjä pyysi reloadin itse). */
  clear(): void;
}

export interface ChunkReloadGuardOptions {
  /** Oletus: `localStorage`, jos selain sallii sen. */
  storage?: KeyValueStore | null;
  /** Oletus: `Date.now`. */
  now?: () => number;
  /** Oletus: `CHUNK_RELOAD_WINDOW_MS`. */
  windowMs?: number;
}

/** Luo reloadin estävän vartijan (aikaleima `localStorage`issa). */
export function createChunkReloadGuard(options: ChunkReloadGuardOptions = {}): ChunkReloadGuard {
  const storage = options.storage === undefined ? safeStorage() : options.storage;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? CHUNK_RELOAD_WINDOW_MS;

  const readAt = (): number | null => {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const at = Number(raw);
      return Number.isFinite(at) ? at : null;
    } catch {
      // Yksityinen tila / estetty tallennus: ei merkintää.
      return null;
    }
  };

  return {
    recentlyReloaded(): boolean {
      const at = readAt();
      return at !== null && now() - at < windowMs;
    },
    markReloaded(): void {
      try {
        storage?.setItem(STORAGE_KEY, String(now()));
      } catch {
        // Tallennus estetty — kts. readAt.
      }
    },
    clear(): void {
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // Tallennus estetty — kts. readAt.
      }
    },
  };
}

/** `localStorage`, jos se on käytettävissä (yksityinen tila voi estää). */
function safeStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Dynaaminen import kaatui eikä uudelleenlataus enää auta. */
export class ChunkLoadError extends Error {
  readonly label: string;
  /** Alkuperäinen virhe (esim. selaimen MIME-virhe). */
  override readonly cause?: unknown;

  constructor(label: string, cause?: unknown) {
    super(`Sivun osaa "${label}" ei saatu ladattua`);
    this.name = 'ChunkLoadError';
    this.label = label;
    this.cause = cause;
  }
}

export interface LazyModuleLoadOptions {
  /**
   * Yrittää palauttaa sivun (uudelleenlataus). Palauttaa `true`, jos
   * uudelleenlataus käynnistettiin — ks. `recoverFromChunkError`.
   */
  recover: () => boolean;
  /** Kutsutaan, kun kaikki yritykset epäonnistuivat (lokitusta varten). */
  onFailure?: (label: string, error: unknown) => void;
  /** Yritysten määrä. Oletus 2 — hetkellinen verkkohäiriö ehtii korjautua. */
  attempts?: number;
  /** Tauko yritysten välissä. Oletus 150 ms (testeissä 0). */
  delayMs?: number;
}

/**
 * Lataa lazy-moduulin uudelleenyrityksellä; pitkittyneessä virheessä joko
 * lataa sivun uudelleen (kerran) tai heittää `ChunkLoadError`in.
 */
export async function loadLazyModule<T>(
  load: () => Promise<T>,
  label: string,
  options: LazyModuleLoadOptions,
): Promise<T> {
  const attempts = options.attempts ?? 2;
  const delayMs = options.delayMs ?? 150;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const module = await load();
      // Puolustus: Vite voi palauttaa `undefined` onnistumisen sijaan, jos
      // `vite:preloadError`-tapahtuma on estetty (ks. main.tsx). Silloin
      // import ei oikeasti onnistunut.
      if (!module) {
        throw new Error('dynaaminen import palautti tyhjän tuloksen');
      }
      return module;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs * attempt);
      }
    }
  }

  options.onFailure?.(label, lastError);

  if (options.recover()) {
    // Sivu latautuu uudelleen juuri nyt. Palautetaan lupaus, joka ei koskaan
    // ratkea, jotta Suspense näyttää lataustilan eikä virhe välähdä ruudulla.
    return await new Promise<never>(() => {});
  }

  // Uudelleenlataus on jo yritetty eikä auttanut → ei reload-silmukkaa.
  throw new ChunkLoadError(label, lastError);
}

export interface RecoveryDeps {
  /** Oletus: `localStorage`-pohjainen vartija (voi puuttua kokonaan). */
  guard?: ChunkReloadGuard;
  /** Oletus: `window.location`. */
  location?: { href: string; replace(url: string): void };
}

/**
 * Yrittää palauttaa sivun chunk-virheestä: lataa dokumentin uudelleen **kerran**
 * ja merkitsee yrityksen sekä URL:iin että vartijaan.
 *
 * Palauttaa `true`, jos uudelleenlataus käynnistettiin. `false` tarkoittaa,
 * että yritys on jo tehty → kutsuja näyttää ilmoituksen.
 */
export function recoverFromChunkError(deps: RecoveryDeps = {}): boolean {
  const guard = deps.guard ?? createChunkReloadGuard();
  const location = deps.location ?? (typeof window === 'undefined' ? null : window.location);
  if (!location) {
    return false;
  }

  if (guard.recentlyReloaded() || hasChunkRetryFlag(location.href)) {
    return false;
  }

  guard.markReloaded();
  // replace: ei uutta merkintää selaushistoriaan (käyttäjän "takaisin" toimii).
  location.replace(withChunkRetryFlag(location.href));
  return true;
}

/**
 * Merkintä pois, kun sivun osa latautui onnistuneesti: seuraava (mahdollinen)
 * deploy saa taas yhden automaattisen uudelleenlatauksen.
 */
export function clearChunkRetryFlag(): void {
  createChunkReloadGuard().clear();
  if (typeof window === 'undefined' || !hasChunkRetryFlag(window.location.href)) {
    return;
  }
  window.history.replaceState(null, '', withoutChunkRetryFlag(window.location.href));
}

/**
 * Pakottaa uudelleenlatauksen (käyttäjän napsautuksesta) ja nollaa merkinnät,
 * jotta uusi yritys on mahdollinen.
 */
export function hardReload(): void {
  createChunkReloadGuard().clear();
  const href = window.location.href;
  if (hasChunkRetryFlag(href)) {
    window.location.replace(withoutChunkRetryFlag(href));
    return;
  }
  window.location.reload();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
