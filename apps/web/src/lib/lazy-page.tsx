import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

import { ChunkLoadFailure } from '../components/ChunkLoadFailure';
import {
  ChunkLoadError,
  clearChunkRetryFlag,
  loadLazyModule,
  recoverFromChunkError,
} from './chunk-reload';

/**
 * `lazy()`, joka selviää deployn vaihtamasta chunk-nimestä
 * (ks. lib/chunk-reload.ts): yrittää kerran uudelleen, lataa sitten sivun
 * uudelleen — ja jos sekään ei auta, näyttää ilmoituksen `ChunkLoadFailure`.
 *
 * Käytetään raskaille sivuille (Kartta, Nysse), jotka ladataan vasta kun
 * reitille navigoidaan. Sivuilla ei ole propseja, joten tyypiksi riittää
 * `ComponentType` (oletuspropsit).
 */
export function lazyPage(
  load: () => Promise<{ default: ComponentType }>,
  label: string,
): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    try {
      const module = await loadLazyModule(load, label, {
        recover: () => recoverFromChunkError(),
        onFailure: (name, error) => {
          // Konsoliin jää jälki, mutta ei heittoa: käyttäjälle näytetään
          // tilanne joko uudelleenlatauksena tai ilmoituksena.
          console.warn(`Sivun osan "${name}" lataus epäonnistui`, error);
        },
      });
      // Onnistui → uudelleenlatausmerkintä pois (myös URL:sta).
      clearChunkRetryFlag();
      return module;
    } catch (error) {
      if (error instanceof ChunkLoadError) {
        // Uudelleenlataus ei auttanut (esim. verkko poikki) → ilmoitus, jonka
        // napista käyttäjä voi yrittää uudelleen.
        return { default: () => <ChunkLoadFailure label={label} /> };
      }
      throw error;
    }
  });
}
