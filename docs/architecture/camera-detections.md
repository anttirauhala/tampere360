# Kamerahavainnot-välilehti (`/v1/camera-detections`, `/kamerahavainnot`)

> Toteutettu 11.10.2026. Suunnitelma: `.clinerules/implementation_plan.md` §43.
> Deploy vain dev-ympäristöön (`tampere360-dev-*`).

Välilehti näyttää **uusimmat kamerahavainnot, joissa kuvassa on ihminen tai
eläin**, sekä jokaisesta havainnosta alkuperäisen kuvan ja analyysin tarkat
tiedot. Data tulee erillisestä `anttirauhala/traffic-cam-analyzer`-palvelusta
(YOLO World XL, Replicate).

## 1. Tietolähde: traffic-cam-analyzer

```
GET https://qwypy5x3c6.execute-api.eu-north-1.amazonaws.com/dev   (API Gateway REST,
                                                                   edge-optimized, stage dev)
```

- **Ei API-avainta**, CORS `*`. Mutta kiintiöt ovat **heidän tilillään**:
  50 req/s, burst 100, **10 000 req/vrk** — jaettu kaikkien käyttäjien kesken.
- Analyysiajastus: `cron(0 9-16 * * ? *)`, `Europe/Helsinki` → **tunneittain klo 9–16**, 5 km
  säde Tampereen keskustasta, tienpintakamerat pois.
- Kuvat S3:ssa; `GET /images` palauttaa **presigned-URLin (1 h)**.

| Reitti                               | Käyttö                                            |
| ------------------------------------ | ------------------------------------------------- |
| `GET /detections?hasDetection=true`  | osumarivit, uusin kuvausaika ensin, `limit` ≤ 100 |
| `GET /detections/{cameraId}/{epoch}` | bounding boxit + confidence per havainto          |
| `GET /cameras`                       | nimet, kunnat, sijainnit                          |
| `GET /images?bucket=raw&key=…`       | presigned-URL alkuperäiseen kuvaan                |

### Kolme erityispiirrettä (verifioitu 11.10.2026)

**1. Suodatin on `hasDetection=true`.** `?hasPerson=true` ja `?hasWildlife=true`
palauttavat **HTTP 500** (`Internal server error`) — heidän `gsiHasWildlife`- ja
`gsiHasPerson`-indeksinsä eivät vastaa avaimia. `hasDetection` tarkoittaa "analyysi
löysi jotain", joten rivi tarkistetaan silti itse
(`apps/camera-detections/src/detections.ts`). Mitattuna 11.10.2026: 199 osumariviä,
joista `hasPerson` 196 ja `hasWildlife` 4, **0 riviä ilman kumpaakaan**; luokkia
on käytännössä vain `person` ja `animal`.

**2. Kameratunniste polussa ilman enkoodausta.** `C04546:C0454601` toimii raakana,
mutta `%3A` → **HTTP 404**. Tunniste validoidaan
(`params.ts`: `^[A-Za-z0-9:_-]{1,32}$`), jotta polkuun ei voi injektoida.

**3. Kuvat arkistoidaan 90 päivän jälkeen.** Raw-bucketin elinkaari siirtää kuvat
Glacieriin → presigned-GET palauttaa **403**. Mitattuna 11.10.2026:

| Havainto                        | Presign | Kuvan GET            |
| ------------------------------- | ------- | -------------------- |
| `2026-10-11T07:57` (tämä päivä) | 200     | **206 OK** ✅        |
| `2026-02-22T13:53`              | 200     | **403 Forbidden** ❌ |
| `2026-01-19T09:52`              | 200     | **403 Forbidden** ❌ |

Presign onnistuu aina, joten arkistointi näkyy **selaimen kuvanlatauksen
epäonnistumisena**. Tämän vuoksi näkymä rajoittuu **kiinteään 60 vuorokauteen**:
vanhempia havaintoja ei näytetä eikä niitä voi pyytää (ks. §Aikaikkuna).

## 2. Arkkitehtuuri

```
Selain (10 min pollaus)
  → GET /v1/camera-detections?limit=12
  → apps/camera-detections (oma Lambda, varattu concurrency 2)
  → muistivälimuistit → traffic-cam-analyzer → JSON
  → selain hakee kuvat suoraan S3:sta presigned-URLilla
```

