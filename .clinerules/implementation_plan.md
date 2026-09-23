# Tampere360 — Toteutussuunnitelma

> Lähdeaineisto: `.clinerules/architecture.md` (773 riviä) + lähteiden validointi 6.9.2026
> Tilanne: Vaiheet 0–4 ✅ (CDK-infra 8 stackia; FMI CAP, Digitraffic,
> poliisi-RSS ja Nysse Waltti toimivat päästä päähän; React-frontend
> julkaistu CloudFrontiin; tapahtumalähde disabloitu, API 404 — ks. §18).
> Deploy: `tampere360-dev-*` eu-north-1.
> Frontend: https://d36ic5wsx4b9yl.cloudfront.net
> API: https://vllod80b6i.execute-api.eu-north-1.amazonaws.com
> Seuraavaksi Vaihe 5 (testit, valvonta, CI).
> **Prod-valmius ✅ (§21):** `tampere360-prod-*` + domain `tampere247.online`
> (+ www), API `api.tampere247.online`, WAF (us-east-1, opt-in), TLS 1.2,
> RETAIN/PITR-kovennukset. Deploy: `npm run deploy:prod`;
> runbook: `docs/architecture/prod-deploy.md`.

## 1. Yhteenveto

Tampere360 on palvelu, joka kokoaa Tampereen alueen ajankohtaiset tilanteet
(liikennehäiriöt, poliisitiedotteet, pelastustoimi, säävaroitukset, yleisötapahtumat,
joukkoliikenne) yhdeksi reaaliaikaiseksi tilannekuvaksi. Toteutus on täysin
serverless AWS:ssä, tapahtumavetoinen ja rakennetaan Infra as Code -menetelmällä
(AWS CDK v2, TypeScript). Frontend on React SPA CloudFrontin takana.

Keskeisin suunnitteluperiaate: **tietolähdekohtainen kerääminen on eristetty
yhteisestä tapahtumamallista**, jotta esim. Peto voidaan vaihtaa uuteen
pelastustoimen mediapalveluun ilman muutoksia käyttöliittymään tai muihin
prosesseihin.

## 2. Ympäristö ja työkalut

| Asia | Arvo |
|---|---|
| Hakemisto | `/home/opti/projects/fibo2` (tyhjä, ei git-repoa) |
| Node.js | nykyisin v18.20.8 → päivitetään 22:een (asennusohje alla) |
| npm | 10.8.2 |
| AWS CLI | 2.33.17, kredentiaalit OK |
| AWS CDK | 2.1105.0 |
| Region | `eu-west-1` |
| Lambda-runtime | `nodejs22.x` (nodejs18.x deprecated 1.9.2025, nodejs20.x deprecated 30.4.2026 AWS:ssä) |
| IaC | AWS CDK v2 + TypeScript |
| Testaus | Vitest, MSW (frontend), fixture-pohjaiset yksikkötestit |

### Paikallisen Node 22:n asennus (nvm)

Node hallitaan nvm:llä (nykyinen versio: v18.20.8). AWS Lambda -runtime on
`nodejs22.x`, joten paikallinen Node päivitetään versioon 22:

```bash
# 1) Asennetaan Node 22 (LTS) ja otetaan se käyttöön
nvm install 22
nvm use 22

# 2) Asetetaan oletusversioksi (uudet terminaalit käyttävät tätä)
nvm alias default 22

# 3) Siirretään globaalit npm-paketit Node 18:sta Node 22:een
#    (mm. aws-cdk on asennettu Node 18:n alle, eikä näy automaattisesti)
nvm reinstall-packages 18
#    Vaihtoehtoisesti käsin: npm install -g aws-cdk

# 4) Varmistetaan versiot
node -v          # v22.x.x
npm -v           # 10.x
cdk --version    # 2.1105.0 (build ...)
```

Huomiot:
- nvm asentaa globaalit paketit versio­kohtaisesti — `nvm use 22` jälkeen
  `cdk`-komento ei toimi, ennen kuin paketit on siirretty
  (`nvm reinstall-packages 18`) tai asennettu uudelleen.
- AWS CDK ja Lambda-ajo tukevat Node 22:ta; CDK:n `NodejsFunction`
  (esbuild-bundlaus) toimii sellaisenaan.
- Mikäli nvm ei ole käytössä, vaihtoehto: lataa asennuspaketti
  https://nodejs.org/ (LTS 22.x) tai `sudo apt install nodejs`
  (jakelun versio voi olla vanha — suositus nvm).

## 3. Kokonaisarkkitehtuuri

```
Ulkoiset tietolähteet
├─ Tampere Traffic API        (traffic-incidents.tampere.fi/api/v1)
├─ Fintraffic REST / MQTT     (tie.digitraffic.fi, vaihe 2+)
├─ Poliisi RSS                (Sisä-Suomen poliisilaitos)
├─ Pelastustoimi              (vaihdettava adapteri; uusi mediapalvelu syksy 2026)
├─ FMI CAP / RSS              (alerts.fmi.fi)
├─ Visit Tampere / Eventz     (tapahtumakalenteri)
├─ Nysse GTFS-RT / SIRI       (joukkoliikennehäiriöt)
└─ Digitraffic Rail           (vaihe 2)
│
▼
EventBridge Scheduler (rate-ajastus per lähde)
│
▼
Tietolähdekohtaiset Lambda-adapterit
├─ fetch → parse → raakadata S3:een → viesti SQS-jonoon
▼
SQS ingestion queue (+ DLQ)
│
▼
Normalisointi-Lambda → Tampere360Event-malli
│
▼
EventBridge custom event bus (+ arkisto)
├─ Validointi ja aluesuodatus (Tampere / seutu / Pirkanmaa)
├─ Duplikaattien tunnistus (tekninen + semanttinen)
├─ Luokittelu ja priorisointi
├─ Geokoodaus / point-in-polygon
├─ (myöhemmin) ilmoitukset, tilastot
▼
DynamoDB (Situations, SourceEvents, IngestionState) + S3
│
▼
API Gateway HTTP API + Query-Lambda
│
▼
React SPA — S3 + CloudFront (+ myöhemmin Route 53, WAF)
```

### Keräysputken kaksi vaihetta ja miksi

```
Source Lambda → SQS Raw Event Queue → Normalizer Lambda → EventBridge Event Bus
```

SQS EventBridgeä ennen toimii kuormaa tasaavana ja virheet eristävänä puskurina:
- lähteen hetkellinen suuri vastaus ei kuormita jatkokäsittelyä
- Lambda käsittelee viestit erissä; osittain epäonnistuneen erän viestit voidaan uudelleenkäsitellä
- epäonnistuneet viestit DLQ:hun; haku ja käsittely eivät ole tiukasti kytkettyjä
- käsittely tehdään idempotentisti

