# SPA-deployn chunk-virhe ja sen ehkäisy

> Havaittu ja korjattu 1.10.2026 (dev-jakelu `d36ic5wsx4b9yl.cloudfront.net`,
> sama malli myös prodissa `tampere247.online`)

## Oire

Käyttäjän raportti: *"frontendistä tulee välillä virhe eikä sivu lataudu,
erityisesti jos sivu on ollut kauan auki"*:

```
Uncaught TypeError: error loading dynamically imported module:
https://d36ic5wsx4b9yl.cloudfront.net/assets/NysseMapPage-DyiIPu-z.js
```

## Juurisyy — kolme osaa, jotka yhdessä muodostavat vian

1. **Jokainen deploy tuottaa uudet hash-nimet.** Vite nimeää chunkit sisällön
   hashilla (`NysseMapPage-D7Zua3Am.js`). `BucketDeployment` (`prune: true`)
   **poistaa vanhat tiedostot** bucketista ja invalidoi CloudFrontin.
   Bucketissa oli vian hetkellä vain yksi build-joukko (12 tiedostoa), kun
   selaimen pyytämä `NysseMapPage-DyiIPu-z.js` oli edellisestä buildista.
2. **Puuttuva polku ei palauta 404:ää vaan SPA-fallbackin.** CloudFrontin
   `errorResponses` (403/404 → `/index.html`) palauttaa dynaamiselle
   importille **HTTP 200 + `content-type: text/html`**, joten selain hylkää
   vastauksen JS-moduulina. Sama mekanismi näkyi aiemmin MapLibre-työntekijän
   kohdalla (§27.1).
3. **Dokumentti jäi välimuistiin.** Jakelun oletusbehavior käytti
   `CACHING_OPTIMIZED`-policya, eikä S3:ssa ole `Cache-Control`-otsaketta →
   CloudFront käytti **oletus-TTL:ää (1 vrk)**. Siksi *"sivu on ollut kauan
   auki"*: selaimen muistissa (ja CloudFrontissa) oli vanha `index.html`, jonka
   chunk-nimet oli jo poistettu. Uusi välilehti olisi hakenut tuoreen
   dokumentin, mutta avoinna oleva SPA ei.

Virhe on **hiljainen ja viivästynyt**: se ei näy heti deployn jälkeen, vaan
vasta kun käyttäjä avaa lazy-ladatun sivun (Kartta / Nysse) vanhasta
istunnosta.

## Korjaus

### 1. CloudFront: dokumentti aina tuore, assetit pitkään välimuistiin

`infra/lib/web-cache.ts` + `infra/lib/frontend-stack.ts`:

| Polkukuvio | Policy | TTL |
|---|---|---|
| oletus (`/`, `/kartta`, SPA-fallback) | `CACHING_DISABLED` (AWS managed, `4135ea2d-…`) | 0 |
| `assets/*` | oma `CachePolicy` `tampere360-{env}-assets` | 31 536 000 s (1 v) |
| `config.json` | `CACHING_DISABLED` | 0 |

Perustelu: `index.html` sisältää **build-kohtaiset chunk-nimet**, joten se ei
saa koskaan tulla välimuistista; assettien nimessä on **sisällön hash**, joten
sama nimi = sama sisältö → pitkä TTL on turvallinen (ja nopeampi kuin ennen).

### 2. Frontend: yksi uudelleenlataus chunk-virheen jälkeen

`apps/web/src/lib/chunk-reload.ts` + `lib/lazy-page.tsx` +
`components/ChunkLoadFailure.tsx` + `main.tsx`:

```
dynaaminen import kaatuu
  → toinen yritys (hetkellinen verkkohäiriö)
  → yhä kaatuu?
      → onko palautus jo yritetty? (URL: ?chunkRetry=1 TAI tallennettu aikaleima)
          ei  → merkitse + window.location.replace(url + ?chunkRetry=1)
          kyllä → näytä "Sivun osaa ”Kartta” ei saatu ladattua" + Lataa-nappi
```

- Reloadin aikana `Suspense` näyttää lataustilan: lupaus jää tarkoituksella
  ratkeamatta, jotta virhe ei välähdä ruudulla.
- `main.tsx` kuuntelee lisäksi Viten `vite:preloadError`-tapahtumaa, joka
  kattaa myös muut kuin `lazy()`-kääreen kautta kulkevat importit (esim. CSS).
- Onnistunut lataus nollaa merkinnät (myös URL:sta
  `history.replaceState`illa), joten myöhempi uusi deploy saa taas yhden
  automaattisen uudelleenlatauksen.

**Miksi reload eikä chunkin uudelleenhaku:** vanha dokumentti osoittaa aina
vanhoihin nimiin. Vain uusi `index.html` sisältää nykyiset chunk-nimet.

**Miksi merkintä on URL:ssa eikä pelkässä `localStorage`issa:** aikaleimaan
nojautuva vartija ei riitä, jos tallennus on estetty (yksityinen tila) tai
kello hyppii (selaimen virtuaaliaika). Havaittu 1.10.2026: pelkällä
aikaleimalla syntyi **2053 uudelleenlatauksen silmukka**, kun kello eteni
nopeammin kuin 30 s ikkuna ehti kulua. URL-parametri säilyy dokumentin vaihdon
yli eikä riipu kellosta eikä tallennuksesta — jompikumpi merkintä on aina
olemassa reloadin jälkeen, joten silmukka ei ole mahdollinen.