| Ratkaisu                  | Perustelu                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Oma Lambda                | Yksi kortti maksaa kolme upstream-kutsua → 12 kortin sivu olisi ~26 pyyntöä **per kävijä** |
| Varattu concurrency **2** | Erillään query-Lambdasta (5) ja muista reittikohtaisista Lambdoista                        |
| Ei DynamoDB-käyttöä       | Havainnot ovat hetkellistä dataa; **mitään ei tallenneta meille**                          |
| Kuvat selaimesta          | Bucket on heidän tilillään → presigned on ainoa tapa; ei Lambda-aikaa kuville              |
| Oma sopimus               | Frontend ei näe upstreamin kenttänimiä → lähdemuutokset eivät riko UI:ta                   |

### Välimuistit (neljä eri TTL:ää)

| Välimuisti         | TTL       | Miksi                                                                |
| ------------------ | --------- | -------------------------------------------------------------------- |
| Hakukimppu         | 5 min     | Analyysi ajetaan tunneittain → tiuhempi haku ei toisi tuoreutta      |
| Havaintodetalji    | **7 vrk** | Havainto on **muuttumaton** (`cameraId` + kuvausaika) → kutsu kerran |
| Kameraluettelo     | 24 h      | Nimet ja sijainnit muuttuvat harvoin                                 |
| Presigned-kuva-URL | 45 min    | URL vanhenee 1 h → vanhentunutta ei koskaan tarjoilla                |

Lisäksi: `stale`-varafallback tunnin (lista) ja `imagesUnavailable`-luku, joka
kertoo kuinka monelta havainnolta kuva puuttui.

### Rajoitettu rinnakkaisuus

Detaljit ja presigned-URLit haetaan `mapLimit`illa (3 + 3 rinnakkain). Ilman
rajausta 30 havaintoa olisi 60 rinnakkaista kutsua → lähdepalvelun 50 req/s
-throttlaus ja osittaiset epäonnistumiset.

## 3. API-sopimus

```json
{
  "fetchedAt": "2026-10-11T08:31:00Z",
  "stale": false,
  "count": 1,
  "hasMore": true,
  "windowDays": 60,
  "imagesUnavailable": 0,
  "nextCursor": "…",
  "items": [
    {
      "id": "C04546:C0454601:1791705564",
      "camera": {
        "cameraId": "C04546:C0454601",
        "name": "Tie 12 Tampere, Hyhky - Lahteen",
        "municipality": "Tampere",
        "latitude": 61.508008,
        "longitude": 23.687886
      },
      "capturedAt": "2026-10-11T07:59:24.000Z",
      "capturedAtEpoch": 1791705564,
      "processedAt": "2026-10-11T08:01:17.000Z",
      "hasPerson": true,
      "hasWildlife": false,
      "detectionCount": 1,
      "detectedClasses": ["person"],
      "detections": [{ "label": "person", "score": 0.337, "bbox": [755, 545, 800, 645] }],
      "imageUrl": "https://…s3.eu-north-1.amazonaws.com/…",
      "imageKey": "C04546/C0454601/2026-10-11T07-59-24-000Z/raw.jpg",
      "processingStatus": "SUCCESS"
    }
  ],
  "source": { "system": "TRAFFIC_CAM_ANALYZER", "name": "…", "url": "…", "license": "MIT" }
}
```

Parametrit:

- `limit` — oletus 12, max 30 (muuten **HTTP 400 `INVALID_LIMIT`**)
- `cursor` — läpinäkymätön `nextToken`, jos historiaa halutaan selata pidemmälle

### Aikaikkuna on kiinteä 60 vrk

Lähdepalvelu arkistoi alkuperäiset kuvat noin 90 päivän jälkeen, joten ikkuna
pidetään selvästi sen alla — alkuperäinen kuva on koko näkymän pointti.
**Vanhempia havaintoja ei näytetä eikä niitä voi pyytää:** API:ssa ei ole
`days`-parametria (tuntematon parametri jätetään huomiotta) eikä
käyttöliittymässä ole "näytä vanhemmat" -valintaa. Ikkuna voidaan asettaa
ympäristökohtaisesti (`DETECTION_WINDOW_DAYS`, oletus 60).

`hasMore` on tarkoituksellisen konservatiivinen: sitä ei luvata, jos haetun sivun
vanhin rivi on jo ikkunan ulkopuolella (sivut ovat laskevassa kuvausaikajärjestyksessä,
joten sitä vanhemmatkaan eivät enää mahdu).

