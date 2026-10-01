import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { loadConfig } from './api/client';
import { recoverFromChunkError } from './lib/chunk-reload';
import './styles.css';

/**
 * Vite ilmoittaa epäonnistuneesta dynaamisesta importista (JS tai CSS)
 * tapahtumalla `vite:preloadError`. Ilman käsittelijää virhe jää konsoliin ja
 * sivu jää puoliksi rikkinäiseksi; tässä yritetään **yksi** uudelleenlataus,
 * koska syy on lähes aina deployn vaihtama chunk-nimi (ks. lib/chunk-reload.ts).
 *
 * Käsittelijä on lazy-komponenttien (lib/lazy-page.tsx) rinnalla: se kattaa
 * myös tapaukset, joissa import ei kulje lazy()-kääreen kautta (esim. CSS).
 */
function watchPreloadErrors(): void {
  window.addEventListener('vite:preloadError', () => {
    // HUOM: tarkoituksella EI `event.preventDefault()`.
    //
    // Vite kääntää estetyn preload-virheen "ratkaistuksi" arvoksi `undefined`
    // (preload-helperin `catch` palauttaa silloin undefined), jolloin
    // dynaaminen import näyttäisi onnistuvan ja React kaatuisi virheeseen
    // "Cannot read properties of undefined (reading 'default')" — koko sivu
    // jäisi tyhjäksi (havaittu 1.10.2026). Annetaan virheen tulla läpi:
    // lazyPage (lib/lazy-page.tsx) nappaa sen, yrittää uudelleen ja hoitaa
    // palautuksen. Tämä käsittelijä hoitaa ne importit, jotka eivät kulje
    // lazyPage-kääreen kautta (esim. CSS).
    recoverFromChunkError();
  });
}

/**
 * Käynnistys: ladataan ensin ajonaikainen konfiguraatio (/config.json),
 * jotta API-osoite on tiedossa ennen ensimmäistä kyselyä.
 */
async function start(): Promise<void> {
  watchPreloadErrors();
  await loadConfig();

  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Elementtiä #root ei löytynyt');
  }

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