EventBridge reitittää normalisoidut domain-tapahtumat sääntöjen mukaan
(esim. `category = TRAFFIC → traffic processor`, `severity = CRITICAL →
notification processor`). Myöhemmin EventBridge Pipes voi vähentää omaa
integraatiokoodia.

### MVP-toteutuksen rajaus putkessa

Normalisointi-Lambda julkaisee normalisoidun tapahtuman custom-busille, ja
**situation-processor**-Lambda (catch-all-säännön kohde) tekee: validoinnin,
aluesuodatuksen, teknisen idempotenssin, semanttisen yhdistämisen ja
DynamoDB-kirjoitukset. Uudet prosessorit (ilmoitukset, tilastot) liitetään
myöhemmin uusina EventBridge-sääntöinä ilman muutoksia putkeen.

## 4. Repositoriorakenne

```
fibo2/                          (= tampere360-repo)
├── package.json                # npm workspaces
├── tsconfig.base.json
├── .gitignore, README.md
├── apps/
│   ├── web/                    # React SPA (Vite)
│   ├── api/                    # Query-Lambda
│   ├── ingest-tampere-traffic/ # lähdeadapteri + handler
│   ├── ingest-police/
│   ├── ingest-fmi/
│   ├── ingest-events/
│   ├── ingest-nysse/
│   ├── ingest-rescue/          # kokeellinen/stub
│   └── normalize/              # normalisointi-Lambda
├── packages/
│   ├── event-contracts/        # yhteiset tyypit ja domain-eventit
│   ├── source-adapter-sdk/     # EventSourceAdapter-rajapinta + apurit
│   ├── observability/          # jäsennelty logitus, correlation ID, mittarit
│   └── test-fixtures/          # lähteiden tallennetut esimerkkipayloadit
├── infra/
│   ├── bin/app.ts
│   └── lib/
│       ├── foundation-stack.ts
│       ├── data-stack.ts
│       ├── eventing-stack.ts
│       ├── ingestion-stack.ts
│       ├── event-processing-stack.ts
│       ├── api-stack.ts
│       ├── frontend-stack.ts
│       └── monitoring-stack.ts
├── .clinerules/                # tämä suunnitelma
└── docs/
    ├── architecture/
    └── adr/
```

Huom: kaikkia Lambda-funktioita EI tehdä omiksi CDK-stackeikseen —
CloudFormation-riippuvuuksien hallinta monimutkaistuisi turhaan.

## 5. Yhteinen tapahtumamalli (Tampere360Event)

Kaikki lähteet muunnetaan samaan malliin:

```json
{
  "schemaVersion": "1.0",
  "id": "01JXYZ...",
  "canonicalKey": "traffic:tampere-api:incident-12345",
  "source": {
    "system": "TAMPERE_TRAFFIC",
    "sourceId": "incident-12345",
    "url": "https://...",
    "license": "CC-BY-4.0",
    "fetchedAt": "2026-09-06T07:40:00Z"
  },
  "type": "TRAFFIC_INCIDENT",
  "category": "TRAFFIC",
  "severity": "MAJOR",
  "status": "ACTIVE",
  "title": { "fi": "Liikenneonnettomuus Rantaväylällä" },
  "description": { "fi": "Liikenne on ruuhkautunut..." },
  "location": {
    "municipality": "Tampere",
    "district": null,
    "address": null,
    "latitude": 61.498,
    "longitude": 23.76,
    "geometry": null,
    "areaCodes": ["TAMPERE"]
  },
  "validity": { "startsAt": "2026-09-06T07:30:00Z", "endsAt": null },
  "publishedAt": "2026-09-06T07:32:00Z",
  "updatedAt": "2026-09-06T07:38:00Z",
  "tags": ["onnettomuus", "Rantaväylä"],
  "attribution": { "name": "Tampereen kaupunki", "required": true }
}
```

Mallissa erotetaan: tapahtuman oma tunniste, lähdejärjestelmän tunniste,
kanoninen duplikaattiavain, julkaisu-/päivitys-/voimassaoloajat, tila,
vakavuus, sijainti ja geometria, lähde ja lisenssi, kieliversiot,
alkuperäisen sisällön tarkiste (SHA-256).

### Tapahtuman elinkaari

```
DISCOVERED → ACTIVE → UPDATED → ENDED → ARCHIVED
DISCOVERED → CANCELLED
```

Domain-tapahtumat busilla: `SituationDiscovered`, `SituationUpdated`,
`SituationEnded`, `SituationCancelled`, `SituationMerged`.

## 6. Duplikaattien käsittely (kaksi tasoa)

### 6.1 Tekninen idempotenssi
- Avain: `source + sourceId + sourceRevision`, tai jos revisionumeroa ei ole:
  `SHA-256(source + sourceId + relevantContent)`
- DynamoDB-kirjoitus ehdollisena: `attribute_not_exists(processingKey)`
- Saman lähdeviestin uudelleenkäsittely ei luo uutta tapahtumaa

### 6.2 Semanttinen yhdistäminen
MVP-sääntö: sama tapahtumatyyppi AND etäisyys < 500 m AND alkamisaikojen ero
< 30 min ⇒ mahdollinen sama tilanne.

Lähdetapahtumia EI poisteta. Niiden päälle luodaan kanoninen **Situation**:

```
Situation
├─ Tampere Traffic source event
├─ Police source event
└─ Nysse source event
```

UI näyttää yhden tilanteen ja voi kertoa vahvistuksesta useasta lähteestä.

## 7. Tietokannat ja tallennus

### DynamoDB — kolme erillistä taulua (ei single-table MVP:ssä)

| Taulu | Käyttötarkoitus |
|---|---|
| `Situations` | kanoniset, UI:ssa näkyvät tilanteet |
| `SourceEvents` | alkuperäisestä lähteestä normalisoidut tapahtumat |
| `IngestionState` | lähdekohtainen tekninen tila (lastSuccessfulFetch, etag, cursor, status) |

GSI:t (MVP):
- GSI1: `status + startsAt`
- GSI2: `category + startsAt`
- GSI3: `municipality + startsAt`
- GSI4: `geohash + startsAt`

OpenSearch Serverless vasta myöhemmin (vapaasanahaku, relevanssi, geohaut).

### S3 raakadata

```
s3://tampere360-raw/source=tampere-traffic/year=2026/month=09/day=06/hour=10/...
```

Hyödyt: adapteri ajettavissa uudelleen vanhaa dataa vasten, normalisointia
kehitettävä ilman uutta hakua, virhetutkinta, audit trail, analytiikka.
Lifecycle: aktiivinen 30–90 pv → Glacier tai poisto.

### Sijaintisuodatus ja paikkatieto

Kolme sijaintitasoa: Tampereen kunta, Tampereen seutu, Pirkanmaa.

MVP-toteutus:
- kuntarajat GeoJSONina S3:ssa (avoindata.fi, CC BY 4.0)
- geometria ladataan Lambdaan; point-in-polygon-tarkistus
- geohash koordinaateista; DynamoDB-kentät kunta/kaupunginosa/geohash
- lähteen omat kunta/maakunta-kentät täsmäykseen (Digitrafficissa valmiina)

