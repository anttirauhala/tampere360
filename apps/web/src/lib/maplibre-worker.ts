/**
 * MapLibre GL JS:n työntekijän (Web Worker) käynnistys.
 *
 * **Miksi tämä tiedosto on olemassa:** MapLibre laskee työntekijän oletus-URL:in
 * ajonaikaisesti `import.meta.url`:sta:
 *
 *   new URL('./maplibre-gl-worker.mjs', import.meta.url)
 *
 * Vite ei tunnista tällaista dynaamisesti rakennettua polkua, joten työntekijää
 * **ei kopioitu buildiin**. Selain pyysi `/assets/maplibre-gl-worker.mjs`, sai
 * SPA-uudelleenohjauksen takia `index.html`:n (HTTP 200, `text/html`) ja hylkäsi
 * moduulin ("Failed to load module script: … non-JavaScript MIME type").
 *
 * Vika on **hiljainen**: rasteritiilet latautuvat ja näkyvät, mutta GeoJSON-lähde
 * jää jumiin (`_isUpdatingWorker: true`) eikä symbolikerroksia (ajoneuvoikoneja)
 * koskaan piirretä.
 *
 * Siksi työntekijä bundlataan tässä Viten `?worker&url`-kyselyllä ja sen URL
 * asetetaan MapLibrelle eksplisiittisesti. Sama polku toimii sekä devissä että
 * buildissa, eikä MapLibren sisäiseen tiedostonimeen tarvitse luottaa ajonaikaisesti.
 */

import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// Asetetaan ennen kuin yhtään karttaa luodaan (MapView importtaa tämän moduulin).
setWorkerUrl(workerUrl);

export const MAPLIBRE_WORKER_URL = workerUrl;
