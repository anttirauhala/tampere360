import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA:n build. API-osoite ei ole build-aikainen — se luetaan ajonaikaisesti
// /config.json-tiedostosta, jonka CDK kirjoittaa bucketiin (FrontendStack).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Paikalliskehityksessä config.json puuttuu → käytetään VITE_API_URL:ia
    // tai oletusta (ks. src/api/client.ts).
  },
});