Tekstisijainnille käsittelyjärjestys: paikannimihakemisto → kaupunginosa/kunta
→ AWS Location Service -geokoodaus tarvittaessa → `locationConfidence` +
`locationMethod`. Epävarmaa koordinaattia EI koskaan esitetä varmana.

## 8. Adapterirajapinta (pelastustoimen vaihtuva lähde)

```ts
interface EventSourceAdapter {
  readonly source: SourceSystem;
  fetch(context: FetchContext): Promise<RawSourceBatch>;
  parse(batch: RawSourceBatch): Promise<ParsedSourceEvent[]>;
  checkpoint(batch: RawSourceBatch): Promise<SourceCheckpoint>;
}
```

Adapteri vastaa vain: datan hakeminen, formaatin jäsentäminen, teknisen
metadatan lisääminen, raakadatan tallennus S3:een, raakatapahtuman lähetys
käsittelyjonoon. Adapteri EI tee lopullista liiketoimintaluokittelua.

Pelastuslähteen vaihto on pelkkä uusi toteutus (`PetoAdapter` →
`RescueMediaAdapter`); normalisoija ja UI näkevät saman tyypin
`RESCUE_INCIDENT`.

Konfiguraatiot Parameter Storeen:
```
/tampere360/{env}/sources/{name}/enabled
/tampere360/{env}/sources/{name}/base-url
/tampere360/{env}/sources/{name}/poll-interval
```
Salaisuudet (API-avaimet) Secrets Manageriin.

## 9. Tietolähteet ja aikataulutus

| Lähde | MVP | Hakuväli | Huomiot |
|---|---|---|---|
| Tampere Traffic API | ✅ ensisijainen | 1 min | JSON/D2Light, CORS, ilmainen; kattaa myös Fintraffic/Rantatunneli/Nokia Arena |
| Poliisi RSS (Sisä-Suomi) | ✅ | 2–5 min | tarkka URL selvitettävä; tallennetaan sellaisenaan, geokoodataan |
| FMI CAP | ✅ | 5 min | CAP 1.2, RSS/Atom; aluesuodatus Pirkanmaa/Tampere |
| Visit Tampere / Eventz | ✅ | 15–60 min | CC BY 4.0; rajapinta selvitettävä |
| Nysse Alerts | ✅ | 1 min | GTFS-RT Alerts (max 60 s haku), SIRI GM; ei ajoneuvosijainteja |
| Pelastustoimi | adapteri valmiiksi | lähteen mukaan | uusi mediapalvelu syksy 2026 |
| Fintraffic Road | vaihe 2 | 1–2 min | täydentävä/varmistava; DATEX II 3.7, MQTT |
| Digitraffic Rail | vaihe 2 | 1–2 min | Tampereen aseman häiriöt |
| Liikennekamerat | vaihe 2 | – | näytä lähin kamera tilanteen yhteydessä |
| MQTT | vaihe 2–3 | – | IoT Core / Fargate / bridge; vain jos REST-viive ei riitä |
| Liikennevalodata | ei MVP | – | edellyttää trendianalyysiä |
| Sähkö ja vesi | ei MVP | – | luotettava häiriölähde puuttuu |

Periaate: Tampereen API on ensisijainen liikennelähde; Fintrafficia EI
näytetä rinnakkain sellaisenaan vaan myöhemmin täydentävänä lähteenä.

### Validointitulokset 6.9.2026

| Lähde | Status |
|---|---|
| Digitraffic v2 traffic-announcements | ✅ toimii; GeoJSON; kunta/maakunta-kentät suodatukseen |
| FMI CAP RSS (`alerts.fmi.fi/cap/feed/rss_fi-FI.rss`) | ✅ toimii; item → CAP XML; CC BY 4.0 |
| `traffic-incidents.tampere.fi` | ⚠️ ei vastaa dev-verkosta (DNS); todennäköisesti toimii AWS:stä |
| Poliisi RSS | ⚠️ tarkka URL selvitettävä (poliisi.fi JS-renderöity; `/rss` ja `/tiedotteet` 404) |
| VisitTampere/Eventz | ⚠️ `/api/v1/event` ja `/api/v1/events` 404; kalenteri hetkellisesti rikki |
| Nysse dev-dokumentaatio | ⚠️ ei aukea dev-verkosta; URL:t selvitettävä |

## 10. Backend API

```
GET /v1/situations?category=TRAFFIC,WEATHER&status=ACTIVE&area=TAMPERE
                   &from=...&to=...&limit=50&cursor=...
GET /v1/situations/{id}
GET /v1/map
GET /v1/categories
GET /v1/sources
GET /v1/health/sources
```

- API Gateway **HTTP API** (kevyempi kuin REST API; CORS, OAuth2/OIDC-valmius)
- Query-Lambda → DynamoDB; **cursor-sivutus** (ei offset)
- MVP:ssä React pollaa 30–60 s välein; WebSocket/AppSync/SSE myöhemmin

## 11. React-frontend

```
Route 53 (myöhemmin) → CloudFront (+ WAF myöhemmin) → yksityinen S3 → React SPA
```

Teknologiat: React, TypeScript, Vite, TanStack Query, React Router,
**MapLibre GL JS** (kartta), Vitest, MSW.

MapLibre-kartan tiililähde MVP:ssä: OSM-rasteritiilet (tyyli
rasteri-stylespecinä) tai OpenFreeMap-vektoritiilet — molemmat vapaita,
OSM-attribuutio (`© OpenStreetMap contributors`) näytettävä kartalla ja
sovelluksessa. WebGL-pohjainen MapLibre skaalautuu Leafletia paremmin
suuriin pistemääriin ja mahdollistaa myöhemmin vektoritiilet, 3D-tyylit
ja clusteroinnin.

TanStack Query hoitaa: välimuistin, taustapäivitykset, retry-logiikan,
cursor-sivutuksen, vanhan datan näyttämisen päivityksen aikana.

Näkymät:
- Nyt (aktiiviset häiriöt ja varoitukset)
- Tänään (tapahtumat ja ennakoidut häiriöt)
- Kartta
- Liikenne / Säävaroitukset / Kulttuuri ja tapahtumat / Joukkoliikenne
- Lähteiden tila

## 12. Virheenkäsittely ja uudelleenajo

Jokaiseen asynkroniseen vaiheeseen: rajattu retry exponential backoffilla,
DLQ, idempotentti käsittely, correlation ID, CloudWatch-hälytykset,
käsittelemättömän datan säilytys.

**Erilliset DLQ:t** (ei yhtä yhteistä):
1. Source Scheduler DLQ
2. Raw Ingestion DLQ
3. Normalization DLQ
4. Domain Event Delivery DLQ