### 3. `prune: true` pidetään

Vanhoja chunkkeja **ei** jätetä bucketiin (`prune: false`), koska se kasvattaisi
bucketia rajatta (~7 Mt per deploy) ilman elinkaarisääntöä, joka puolestaan
poistaisi myös nykyisen buildin hiljaisen kauden aikana. Kohdat 1 ja 2
riittävät: uusi kävijä saa aina tuoreen dokumentin, ja jo avoinna oleva
välilehti korjautuu yhdellä automaattisella uudelleenlatauksella.

### 4. Sivutuotteena löytynyt toinen vika: `preventDefault()` kaatoi koko sivun

`vite:preloadError`-käsittelijässä **ei saa** kutsua `event.preventDefault()`.

Viten preload-helper tekee (buildattu koodi):

```js
return r.then(t => { … ; return e().catch(i) })   // i = virheen käsittelijä
function i(e) {
  const t = new Event('vite:preloadError', { cancelable: true });
  window.dispatchEvent(t);
  if (!t.defaultPrevented) throw e;   // ← estettynä virhe EI heity
}
```

Estettynä `catch`-käsittelijä palauttaa `undefined`, joten dynaaminen import
**näyttää onnistuvan** ja ratkeaa `undefined`illa. Seuraus: Reactin `lazy`
lukee `moduleObject.default` → **`TypeError: Cannot read properties of
undefined (reading 'default')`** → ilman error boundarya React purkaa koko
puun ja **sivu jää tyhjäksi** (havaittu selainverifioinnissa 1.10.2026;
`--dump-dom` näytti `<div id="root"></div>`).

Korjaus: käsittelijä ei estä virhettä (se saa heittyä — `lazyPage` nappaa sen
ja hoitaa palautuksen), ja `loadLazyModule` käsittelee tyhjän tuloksen
epäonnistumisena (`if (!module) throw …`) puolustuksena samaa ilmiötä vastaan.

## Regressiosuojat

| Testi | Mitä vartioi |
|---|---|
| `infra/test/frontend-cache.test.ts` (5) | oletusbehavior käyttää **samaa no-store-policya** kuin `config.json`; `assets/*` käyttää omaa policya, jonka min/default/max = 1 v ja gzip+br päällä; **Cache-Control-otsakkeet** dokumentille (`no-store`) ja asseteille (`immutable`); TTL-vakio on vuosi; SPA-fallback 403/404 → 200 `/index.html` säilyy |
| `apps/web/src/lib/chunk-reload.test.ts` (20) | uusintayritys ennen palautusta; palautus tehdään **kerran**; URL-merkintä (`?chunkRetry=1`) estää silmukan **myös ilman `localStorage`ia**; vartijan ikkuna ja `clear()`; `ChunkLoadError` kuljettaa nimen ja syyn; lupaus jää odottamaan; **tyhjä moduulitulos käsitellään epäonnistumisena** (Viten preload-helper) |

## Verifiointi (toistettava selainsimulaatio)

Simuloi deployn `prune`-efekti paikallisesti: julkaistu `index.html` viittaa
`NysseMapPage-*.js`-chunkkiin, jota **ei ole olemassa**.

```bash
npm run build:web
mkdir -p /tmp/t/ns && cp -r apps/web/dist/. /tmp/t/ && rm /tmp/t/assets/NysseMapPage-*
cp /tmp/t/index.html /tmp/t/ns/index.html          # /nysse-kartta-reitti
(cd /tmp/t && python3 -m http.server 8791) &       # taustalle
google-chrome --headless=new --no-sandbox --user-data-dir=/tmp/c \
  --virtual-time-budget=60000 --dump-dom http://127.0.0.1:8791/nysse-kartta/
```

Mitattu 1.10.2026 (`--dump-dom` + palvelimen loki):

| Tarkistus | Tulos |
|---|---|
| Dokumenttilataukset | **2**: `/nysse-kartta/` + `/nysse-kartta/?chunkRetry=1` → tasan yksi automaattinen uudelleenlataus, ei silmukkaa |
| Chunk-pyynnöt | 1 per dokumentti (Vite muistaa epäonnistuneen importin lupauksen) |
| `?chunkRetry=1`-osoitteella | **1** dokumenttilataus (ei uutta reloadia) |
| DOM (`?chunkRetry=1`) | `role="alert"` + `state state--error`: *"Sivun osaa ”Nysse” ei saatu ladattua… "* ja **Lataa sivu uudelleen** -nappi ✅ |
| Konsoli (`window.onerror` + `unhandledrejection`-koetin) | **0 virhettä** ✅ |
| Sovelluksen runko | `#root` renderöi `.app`-rakenteen (ei tyhjää sivua) ✅ |
| Vanha logiikka (vertailu) | pelkällä aikaleimalla syntyi **2053 reloadia**; `preventDefault`illa `#root` jäi tyhjäksi virheeseen *reading 'default'* |

## Verifiointi (julkaistu ympäristö)

```bash
curl -sI https://<jakelu>/index.html | grep -i cache-control   # no-cache, no-store, …
curl -sI https://<jakelu>/assets/<hash>.js | grep -i cache-control  # public, max-age=31536000, immutable
curl -sI https://<jakelu>/assets/olematon.js | grep -iE 'HTTP|content-type'  # 200 text/html (SPA-fallback, tarkoituksellinen)
```
