import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { loadConfig } from './api/client';
import './styles.css';

/**
 * Käynnistys: ladataan ensin ajonaikainen konfiguraatio (/config.json),
 * jotta API-osoite on tiedossa ennen ensimmäistä kyselyä.
 */
async function start(): Promise<void> {
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