EventBridge voi ohjata epäonnistuneet toimitukset SQS DLQ:hun. Custom event
bus arkistoidaan (EventBridge Archive: suodatus, säilytysaika, uudelleenajo).

## 13. Valvonta (CloudWatch)

Dashboardiin:
- **Lähdekohtaiset**: viimeisin onnistunut haku, tietuemäärät, uudet
  tapahtumat, HTTP-vastausaika, virheet, peräkkäiset epäonnistumiset, datan
  ikä, rakenteeltaan virheelliset tapahtumat
- **Putki**: SQS-jonon pituus, vanhimman viestin ikä, Lambda errors/throttles,
  DLQ-viestit, normalisointiviive, EventBridge failed invocations, DynamoDB
  throttling
- **Liiketoiminta**: aktiiviset tilanteet kategorioittain, vastaanotetut
  tapahtumat lähteittäin, yhdistetyt duplikaatit, ilman sijaintia jääneiden
  osuus, epävarmasti geokoodattujen osuus, end-to-end-viive

Hälytykset:
- Poliisi RSS ei päivittynyt 30 minuuttiin
- Tampere Traffic API epäonnistui 5 kertaa
- FMI-data yli 15 minuuttia vanhaa
- DLQ:ssa ≥ 1 viesti
- Normalisointijonon vanhin viesti yli 5 minuuttia

## 14. Tietoturva

MVP:ssä vähintään:
- S3 Block Public Access + CloudFront Origin Access Control
- API Gateway throttling + tarkat CORS-säännöt
- Lambda-roolikohtainen least privilege IAM
- KMS-salaus omalle tapahtuma- ja käyttäjädatalle
- Secrets Manager API-avaimille
- CloudTrail
- CSP- ja selaimen suojausotsakkeet CloudFrontissa
- **Lähteiden HTML puhdistetaan ennen esittämistä** — RSS-kuvauksia EI viedä
  Reactiin käsittelemättömänä `dangerouslySetInnerHTML`-sisältönä

Myöhemmin/tuotannossa: CloudFront + AWS WAF, AWS Config/Security Hub,
riippuvuuksien haavoittuvuusskannaus CI-putkessa.

Huom: WAF maksaa ~5 €/kk — MVP:ssä `wafEnabled`-lippu (oletus: ei domainia,
CloudFrontin oletusdomain; WAF kun domain tulee).

## 15. CI/CD

Pull request: `npm ci` → lint → unit tests → contract tests → `cdk synth` →
`cdk diff` → security checks → frontend build.

Main branch: deploy dev → integration tests → smoke tests → manual approval →
deploy prod → smoke tests.

Ympäristöt: dev / test / prod (myöhemmin omat AWS-tilit: non-prod + prod).
Kirjautuminen AWS:ään OIDC-roolilla (GitHub Actions/Azure DevOps) — ei
pitkäikäisiä access key -avaimia CI:hin.

MVP-vaiheessa deploy tapahtuu paikallisesti `cdk deploy` -komennolla;
GitHub Actions -workflow lisätään kun repo on GitHubissa.

## 16. Toteutusvaiheet

### Vaihe 0 — Pohja
- git init, .gitignore, README
- npm workspaces -monorepo, tsconfig.base.json, vitest, eslint/prettier
- `packages/event-contracts`: Tampere360Event, RawSourceBatch,
  ParsedSourceEvent, SourceCheckpoint, enumit, domain-eventit
- `packages/source-adapter-sdk`: EventSourceAdapter-rajapinta, fetch/retry,
  SHA-256-tarkiste, correlation ID
- `packages/observability`: jäsennelty logitus, mittariapurit

### Vaihe 1 — Infra (CDK)
- `infra/bin/app.ts` + stackit:
  - FoundationStack (nimennys, KMS)
  - DataStack (S3 raw + lifecycle; DynamoDB-taulut + GSI1–GSI4 + TTL)
  - EventingStack (custom bus, arkisto, säännöt, DLQ:t)
  - IngestionStack (Scheduler per lähde + DLQ; SQS ingestion + DLQ;
    adapteri-Lambdat NodejsFunction/esbuild)
  - EventProcessingStack (situation-processor)
  - ApiStack (HTTP API + query-Lambda, CORS, throttling)
  - FrontendStack (S3 web + OAC + CloudFront; WAF-lippu)
  - MonitoringStack (dashboard + hälytykset)
- Parameter Store -konfiguraatiot lähteille

### Vaihe 2 — Ensimmäinen päästä-päähän (FMI CAP)
- `apps/ingest-fmi`: RSS → CAP XML → raw S3 → SQS
- `apps/normalize` + situation-processor: validointi, Pirkanmaa-suodatus,
  idempotentti DynamoDB-kirjoitus
- `apps/api`: GET /v1/situations
- `cdk deploy` + savutesti curlilla

### Vaihe 3 — Loput MVP-adapterit
- `apps/ingest-tampere-traffic` (1 min)
- `apps/ingest-police` (RSS-URL selvitettynä, 2–5 min)
- `apps/ingest-events` (VisitTampere/Eventz selvitettynä, 15–60 min)
- `apps/ingest-nysse` (GTFS-RT Alerts, 1 min)
- `apps/ingest-rescue` (kokeellinen stub, disabled-oletus)

### Vaihe 4 — Frontend ✅
- `apps/web`: Vite + React 19 + TS, TanStack Query (30 s pollaus), React Router
- MapLibre GL JS -kartta (OSM-rasteritiilet, attribuutio), tilannemarkerit
  vakavuuden mukaan värjättynä, kategorianäkymät, Lähteiden tila
- HTML-sanitisointi (`sanitizeText`), attribution-näyttö footerissa
- `BucketDeployment` CDK:ssa: `apps/web/dist` + ajonaikainen `/config.json`
  (API-osoite), `config.json`-behavior `CACHING_DISABLED`
- CSP päivitetty: API-origin, OSM-tiilet, MapLibren blob-workerit
- MapPage lazy-latauksella (MapLibre ~1,0 MB omaan chunkkiinsa)
- Sivut: `/` (Nyt), `/kartta`, `/liikenne`, `/saa`, `/poliisi`,
  `/joukkoliikenne`, `/lahteet`
- Nyt-sivu esittää aktiiviset tilanteet **tapahtumatyypeittäin koostekortteina**,
  ei sekoitettuna listana: jokaisella tyypillä oma kortti (otsikko = tyyppi,
  määrä, 5 viimeisintä otsikko + alku-/julkaisuaika, "Näytä lisää…" -linkki
  tyyppikohtaiseen välilehteen). Kortit samassa dynaamisessa ruudukossa
  kuin yksittäiset tilannekortit.
- Lisäksi korjattu lähdekoordinaattien käsittely normalisoijassa (§7):
  Digitrafficin Point/LineString-geometria → `latitude`/`longitude` +
  `location.geometry` + `locationMethod`. Kartalla 5/5 liikennettä.