## 4. Frontend

| Osa                              | Ratkaisu                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `api/camera-detections.ts`       | tyypit + `fetchCameraDetections(limit)` + 10 min pollaus                         |
| `api/queries.ts`                 | `useCameraDetections(limit)` — `limit` on kyselyavain, ei taustapollausta        |
| `lib/camera-detections.ts`       | luokkasuomennokset, confidence-%, bbox-skaalaus, `imageNotice`, järjestys        |
| `components/DetectionCard.tsx`   | kuva, **itse piirretyt bbox-laatikot**, luokkamerkit, tarkat tiedot `dl`-listana |
| `pages/CameraDetectionsPage.tsx` | otsikko, "Päivitä", tyhjä-/virhetilat, "Näytä enemmän", huomautus 5 km säteestä  |

**Bounding boxit piirretään itse:** lähdepalvelun `processedImageKey` on `null`
myös osumilla, joten merkittyä kuvaa ei ole. Laatikot sijoitetaan prosentteina
kuvan luonnollisesta koosta (`<img onLoad>` → `naturalWidth`) ja rajataan kuvan
sisään. Kuvaa **ei** rajata (`object-fit`/`aspect-ratio`): leikkaus siirtäisi
laatikot pois kohteesta.

**Rehellisyys:** confidence näytetään aina prosentteina (esimerkkihavainto 0,34 = heikko
näyttö), sivu kertoo analyysin olevan automaattinen konepäätelmä eikä vahvistettu
havainto, ja lähdepalvelun arkistoinnista kerrotaan alaviitteessä.

## 5. Infra

| Osa                      | Muutos                                                                          |
| ------------------------ | ------------------------------------------------------------------------------- |
| `infra/lib/config.ts`    | `DETECTION_*`-vakiot (URL, neljä TTL:ää, timeout 6 s, concurrency 2 ja 3+3)     |
| `infra/lib/api-stack.ts` | `CameraDetectionsFunction` + reitti `/v1/camera-detections`                     |
| `infra/bin/app.ts`       | Lambda mukaan valvontalistaan (`errors-camera-detections`)                      |
| `infra/lib/csp.ts`       | `DETECTION_IMAGE_ORIGINS` → `img-src` (`https://*.s3.eu-north-1.amazonaws.com`) |
| `package.json`           | `typecheck:apps` kattaa uuden sovelluksen                                       |

**CSP:** presigned-kuvat ovat S3:ssa, joten `img-src` tarvitsee alueen
S3-kannan. `connect-src` ei tarvitse muutosta (siinä on jo
`https://*.amazonaws.com`). Regressiosuoja: `infra/test/csp.test.ts`.

## 6. Testit

| Kohde                                        | Testejä | Sisältö                                                                  |
| -------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `apps/camera-detections/src/params.test.ts`  | 12      | `limit`/`cursor`-validointi, polku-injektion esto, ei `days`-parametria  |
| `…/analyzer.test.ts`                         | 16      | URL-rakennus (raaka `:`, enkoodattu `nextToken`), normalisointi, haut    |
| `…/detections.test.ts`                       | 9       | suodatus (`hasDetection` ≠ ihminen/eläin), kameraliitos, järjestys       |
| `…/cache.test.ts`                            | 5       | TTL, in-flight, stale, "vanhentunutta URL:ia ei tarjoilla"               |
| `…/concurrency.test.ts`                      | 4       | järjestys, rinnakkaisuusraja, virheen välitys                            |
| `…/handler.test.ts`                          | 10      | 200/400/404/503, kiinteä aikaikkuna, kuvan puuttuminen, detaljivirhe     |
| `apps/web/src/lib/camera-detections.test.ts` | 20      | suomennokset, confidence, bbox-skaalaus + rajaus, otsikot                |
| `infra/test/config.test.ts`                  | 9       | TTL-suhteet, **presigned-TTL < 1 h**, rinnakkaisuus, concurrency, ikkuna |
| `infra/test/csp.test.ts`                     | 2       | havaintokuvat `img-src`:ssä, ei koko `*.amazonaws.com`ia                 |
| Koko sarja                                   | 736     | 69 tiedostoa, ESLint ✅, Prettier ✅                                     |