- Yksikkötestit `apps/web/src/lib/format.test.ts` (sanitointi, aikamuotoilu)

Toteutuksen aikana havaitut ja korjatut asiat:
- `maplibre-gl` v6:lla ei ole default-exportia → nimetty import
- CDK-tokenia ei saa ajaa `new URL()`:in läpi → CSP:ssä käytetään
  `httpApi.apiEndpoint`-arvoa sellaisenaan
- **Karttatiilet eivät latautuneet**: MapLibre hakee rasteritiilet `fetch`:llä
  (ei `<img>`:llä), joten tiilien origin tarvitaan `connect-src`-direktiiviin —
  pelkkä `img-src` ei riitä. CSP rakennetaan nyt `infra/lib/csp.ts`:ssä ja
  regressiosuoja on `infra/test/csp.test.ts` (vitest-include laajennettu
  kattamaan `infra/test/**`)
- Lint-virheet (9 kpl) siivottu: käyttämättömät importit ja tyhjät
  catch-lohkot (`apps/ingest-fmi`, `apps/ingest-nysse`,
  `apps/normalize`, `apps/situation-processor`)

Selaintason verifiointi (headless Chrome, `--dump-dom` + NetLog):
- `/` renderöi 66 aktiivista tilannetta kategorialaattoineen
- `/kartta` luo MapLibre-canvasin, 5 markeria, **28 tiilipyyntöä → HTTP 200**,
  0 CSP-rikkomusta
- `/lahteet` näyttää 4 lähdettä `OK`-tilassa

### Vaihe 5 — Testit, valvonta, CI
- Yksikkötestit fixture-pohjaisesti (test-fixtures-paketti)
- Contract-testit adaptereille
- CloudWatch-dashboard + hälytykset käyttöön
- GitHub Actions -workflow (PR-tarkistukset + OIDC-deploy)
- ADR-dokumentit keskeisistä päätöksistä
- **Prettier-kertakorjaus**: `npm run format:check` ei ole koskaan ollut
  vihreä — 35 tiedostoa (paketit ja apps) on kirjoitettu tiiviimmällä
  tyylillä kuin Prettier tuottaa. Aja `npm run format` omassa commitissaan
  ennen kuin format-tarkistus lisätään CI-putkeen. `apps/web` on jo
  Prettier-muodossa.

### MVP:n ulkopuolelle (dokumentaation §16)
OpenSearch, AI-luokittelu, WebSocketit, Fintraffic MQTT, liikennevalojen
analyysi, live-ajoneuvokartta, sähkö- ja vesihäiriöt, automaattiset
käyttäjäilmoitukset.

## 17. Keskeiset arkkitehtuuripäätökset (yhteenveto)

1. Yhteinen, lähderiippumaton tapahtumamalli
2. Raakadatan pysyvä tallennus uudelleenkäsittelyä varten
3. SQS käsittelypuskurina, EventBridge domain-tapahtumien reitittimenä
4. Idempotenssi kaikissa kuluttajissa
5. Kanonisen tilanteen erottaminen yksittäisistä lähdetapahtumista
6. Pelastustoimi vaihdettavana adapterina
7. DynamoDB MVP:n ensisijaisena operatiivisena tietokantana
8. CDK v2 TypeScriptillä koko infrastruktuurin hallintaan

## 18. Avoimet selvityskohdat toteutuksessa

| Asia | Suunnitelma |
|---|---|
| Poliisin Sisä-Suomen RSS:n tarkka URL | Selvitetään poliisi.fi:ltä; syöte on olemassa (dokumentaatio varmistaa) |
| Visit Tampere / Eventz -rajapinta | Selvitetään; kalenteri oli hetkellisesti alhaalla 6.9.2026 |
| Nysse GTFS-RT / SIRI -URL:t | Selvitetään Nysse-dokumentaatiosta toteutuksessa |
| `traffic-incidents.tampere.fi` | Testataan AWS:stä deployssä; fallback Digitraffic v2 |
| Kuntaraja-GeoJSON | avoindata.fi / Maanmittauslaitos, CC BY 4.0 |

## 19. Oletukset

- Yksi AWS-tili, `dev`-ympäristö ensin (region eu-west-1)
- Ei omaa domainia vielä → CloudFrontin oletusdomain (`*.cloudfront.net`)
- Lambda-runtime `nodejs22.x`; paikallinen Node 22 (asennusohje §2) —
  nodejs20.x deprekoitiin AWS Lambdassa 30.4.2026
- Kustannusarvio MVP-liikenteellä: free tier -tasoa (+ WAF myöhemmin ~5 €/kk)




## 20. Aikamalli: startsAt, endsAt, publishedAt, firstSeenAt

**Periaate (päätetty 20.9.2026): aikaleimoja ei koskaan arvata.** Järjestelmän
oma kellonaika ei saa valua tapahtuman ajaksi. Jos lähde ei kerro tapahtuman
alkuaikaa, arvo on `null` ja käyttöliittymä sanoo "alkuaika ei tiedossa".

### Kenttien merkitys

| Kenttä | Merkitys | Lähde |
|---|---|---|
| `event.validity.startsAt` | tapahtuman alkuaika | vain lähteen oma tapahtuma-aika; `null` jos ei tiedossa |
| `event.validity.endsAt` | tapahtuman päättymisaika | lähteen oma aika; `null` jos ei tiedossa |
| `event.publishedAt` | lähteen julkaisuaika | lähteen oma julkaisuaika; `null` jos ei tiedossa |
| `event.updatedAt` | lähteen päivitysaika | lähteen oma päivitysaika; `null` jos ei tiedossa |
| `event.firstSeenAt` | milloin Tampere360 näki tapahtuman | tekninen, aina asetettu (normalisointi) |
| `Situation.startsAt` | **GSI-lajitteluavain** = järjestysaika | `validity.startsAt` → `publishedAt` → `firstSeenAt` |
| `Situation.publishedAt`, `firstSeenAt` | näytetään UI:ssa | kopiot tapahtumasta |

### Lähdekohtainen päättely (normalisoija)

| Lähde | `startsAt` | `endsAt` | `publishedAt` / `updatedAt` |
|---|---|---|---|
| FMI_CAP | `onset` → `effective` | `expires` | `sent` |
| TAMPERE_TRAFFIC | `timeAndDuration.startTime` | `timeAndDuration.endTime` | `releaseTime` / `versionTime` |
| NYSSE_ALERTS | `activePeriod[0].start` (adapteri: `start`) | `activePeriod[0].end` | syötteen `header.timestamp` |
| POLICE_RSS | **ei ole** → `null` | ei ole → `null` | `dc:date` → `pubDate` |
| VISIT_TAMPERE | `startDate` | `endDate` | ei ole → `null` |
| RESCUE_MEDIA (stub) | ei ole → `null` | ei ole → `null` | ei ole → `null` |

Kaikki ajat normalisoidaan UTC-muotoon (`new Date(x).toISOString()`), jotta
merkkijonopohjainen GSI-lajittelu on oikea myös eri formaateilla
(CAP `+03:00`, RSS RFC 822).

### API ja UI

- `GET /v1/situations` palauttaa `startsAt` (nullable), `publishedAt`,
  `firstSeenAt`. `startsAt` luetaan tapahtumasta (`event.validity.startsAt`),
  **ei** rivin lajitteluavaimesta.
- UI (`describeSituationTime`): alkuaika tiedossa → `alkoi 20.9.2026 klo 08.53`;
  kun alkuaika ei ole tiedossa, alkuaikakohtaan **ei näytetä mitään** — vain
  lisätieto `julkaistu … · havaittu …`. Selitystekstiä ("alkuaika ei tiedossa")
  ei näytetä, koska oleellinen tieto on jo lisätietorivillä.

### Toteutuksen aikana korjatut viat (20.9.2026)

1. `publishedAt`/`updatedAt` olivat **normalisoinnin kellonaika**, eivät
   lähteen julkaisuaika (rikkoi mallin oman sopimuksen) → korjattu.
2. NYSSE: normalisoija luki `effectiveStart`/`effectiveEnd`, adapteri kirjoitti
   `start`/`end` → **28/28 tilannetta putosi hakuaikaan**; nyt 14/14 käyttää
   lähteen omaa aikaa.
3. POLICE: `validity` oli aina `null` vaikka RSS antaa `pubDate`/`dc:date` →
   julkaisuaika käyttöön; `startsAt` jää tarkoituksella `null`iksi.
4. `releaseTime`/`versionTime` (Digitraffic) ja `sent` (CAP) oli parsittu mutta
   jätettiin käyttämättä → nyt julkaisu- ja päivitysaikoina.
5. Idempotenssi esti korjatun datan synnyn: kun `SourceEvents`-rivi oli jo
   olemassa mutta `Situations`-kirjoitus oli epäonnistunut, sama tapahtuma ei
   enää koskaan synnyttänyt tilannetta. **Operatiivinen ohje:** kun
   prosessointilogiikkaa muutetaan, tyhjennä `SourceEvents` (tai käytä
   raakadatan uudelleenkäsittelyä), jotta putki tuottaa tilanteet uudelleen.

### Opit DynamoDB-GSI-migraatiosta

- DynamoDB sallii **vain yhden GSI-luonnin tai -poiston per `UpdateTable`**.
  Neljän indeksin uudelleennimeäminen yhdessä deployissa epäonnistuu:
  `Cannot perform more than one GSI creation or deletion in a single update`.
- CloudFormation laskee GSI-muutokset **tallennetusta mallipohjasta**, ei
  live-taulusta — fyysisen taulun ennakkoon muokkaaminen ei auta.
- Tästä syystä lajitteluavain pidettiin nimellä `startsAt` (arvo on
  järjestysaika) sen sijaan, että olisi nimetty uudelleen `timeKey`iksi.
  Jos nimeäminen halutaan myöhemmin, se tehdään **vaiheittain** (yksi

## 21. Prod-käyttöönotto (tampere247.online) — toteutettu 20.9.2026

Tavoite: prod-ympäristö samaan AWS-tiliin omalla nimiavaruudella
(`tampere360-prod-*`) mutta **omalla domainilla ja TLS:llä**. Tarkka runbook:
[`docs/architecture/prod-deploy.md`](../docs/architecture/prod-deploy.md).

### Domain- ja TLS-malli

| Asia | Ratkaisu |
|---|---|
| Domain | `tampere247.online` (apex) + `www.tampere247.online` (sama CloudFront-jakelu) |
| API | `api.tampere247.online` (API Gateway HTTP API custom domain) |
| Hosted zone | `Z04105072OQTLR436VXG7` (Route 53, tili 132339120388) |
| CloudFront-sertifikaatti | ACM **us-east-1** (valmis, apex + `*.tampere247.online`) tuodaan ARN:na — CloudFront ei hyväksy muun alueen sertifikaattia |
| API-sertifikaatti | Luodaan CDK:lla **eu-north-1**:een DNS-validoituna (API Gateway vaatii oman alueen sertifikaatin) |
| TLS | CloudFront `TLSv1.2_2021`, API `TLS_1_2` |
| DNS-tietueet | Route 53 A + AAAA (alias) ovat **CDK:n hallinnassa** — ei käsin luotuja tietueita |

Konfiguraatio on versioitu koodiin: `infra/lib/config.ts`
(`DomainConfig`, `ENVIRONMENT_DOMAINS.prod`, `frontendDomainNames`,
`frontendOrigins`). Dev/test eivät käytä omaa domainia.

### Stackimuutokset

- **FrontendStack**: CloudFront `domainNames` + `certificate` +
  `minimumProtocolVersion`, Route 53 A/AAAA-alias-tietueet, WAF-kytkentä
  (`webAclId`), prod-RETAIN web-bucketille, uusi output `FrontendCustomUrl`.
- **ApiStack**: `api.<domain>` (ACM + `DomainName` + `ApiMapping`), Route 53
  A/AAAA, CORS rajattu frontendin origineihin (`frontendOrigins`), API-URL
  (`httpApiUrl`) palauttaa oman domainin → myös `config.json` ja CSP:n
  `connect-src` käyttävät sitä.
- **WafStack (uusi, us-east-1, opt-in)**: CloudFront-scope WebACL
  (`AWSManagedRulesCommonRuleSet`, `KnownBadInputsRuleSet`,
  `AmazonIpReputationList`). ARN välittyy FrontendStackille
  **cross-region-viittauksena** (`crossRegionReferences`) → edellyttää
  `npx cdk bootstrap aws://<tili>/us-east-1`.
  **Tässä vaiheessa WAF on pois päältä**: prod-npm-skriptit ajavat
  kontekstilla `-c wafEnabled=false` (ei bootstrapia eikä ~5 $/kk kulua);
  WAF kytketään haluttaessa `-c wafEnabled=true`:lla.
- **Prod-kovennukset**: KMS-avain, S3-raw ja S3-web sekä kaikki DynamoDB-taulut
  `RETAIN` prodissa (dev:ssä edelleen `DESTROY` + auto-delete);
  DynamoDB PITR ja `deletionProtection` päällä vain prodissa.
- **Kustannussuojat (20.9.2026)**: API on julkinen ilman avainta, joten
  stage-throttlaus kiristettiin **10 req/s / purske 20** (`API_THROTTLE`) ja
  query-Lambdalle asetettiin **varattu concurrency 5**
  (`QUERY_RESERVED_CONCURRENCY`) — yhdessä nämä rajaavat pahimman
  väärinkäyttöskenaarion ~20–30 $/vrk (ilman rajoja DynamoDB-lukemat yksin
  voisivat maksaa satoja euroja vuorokaudessa). Lisäksi `apps/api/src/params.ts`:
  `limit`-oletus 20, yläraja 200. MonitoringStackiin uudet hälytykset
  `api-request-spike` (≥1000 / 5 min), `api-client-errors` (4xx/429 ≥100 /
  5 min) ja `api-throttles` (Lambda ≥1) sekä SNS-topic policy, joka sallii
  AWS Budgets -ilmoitukset samaan topiciin. Regressiosuoja:
  `infra/test/config.test.ts` + `apps/api/src/params.test.ts`.
- **Lähteiden näkyvyys valvonnassa (20.9.2026)**: prodissa Nysse ei näkynyt
  lainkaan `/v1/health/sources`-listalla, koska (a) Waltti-avain puuttui prodin
  SSM:stä (`/tampere360/prod/sources/nysse/api-key`) ja (b) adapteri palasi
  *ennen* tarkistuspisteen kirjoitusta → lähteelle ei syntynyt riviä
  IngestionState-tauluun, jota health skannaa. Korjattu:
  `apps/ingest-nysse/src/checkpoint.ts` kirjoittaa tilan joka ajopolulla
  (`ERROR` + syykoodi `API_KEY_MISSING` / `FETCH_FAILED` / `PARSE_FAILED`;
  `NO_ALERTS` = onnistunut 0-tulos aikaleimalla) ja `apps/api` palauttaa
  `error`-kentän; eksplisiittinen `ERROR`/`DISABLED` ohittaa lasketun
  `STALE`-tilan, joten syy näkyy UI:ssa asti. Testit:
  `apps/ingest-nysse/src/checkpoint.test.ts` (6). **Muistisääntö: jokainen
  API-avain viedään erikseen per ympäristö** — CDK ei luo salaisuuksia.

### Bugikorjaus: hiljainen `wafEnabled`-lippu

`-c wafEnabled=true` tulee CDK-kontekstiin **merkkijonona** `"true"`, joten
aiempi `app.node.tryGetContext('wafEnabled') === true` oli aina `false` —
WAF:ia ei olisi koskaan syntynyt. Korjattu `contextFlag()`-apurilla
(`infra/bin/app.ts`), joka hyväksyy sekä `true`-että `"true"`-arvon. Sama
koskee `-c domainEnabled=false`, jolla prodin voi deployata ilman domainia
(savutesti).

### Komennot

```bash
npm run synth:prod      # cdk synth  -c env=prod -c wafEnabled=false --region eu-north-1
npm run diff:prod       # cdk diff  -c env=prod -c wafEnabled=false --region eu-north-1
npm run deploy:prod     # cdk deploy --all (sama konteksti), kysyy hyväksynnät
```

WAF otetaan haluttaessa käyttöön erikseen (`-c wafEnabled=true` +
`cdk bootstrap aws://<tili>/us-east-1`) — silloin syntyy yhdeksäs stack
`tampere360-prod-waf` us-east-1:een.

> **Hätätilanne (kustannuspiikki):** ks.
> [`docs/emergency.md`](../docs/emergency.md) — API:n tiukka rajoittaminen
> (1 req/s, Lambda kiinni), keräysputken ja frontendin pysäytys sekä palautus.

### Vahvistettu 20.9.2026

- `npx cdk synth -c env=prod -c wafEnabled=true` → 9 stackia, WAF mukana
  us-east-1:ssä; Frontendin `WebACLId` tulee cross-region-exporttina.
- Frontend-template: aliases `tampere247.online` + `www.tampere247.online`,
  `AcmCertificateArn` (us-east-1), `TLSv1.2_2021`, 4 Route 53 -tietuetta.
- API-template: `AWS::CertificateManager::Certificate` +
  `AWS::ApiGatewayV2::DomainName` + `ApiMapping` (DependsOn `DefaultStage`) +
  A/AAAA-tietueet.
- Dev-synth ennallaan: ei Aliase, ei API-domainia, ei WAF:ia, CORS `*` →
  dev-ympäristöön ei kohdistu muutoksia.
- Testit: `infra/test/config.test.ts` (9 testiä) valvoo domain-konfiguraation
  johdonmukaisuutta (domainit hosted zonen sisällä, sertifikaatti us-east-1,
  API aliverkkotunnus, `frontendOrigins`) **sekä kustannussuojien rajoja**
  (throttlaus ≤ 20 req/s, concurrency ≤ 10, hälytysrajat alle throttlen
  maksimin). `apps/api/src/params.test.ts` (6 testiä) valvoo `limit`-parametria.
  Koko sarja 111 testiä ✅, ESLint ✅.

  indeksi per deploy) tai luomalla taulu uudelleen.

## 22. Tilanteiden elinkaari ja vanhentuminen (20.9.2026)

**Havaittu ongelma:** dev-ympäristössä säävaroitus näkyi "aktiivisena" vielä
7 tuntia päättymisensä jälkeen:

| Kenttä | Arvo |
|---|---|
| `event.title.fi` | Tuulivaroitus maa-alueille |
| `validity.startsAt` | 2026-09-20T05:53:15Z |
| **`validity.endsAt`** | **2026-09-20T10:00:00Z** |
| `status` klo 17:00 | **ACTIVE**, ei `expiresAt`-TTL:ää |

**Kaksi juurisyytä:**

1. Normalisoija kirjoitti elinkaaritilan kovakoodattuna
   (`status: 'ACTIVE', lifecycle: 'ACTIVE'`) — lähteen oma tila ohitettiin.
2. FMI:n CAP-varoituksen elinkaari on **`msgType`-kentässä alert-tasolla**
   (ei `info`-sisällä, ei `alert.status`issa): peruutus lähetetään muodossa
   `<status>Actual</status>` + `<msgType>Cancel</msgType>` ja **uudella
   identifierillä**, joka viittaa alkuperäiseen `<references>`-kentässä.
   Lisäksi FMI **poistaa** päättyneen varoituksen syötteestä ("POISTETTU"),
   joten lopetustapahtumaa ei usein saavu lainkaan → pelkkä tilakentän
   käyttö ei riitä.

**Toteutettu korjaus (C = tilakenttä + aikapohjainen siivous):**

| Osa | Muutos |
|---|---|
| `apps/ingest-fmi/src/cap-parser.ts` | `msgType` ja `references` luetaan **alert-tasolta** (CAP 1.2), `status` johdetaan (`Cancel → CANCELLED`) ja viitatut identifierit parsitaan |
| `apps/ingest-fmi/src/handler.ts` | Peruutus kohdistetaan `<references>`-kentän viittaamaan identifieriin → **sama `canonicalKey`** kuin alkuperäisellä varoituksella |
| `apps/normalize/src/event-status.ts` (uusi) | Lähteen elinkaaritila → `status`/`lifecycle`; vain `FMI_CAP` tulkitaan toistaiseksi (muiden `status`-kentillä voi olla eri merkitys) |
| `apps/situation-expiry/` (uusi) | Scheduler **5 min**: skannaa Situations ja sulkee ACTIVE-rivit, kun (a) `validity.endsAt` on ohitettu tai (b) samalla `canonicalKey`llä on terminaalirivi; suljetulle riville `expiresAt`-TTL (30 pv) |
| `apps/api/src/handler.ts` | Kategoria- ja aluehaut (`gsi2`, `gsi3`) suodatetaan nyt `FilterExpression`illä statuksen mukaan — aiemmin `status`-parametri jätettiin huomiotta, joten päättyneet tilanteet olisivat näkyneet kategorialistoilla |

**Miksi siivous eikä pelkkä tilakenttä:** FMI poistaa varoituksen syötteestä
kokonaan, joten järjestelmä ei koskaan saa lopetusviestiä. Aikapohjainen
siivous kattaa myös lähteet, jotka eivät päivitä tapahtumaa päättymisen
jälkeen.

**Kustannus:** skannaus ~50–100 rivin taulusta 5 min välein ≈ 14 000 RRU/vrk
≈ 0,004 $/vrk. Ei uutta GSI:tä (DynamoDB sallii vain yhden indeksimuutoksen
per deploy, ks. §20).

**Testit:** `cap-parser.test.ts` (10), `event-status.test.ts` (4),
`expiry.test.ts` (10) ja `infra/test/config.test.ts` (+1 siivousvälille).
Koko sarja 111 testiä ✅, ESLint ✅.

**Tunnettu rajoitus:** peruutus luo *uuden* tilannerivin (uusi `situationId`)
samalla `canonicalKey`lla; vanha ACTIVE-rivi suljetaan siivouksella ≤5 min
kuluessa. Tilanteen päivittäminen paikallaan (`SituationUpdated` /
`SituationEnded` samalle riville) vaatisi `canonicalKey`-indeksin — myöhempi
vaihe, ja se on toteutettava vaiheittain GSI-rajoituksen vuoksi.

## 23. Poliisin tiedotelinkki (20.9.2026)

Poliisin RSS sisältää jokaiselle tiedotteelle `<link>`-kentän poliisi.fi:hin,
mutta syötteen `<description>` on **aina vain otsikko uudelleen**
(`<p>otsikko</p>`, 100/100 itemiä 20.9.2026). Linkki on siis ainoa oikea
lisätieto — infotekstinä näkyi turha toisto.

| Osa | Muutos |
|---|---|
| `apps/normalize/src/source-fields.ts` (uusi) | `stripHtml`, `isSafeHttpUrl`, `extractSourceUrl` (vain http/https), `descriptionIfDistinct` (jättää otsikkotoiston pois) |
| `apps/normalize/src/handler.ts` | `event.source.url` = lähteen linkki; POLICE-infoteksti jää pois, kun se toistaisi otsikon |
| `apps/api/src/links.ts` (uusi) | `situationSourceUrl`: `source.url` → `sourceId` (jos se on URL) → `null` |
| `apps/api/src/handler.ts` | `url` mukaan `/v1/situations`-listavastaukseen |
| `apps/web` | `sourceLink` (vain http(s) → klikattava linkki), `distinctDescription` (piilottaa otsikkotoiston myös vanhoilta riveiltä), linkki Nyt-sivun koostekortilla ja tyyppisivulla: *"Lue koko tiedote: poliisi.fi ↗"* |

**Miksi `source.url` eikä infoteksti:** mallissa oli jo `SourceRef.url`
("URL alkuperäiseen sisältöön"), ja linkki renderöidään UI:ssa klikattavana.
Pelkkä URL-merkkijono infotekstissä olisi näkynyt pelkkänä tekstinä.

**Ei backfilliä tarvita:** poliisin RSS:n `guid` on *sama URL* kuin `<link>`,
ja adapteri käyttää `guid`:ia `sourceId`:nä → kaikilla 34 vanhalla poliisirivillä
(dev, tarkistettu 20.9.2026) `sourceId` on `https://poliisi.fi/-/...`, joten API
johtaa linkin siitä. Tämä on dokumentoitu `links.ts`:ssä ja testattu.

**Testit:** `source-fields.test.ts` (8), `links.test.ts` (6), `format.test.ts`
(+11 → 19). Koko sarja **130 testiä** ✅, ESLint ✅.

**Tietoturva:** vain http(s)-osoitteet renderöidään linkkinä
(`javascript:`/`data:`-URL:t hylätään sekä normalisoinnissa että UI:ssa), ja
ulkoiset linkit avataan `target="_blank" rel="noopener noreferrer"`.


## 24. Brändi "Tampere 247" ja vakavuusluokituksen huomautus (20.9.2026)

Julkinen brändi on **Tampere 247** (domain `tampere247.online`). Brändimuutos
koskee vain käyttäjälle näkyvää tekstiä: **tekniset tunnisteet säilyvät
ennallaan** (`tampere360-*`-resurssinimet, npm-paketit `@tampere360/*`,
`Tampere360Event`-malli, SSM-polut, EventBridge-tapahtumalähde).

| Osa | Muutos |
|---|---|
| `apps/web/src/components/Layout.tsx` | Otsikon brändi `Tampere360` → `Tampere 247`; brändimerkki `T360` → `T247` |
| `apps/web/index.html` | `<title>` ja meta-description |
| `apps/web/package.json` | kuvaus (paketin nimi `@tampere360/web` pysyy teknisenä tunnisteena) |
| `apps/web/src/api/types.ts` | kommentti: `firstSeenAt` = "Tampere 247 näki tapahtuman" |

**Vakavuusluokittelun huomautus siirrettiin** Nyt-sivun alaosasta footeriin
lähde- ja lisenssitietojen yhteyteen (`Layout.tsx`), joten se näkyy nyt
kaikilla sivuilla. Sisältö säilyi muuten ennallaan (luokittelu on oma
automaattinen arviomme, poikkeuksena FMI:n CAP-varoituksen lähdevakavuus);
tyylinä sama `footer__note` kuin vastuuvapauslausekkeella.

**Verifiointi:** `npm run build -w @tampere360/web` ✅ (tsc --noEmit + vite),
web-yksikkötestit 25/25 ✅, Prettier ✅ (muokatut tiedostot),
headless-Chrome `--dump-dom`: brändi `Tampere 247`, brändimerkki `T247`,
footer-huomautus renderöityy, **0 osumaa** `Tampere360`/`T360` DOM:issa ja
tuotantobundlessa. Huom: `apps/web/src/lib/format.ts` on ennestään
Prettier-korjauslistalla (§16).

Infra ja dokumentaatio käyttävät edelleen nimeä `Tampere360` (resurssien
kuvaukset, `docs/`, README) — ne ovat teknisiä tunnisteita eivätkä
käyttäjälle näkyvää brändiä.

