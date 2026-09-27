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
- Liikennekamerat (Digitraffic-kelikamerat, alle 10 km Tampereen keskustasta, §25)
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
  `/joukkoliikenne`, `/lahteet` — uusi `/kamerat` lisätty 23.9.2026 (§25)
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

**Tarkistus 23.9.2026 (käyttäjän pyynnöstä):** käyttäjälle näkyvässä
frontendissä ei ole yhtään `Tampere360`-viittausta:

| Kohde | Tulos |
|---|---|
| `grep -rniE 'tampere ?360' apps/web` (ts/tsx/html/json/css/svg) | ainoa osuma paketin nimi `@tampere360/web` = tekninen tunniste |
| Julkaistu bundle (dev + prod, `index-*.js`) | **0** osumaa `Tampere360`, 2 osumaa `Tampere 247` |
| Renderöity DOM (headless Chrome, dev + prod) | **0** osumaa `Tampere360`, 4 osumaa `Tampere 247` |

Vakavuusluokittelun huomautus on **vain footerissa** lähde- ja lisenssitietojen
yhteydessä (DOM-tarkistus: 1 osuma, `footer__note`-lohkossa) — Nyt-sivun
alaosassa sitä ei ole.


## 25. Liikennekamerat-välilehti (23.9.2026)

Uusi välilehti `/kamerat` näyttää Tampereen alueen kelikamerat. Kuvat tulevat
**suoraan Digitrafficilta selaimesta** — ne eivät kulje oman API:n kautta, joten
kameroiden katselu ei kuluta API:n throttlea, Lambda-concurrencya eikä
DynamoDB-lukemia.

### Rajapinta ja sen kaksi erityispiirrettä

| Asia | Ratkaisu |
|---|---|
| Asemaluettelo | `GET https://tie.digitraffic.fi/api/weathercam/v1/stations` (GeoJSON, 810 asemaa, ~37 kt gzipattuna) |
| Kuvatiedosto | `https://weathercam.digitraffic.fi/{presetId}.jpg` — sama `imageUrl`, jonka Digitrafficin oma metatietorajapinta palauttaa; HTTP 200, `image/jpeg`, ~150 kt |
| **gzip-pakko** | Ilman `Accept-Encoding: gzip` Digitraffic vastaa **406** ("Use of gzip compression is required…"). Selain lähettää otsikon itse, joten selaimessa tämä on automaattista — mutta curlilla se on muistettava (`curl --compressed`) |
| **`Digitraffic-User`-otsikko** | Digitraffic pyytää sovelluksen tunnistamista. Otsikko on sallittu CORS-preflightissa, joka vastaa 204 ja `access-control-max-age: 86400` → yksi OPTIONS-kutsu per selainistunto |
| CORS | `access-control-allow-origin: *` → selain voi hakea suoraan, ei proxyä oman API:n kautta |
| Aikaleimat | Listarajapinnassa ei ole kuvan aikaa; "kuva päivitetty" = aseman `dataUpdatedTime`. Suuntien nimiä (esim. "Vaasaan") ei ole listassa → kamerat numeroidaan (1…n) |

### Suodatus ja esitys

| Osa | Ratkaisu |
|---|---|
| `apps/web/src/api/cameras.ts` | Digitraffic-tyypit + `fetchCameraStations` (otsikot, `cache: 'no-cache'` → ETag-validointi, kevyt 304 jos data ei muutu) |
| `apps/web/src/lib/cameras.ts` | Puhtaat funktiot `haversineKm`, `toTrafficCameras`, `cameraLabel`, `formatDistance`, `cameraImageUrl`. Oletukset: keskusta **61.4978, 23.761** (Keskustori), säde **10 km**, vain `inCollection !== false` -kamerat, järjestys lähimmästä kauimmaiseen |
| `apps/web/src/pages/CamerasPage.tsx` | Sivu + **"Päivitä kuvat"** -painike; ei automaattista pollausta (`refetchOnWindowFocus: false`), koska kuvat ovat raskaita |
| `apps/web/src/components/CameraCard.tsx` | Kuva 16:9 (`loading="lazy"`), klikkaus avaa täysikokoisen kuvan uuteen välilehteen; aseman nimi, etäisyys, kuvan aika; chipeillä vaihdetaan aseman kameraa (16/24 asemalla useampi) |
| Kuvakoko | Ruudukko rajattu 1000 px → **3 saraketta, 2 riviä = 6 kuvaa ruudulla** (verifioitu kuvakaappauksella 1440×900) |
| Cache-avain | Kuvan URL on `?v=<dataUpdatedAt>`: "Päivitä kuvat" uusii listan ja pakottaa selaimen hakemaan kuvat uudelleen (ohittaa myös CloudFront-välimuistin) |
| Suorituskyky | 24 kuvaa × ~150 kt ≈ 3,6 Mt jos kaikki ladataan — siksi `loading="lazy"`, jolloin aluksi latautuu vain näkyvät ~6 |

Mitattu dev-ympäristössä 23.9.2026: 810 asemaa → **24 kameraa** alle 10 km
säteellä; 16 asemalla on useampi kamera (yhteensä 78 valittavaa kuvaa).


### CSP (pakollinen muutos)

Kuvat **eivät lataudu ilman CSP-muutosta**: `infra/lib/csp.ts` sai
`CAMERA_ORIGINS`-listan (`https://tie.digitraffic.fi`,
`https://weathercam.digitraffic.fi`), joka lisätään sekä `img-src`:hen (kuvat
`<img>`-elementillä) että `connect-src`:hen (asemaluettelo `fetch`:llä).
Regressiosuoja: `infra/test/csp.test.ts` (+3 testiä).

Uusi vuorovaikutus, joka on hyvä muistaa: **sama origin tarvitaan molemmissa
direktiiveissä**, jos kuvat vaihdetaan myöhemmin `fetch`-pohjaisiksi (esim.
selaimen välimuisti kuville) — siksi lista on molemmissa.

### Testit ja verifiointi

| Kohde | Tulos |
|---|---|
| `apps/web/src/lib/cameras.test.ts` (uusi, 14 testiä) | etäisyyslaskenta, säteensuodatus (myös rajatapaus säde 0), `inCollection`-suodatus, nimen muotoilu, etäisyyden katkaisu (9,96 km → `9,9 km`, ei "10,0 km"), puutteellinen geometria, puuttuva vastaus |
| `infra/test/csp.test.ts` (11) | kameraoriginit `img-src`:ssä ja `connect-src`:ssä, `cameraOrigins`-asetus |
| Koko sarja | **150 testiä** ✅ |
| `npm run build:web` | ✅ (tsc --noEmit + vite) |
| ESLint | ✅ |
| Headless Chrome (dev, deployn jälkeen) | 24 korttia, 24 kuvaa, **0 CSP-rikkomusta**, ei hakuvirhettä; kuvakaappaus 1440×900: 3 saraketta × 2 riviä = 6 kuvaa näkyvissä |
| **Prod (tampere247.online) 23.9.2026** | 24 korttia, 24 kuvaa, **0 CSP-rikkomusta**; CSP-otsikossa `tie.digitraffic.fi` + `weathercam.digitraffic.fi` sekä `img-src`:ssä että `connect-src`:ssä |
| Brändi (dev + prod DOM) | **0** osumaa `Tampere360`, 4 osumaa `Tampere 247` |
| Prettier | Omat uudet/muokatut tiedostot ✅ (`styles.css`, `csp.ts`, `cameras.ts`, `CamerasPage.tsx`). `lib/format.ts` ja `README.md` ovat ennestään §16:n korjauslistalla — niitä ei muotoiltu tässä yhteydessä, jotta diff pysyy aiheessa |

Deploy tehtiin molempiin ympäristöihin, koska muotoilu muutti asset-hashit:
`tampere360-dev-frontend` ja `tampere360-prod-frontend` (135 s + 138 s).

### Bugikorjaus 23.9.2026: kameran kellonaika näytti 3 tuntia väärältä

**Oire:** kamerakortissa luki esim. `kuva 23.9.2026 klo 18.26`, kun kuvat oli
otettu klo 21.47. Kaksi eri juurisyytä, jotka korjattiin molemmat:

**(1) Aikavyöhyke ei ollut kiinnitetty.** `lib/format.ts`:n `formatTime` käytti
`toLocaleString('fi-FI', …)` ilman `timeZone`-asetusta → aika muotoiltiin
**selaimen** aikavyöhykkeellä. UTC-selain näytti 18.26, kun Suomessa oli 21.26
(mittaus: headless-Chrome). Korjaus: `HELSINKI_TIME_ZONE = 'Europe/Helsinki'`
vakiona ja `timeZone`-asetus käytössä → kellonajat ovat aina Suomen ajassa
(sisältää kesä-/talviajan automaattisesti).

**(2) Väärä kenttä: asemaluettelon `dataUpdatedTime` ei ole kuvan aika.**
Mitattuna 23.9.2026 klo 21.50 (18:50Z):

| Lähde | Aika |
|---|---|
| Asemaluettelon asemakohtainen `dataUpdatedTime` | 15:25–15:28Z (≈3,5 h vanha **metatietoa**) |
| Asemaluettelon oma `dataUpdatedTime` (koko lista) | 16:33Z |
| Kuvatiedoston `Last-Modified` (`weathercam…jpg`) | **18:47Z** ✅ |

Eli asemaluettelo on metatietoa, ja sen aikakenttä voi olla tunteja vanha.
Kuvan todellinen kuvausaika saadaan `presets[].measuredTime`-kentästä
rajapinnasta `GET /stations/data` (kaikki asemat **yhdellä kutsulla**, ~19 kt
gzipattuna; CORS `*`, `Digitraffic-User`-otsikko sallittu, preflight 204).

| Osa | Muutos |
|---|---|
| `api/cameras.ts` | uusi `CAMERA_DATA_URL`, tyypit ja `fetchCameraData()`; dokumentoitu miksi asemaluettelon aika ei kelpaa |
| `api/queries.ts` | `useCameraStations` → `useCameraData`: kaksi kutsua `Promise.all`:lla (`stations` + `data`) |
| `lib/cameras.ts` | `TrafficCameraPreset.measuredTime`; `toTrafficCameras(stations, data, …)` yhdistää ajat asemakohtaisesti; uusi `cameraImageTime(camera, preset)` = `measuredTime` → aseman aika → `null`. Asemaluettelon `dataUpdatedTime`a **ei enää käytetä** kuvan aikana |
| `components/CameraCard.tsx` | aika valitusta presetistä (`cameraImageTime`), ei aseman metatiedosta |
| `pages/CamerasPage.tsx` | `toTrafficCameras(data?.stations, data?.data)`; selite: "aika on kuvan kuvausaika Suomen ajassa" |
| `lib/format.ts` | `timeZone: HELSINKI_TIME_ZONE` |

**Testit:** `cameras.test.ts` (19, +5: `measuredTime`-yhdistäminen,
regressiosuoja ettei listan aikaa käytetä, puuttuva asema, `cameraImageTime`
fallback) ja `format.test.ts` (22, +2: aikavyöhykeregressio, joka asettaa
`process.env.TZ = 'UTC'` — ilman kiinnitystä testi epäonnistuu myös Suomessa
ajettaessa). Koko sarja **157 testiä** ✅, ESLint ✅, `npm run build:web` ✅,
Prettier ✅ (omat tiedostot).

### Ei muutoksia putkeen eikä API:in

Kamerat eivät tule tapahtumamallin kautta eivätkä näy `/v1/situations`- tai
`/v1/map`-vastauksissa — ne ovat oma, suoraan lähteestä luettava näkymä.
Tämä on tarkoituksellinen rajaus (aiemmin "liikennekamerat" oli vaiheessa 2,
ks. §9); jos kamerat halutaan myöhemmin kartalle tilanteiden yhteyteen, se
tehdään omana muutoksenaan.

Footerin attribuutio päivitettiin: *"Liikennetiedotteet ja kelikamerat:
Fintraffic / Digitraffic"*.


## 26. Taustakuva vain Nyt-sivulle (23.9.2026)

**Muutos:** Nyt-sivun himmennetty taustakuva (`background.jpg`) poistettiin
neljältä kategoriasivulta — **Liikenne, Säävaroitukset, Poliisi,
Joukkoliikenteen poikkeustilanteet**. Ne käyttävät nyt samaa tasaista tummaa
taustaa kuin Lähteiden tila ja Liikennekamerat.

**Mistä taustakuva tuli:** kategoriasivut renderöitiin samalla
`CategoryPage`-komponentilla, joka sisälsi Nyt-sivun taustakuvan
(`<div className="now-backdrop" />`). Taustakuva ei siis ollut CSS-luokan
sivutuote vaan komponentin oma elementti — siksi korjaus on yhden rivin
poisto.

| Osa | Muutos |
|---|---|
| `pages/CategoryPage.tsx` | `now-backdrop`-elementti ja sen kommentti poistettu; JSDoc kertoo, että taustana on tasainen `--bg` |
| `styles.css` | `.now-backdrop`-kommentti tarkentaa, että luokka on käytössä **vain** Nyt-sivulla |

`now-backdrop` **jätettiin Nyt-sivulle** (`pages/NowPage.tsx`), koska se on
siellä tarkoituksellinen — samoin `.page`-luokalla ei ole omaa taustaa, vaan
se perii `body { background: var(--bg) }` eli `#0b1220`.

**Verifiointi** (dev + prod, headless Chrome, 1440×900):

| Sivu | `now-backdrop` DOM:issa | Taustan väri |
|---|---|---|
| `/` (Nyt) | 1 ✅ (säilyy) | valokuva |
| `/liikenne` | 0 ✅ | rgb(11, 18, 32) |
| `/saa` | 0 ✅ | rgb(11, 18, 32) |
| `/poliisi` | 0 ✅ | rgb(11, 18, 32) |
| `/joukkoliikenne` | 0 ✅ | rgb(11, 18, 32) |
| `/lahteet` (vertailu) | 0 | rgb(11, 18, 32) |
| `/kamerat` | 0 | rgb(11, 18, 32) |

Eli kaikkien kategoriasivujen pikseliväri on **täsmälleen sama** kuin
Lähteiden tila -sivulla. Testit 157 ✅, ESLint ✅, `npm run build:web` ✅.
Deploy: `tampere360-dev-frontend` (118 s) ja `tampere360-prod-frontend`
(140 s).


## 27. Nysse kartalla — joukkoliikenteen ajoneuvot reaaliajassa (26.9.2026)

Uusi välilehti `/nysse-kartta` näyttää Tampereen seudun joukkoliikenteen
ajoneuvot kartalla 5 sekunnin välein päivittyvänä: ratikat ja bussit, ikoni
kertoo linjanumeron ja kiertyy kulkusuuntaan. Uusi API-reitti
`GET /v1/vehicles?mode=TRAM|BUS`. Tarkempi kuvaus:
[`docs/architecture/vehicle-positions.md`](../docs/architecture/vehicle-positions.md).

### Miksi Waltti SIRI eikä GTFS-RT

| Vaihtoehto | Miksi ei / miksi |
|---|---|
| **Waltti SIRI VehicleMonitoring** (valittu) | antaa `LineRef` ("80"), `DestinationName` ("Keskustori") ja `Delay` suoraan → ei arvailua |
| Nysse GTFS-RT VehiclePositions | antaa vain dokumentoimattoman `routeId`-numeron (esim. `806990`) eikä määränpäätä → linjanumero ja määränpää olisi pitänyt ratkaista erikseen |

Päätepiste `https://data.waltti.fi/tampere/api/sirirealtime/v1.3/ws`
(POST, Basic-auth). **Avain luetaan SSM:stä** `/tampere360/{env}/sources/nysse/api-key`
— sama parametri kuin Nysse-adapteri lukee, **ei uutta salaisuutta**. Avain ei
koskaan päädy selaimeen, vaikka Waltti sallisikin CORSin.

### Arkkitehtuuri: oma Lambda, ei `apps/api`

```
Selain (5 s pollaus)
   → GET /v1/vehicles?mode=TRAM|BUS
   → apps/vehicle-positions (oma Lambda, varattu concurrency 2)
   → muistivälimuisti (5 s TTL + in-flight de-dupe + 60 s stale)
   → Waltti SIRI VM (1,83 Mt XML) → GeoJSON FeatureCollection
```

| Ratkaisu | Perustelu |
|---|---|
| Oma Lambda ja oma varattu concurrency (2) | karttasivu pollaa 5 s, tilanteet 30–60 s → karttaliikenne ei syö query-Lambdan kustannuskatkoa (`QUERY_RESERVED_CONCURRENCY = 5`) |
| Ei DynamoDB-käyttöä | ajoneuvot ovat hetkellistä dataa; ei lukukapasiteettia eikä uusia tauluja |
| 5 s TTL + in-flight de-dupe | N selainta aiheuttaa enintään yhden Waltti-kutsun per TTL per lämmin kontti |
| 60 s "stale"-varafallback | Walttin hetkellinen virhe ei tyhjennä karttaa; vastaus merkitään `stale: true` |
| `VEHICLE_MAX_AGE_MINUTES = 5` | liian vanhat havainnot pudotetaan, jotta kartalle ei jää "haamuja" |
| `mode`-parametri | `TRAM`/`BUS` suodattaa; **virheellinen arvo → HTTP 400** (`INVALID_MODE`), jotta kirjoitusvirhe ei näy hiljaisena tyhjänä karttana; ilman parametria palautetaan kaikki |
| Kevyt `<OnwardCalls>`-poisto | pysäkkikohtaiset tiedot leikataan ennen XML-jäsennystä: **415 ms → 36 ms** per pyyntö |
| Ratikan tunnistus | `OperatorRef === '56920'` (verifioitu: 19 ajoneuvoa, linjat 1 ja 3); varalla `TRAM_LINES = ['1','3']` |

Vastaus on GeoJSON (`type: FeatureCollection`) + metatiedot `counts`, `count`,
`generatedAt` (lähteen aika), `fetchedAt` (hakuhetki), `stale`.

### Frontend

| Osa | Ratkaisu |
|---|---|
| Karttakerrokset | **yksi GeoJSON-lähde + kaksi symbolikerrosta**: runko (`vehicles-body`) ja linjanumerotunniste (`vehicles-tag`) |
| Ikonit | piirretään ajonaikaisesti `canvas`ille 2× pikselitiheydellä → **linjanumero on poltettu ikoniin**, joten MapLibren glyph-lähdettä (fontteja) eikä CSP-muutosta tarvita |
| Klikkaus | symbolikerroksen popup: linja, määränpää, viive (min myöhässä / etuajassa) ja havainnon ikä |
| Pollaus | 5 s (`refetchIntervalInBackground: false`) — taustavälilehti ei pollaa |
| Suodatin | chipit "Ratikat (n)" / "Bussit (n)" |
| CSP | **ei uusia origineja**: OSM-tiilet olivat jo `img-src`/`connect-src`issä ja API on oma origin |

### Testit

`apps/vehicle-positions/src/*.test.ts` (36): `siri.ts` (jäsennys, puuttuvat
kentät, `<OnwardCalls>`-poisto, viive), `geojson.ts` (GeoJSON-muunnos,
koordinaattien validointi, ikäraja, `counts`), `cache.ts` (TTL, in-flight
de-dupe, stale-fallback, virhetilanne), `params.ts` (`mode`-käsittely) ja
`mode.ts` (ratikan tunnistus). Koko sarja **211 testiä** ✅, ESLint ✅,
`npm run build:web` ✅.



### 27.1 Sivuvaikutuksena löytynyt ja korjattu vika: MapLibren työntekijä ei tullut buildiin

**Oire:** kartalla näkyivät OSM-tiilet mutta **ei yhtään ajoneuvoikonia**, ja
konsolissa:

```
Loading Worker from "…/assets/maplibre-gl-worker.mjs" was blocked because of a
disallowed MIME type ("text/html").
Failed to load module script: The server responded with a non-JavaScript MIME
type of "text/html".
```

**Miksi vika on hiljainen:** rasteritiilet latautuvat ja näkyvät ilman
työntekijää, mutta **GeoJSON-lähde jää jumiin** eikä symbolikerroksia koskaan
piirretä. Kartta näyttää siis "melkein oikealta" — vain ikonit puuttuvat.

**Juurisyy:** MapLibre GL JS v6 laskee työntekijän URL:in **ajonaikaisesti**
`import.meta.url`:sta:

```js
new URL(`./${t}`, import.meta.url)   // t = 'maplibre-gl-worker.mjs'
```

Vite ei tunnista tällaista dynaamisesti rakennettua polkua, joten
`maplibre-gl-worker.mjs` (ja sen tuonti `maplibre-gl-shared.mjs`) **ei
koskaan päätynyt `dist`-kansioon**. Selain pyysi `/assets/maplibre-gl-worker.mjs`,
mutta CloudFrontin SPA-uudelleenohjaus palautti `index.html`:n (HTTP 200,
`text/html`) → moduulin lataus hylättiin MIME-tyypin vuoksi.

**Korjaus:** `apps/web/src/lib/maplibre-worker.ts` (uusi) bundlaa työntekijän
Viten omalla `?worker&url`-kyselyllä ja asettaa URL:in MapLibrelle
eksplisiittisesti:

```ts
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
setWorkerUrl(workerUrl);
```

`MapView.tsx` importtaa moduulin sivutuontona, joten URL on asetettu ennen kuin
yhtään karttaa luodaan. Buildi tuottaa nyt
`dist/assets/maplibre-gl-worker-<hash>.js` (508 kB, sisältää jaetun moduulin).

**Miksi `?worker&url` eikä `?url`:** pelkkä `?url` kopioi tiedoston sellaisenaan,
jolloin sen `import './maplibre-gl-shared.mjs'` osoittaisi olemattomaan polkuun.
`?worker&url` bundlaa työntekijän *ja sen riippuvuudet* yhdeksi tiedostoksi sekä
devissä että buildissa.

**Miksi tämä ei näkynyt aiemmin:** tilannekartalla (`/kartta`) käytetään
DOM-pohjaisia `Marker`-olioita, jotka eivät tarvitse työntekijää. Vika tuli
esiin vasta, kun kartalle lisättiin GeoJSON-lähde ja symbolikerrokset.

**Diagnoosimenetelmä (toistettavissa):**

1. Headless Chrome `--remote-debugging-port` + CDP-client: `Log.enable`,
   `Network.enable`, `Page.reload` → konsolin virherivi paljastaa
   **epäonnistuvan moduulin URL:in** (pelkkä `--dump-dom` ei sitä näytä).
2. Väliaikainen `window.__map`-paljastus ja tarkistus:
   `map.getSource('vehicles')._isUpdatingWorker === true` ja
   `_pendingWorkerUpdate` sisältää datan → työntekijä ei kuittaa päivitystä;
   `map.loaded() === false` mutta `areTilesLoaded() === true`.
3. Korjauksen jälkeen: `map.loaded() === true`,
   `querySourceFeatures('vehicles') = 37` (tiilikohtainen monistus) ja
   `queryRenderedFeatures(['vehicles-body']) = 15` → ikonit piirretään.

**Sivukorjaus:** MapLibre loi oletusattribuution *lisäksi* oman kompaktin
attribuutiokontrollin → kartalla oli **kaksi attribuutiota päällekkäin**. Nyt
`attributionControl: false` + oma kompaktin kontrolli.

### 27.1.1 Sivuvaikutuksena löytynyt ja korjattu vika: ajoneuvon klikkaus ei avannut popupia

**Oire:** ikonit näkyivät, mutta niiden päällä kursori ei vaihtunut ja
klikkaus ei avannut popupia (`map.on('click', 'vehicles-body', …)` ei
laukennut koskaan).

**Juurisyy:** kuuntelijat rekisteröitiin omassa efektissään (`deps: []`),
joka luovutti heti, jos kerrosta ei vielä ollut olemassa:

```ts
const register = () => {
  if (!map.getLayer(VEHICLE_BODY_LAYER)) return;   // ← hiljainen luovutus
  map.on('click', VEHICLE_BODY_LAYER, onClick);
  …
};
```

Kerros luodaan *toisessa* efektissä (`[vehicles]`) vasta `load`-tapahtuman
jälkeen. Jos `register()` ajettiin hetkellä, jolloin `getLayer` palautti
`undefined`, kuuntelijoita ei koskaan rekisteröity — efekti kun ei enää
uudelleen ajanut. Virhe oli täysin hiljainen (ei konsolivirhettä).

**Todennus:** `map._delegatedListeners` oli tyhjä (`mouseenter`-avainta ei
ollut lainkaan), kun taas käsin rekisteröity testikuuntelija toimi samalla
kartalla → vika oli nimenomaan rekisteröinnissä, ei hit-testissä.
(`queryRenderedFeatures` palautti ikonin kohdalta 1 osuman ja
`querySourceFeatures('vehicles')` 26–29 featurea ✅.)

**Korjaus:** kuuntelijat rekisteröidään nyt **samassa efektissä, joka luo
kerroksen** (`setup()` → `ensureLayers()`, `applyData()`,
`registerListeners()`), ja `registerListeners()` on suojattu
`listenersRegisteredRef`-lipulla. Koska `setup` ajetaan sekä `load`-hetkellä
että jokaisella datapäivityksellä (5 s), rekisteröinti ei voi enää jäädä
väliin. Kuuntelijoita ei poisteta datapäivityksissä; kartan `remove()`
siivoaa ne komponentin purkautuessa.

**Verifiointi (paikallinen tuotantobuildi + headless Chrome, data päällä):**

| Tarkistus | Tulos |
|---|---|
| `_delegatedListeners` | `{ click: ['vehicles-body'], mouseenter: ['vehicles-body'], mouseleave: ['vehicles-body'] }` ✅ |
| Hover ikonin päällä | `canvas.style.cursor = 'pointer'` ✅ |
| Klikkaus (CDP-hiiritapahtuma) | popup: *"Ratikka 1 → Pyhällönpuisto A · 2 min myöhässä · Lähtö: Kaupin kampus A · Havaittu 10 s sitten"* ✅ |
| Konsoli | 0 virhettä ✅ |


**Verifiointi (dev, headless Chrome, ei selainlaajennuksia):** työntekijäpyyntö
`…maplibre-gl-worker.mjs?worker_file&type=module` → 200, `map.loaded() = true`,
15 renderöityä ajoneuvoikonia, **0 CSP-rikkomusta** ja 0 konsolin virhettä
(paitsi dev-ympäristön `favicon.ico` 404).

**Huomio selaimen konsolista:** `The page's settings blocked an inline script
(script-src-elem) … sandbox eval code` **ei tule sovelluksesta** — julkaistu
`index.html` sisältää vain ulkoisen moduuliskriptin eikä lainkaan
inline-skriptiä, joten viesti tulee selainlaajennuksesta. CSP
(`script-src 'self'`) estää sen tarkoituksellisesti, eikä samaa virhettä
esiinny headless Chromella.

### 27.2 Deploy

**Dev:** `tampere360-dev-frontend` (kahdesti: ensin työntekijäkorjaus §27.1,
sitten klikkikorjaus §27.1.1) sekä aiemmin `tampere360-dev-api` (uusi
`vehicle-positions`-Lambda, reitti ja SSM-lukuoikeus) ja
`tampere360-dev-monitoring`.

**Prod 27.9.2026:** ks. prod-osio tämän luvun lopussa.

Huomio deploysta: `cdk deploy` kannattaa ajaa `setsid nohup stdbuf -oL …`
-ta taustalla, jos istunto voi katketa — muuten deploy-prosessi voi kuolla
kesken (stack jää edelliseen tilaan eikä uusi build päädy S3:een).


**Verifiointi deploatusta dev-sivusta 26.9.2026 (headless Chrome, ei
laajennuksia):**

| Tarkistus | Tulos |
|---|---|
| `index.html` osoittaa | `assets/index-B1uOp0Ph.js` (klikkikorjauksen build) ✅ |
| Työntekijä | `assets/maplibre-gl-worker-CNLXcz58.js` → 200 `text/javascript` ✅ |
| Ratikkaikonit | 684 minttiä pikseliä (`#34d399`) = 11 ratikkaa ✅ (OSM-tiilissä 0 minttiä/sinistä → värit ovat varmasti omia) |
| Ikonien sijainti | projektio `map.project(lng,lat)` osui ikoniin 2 px tarkkuudella ✅ |
| Klikkaus ikoniin | **popup 6/6**: *"Ratikka 1 → Kaupin kampus B · ajassa · Lähtö: Pyhällönpuisto B · Havaittu 10 s sitten"* ✅ |
| Kursori hoverissa | `pointer` ✅ |
| CSP-rikkomukset | **0** ✅ |
| Konsolivirheet | 1 × `502` (`/v1/vehicles`) — Waltti vastasi itse HTTP 500; sovellus säilytti edellisen datan ja ikonit ✅ |

### 27.2.1 Prod-käyttöönotto (27.9.2026)

Koko §27 vietiin tuotantoon `npm run deploy:prod -- --require-approval never`
-komennolla (kahdeksan stackia, 208 s):

| Stack | Tulos |
|---|---|
| `tampere360-prod-frontend` | ✅ 41 s — uusi asset-versio + CloudFront-invalidointi (`/*`) |
| `tampere360-prod-api` | ✅ 57 s — `VehiclesFunction`, `/v1/vehicles`-reitti, SSM-lukuoikeus parametriin `tampere360/prod/sources/nysse/api-key` |
| `tampere360-prod-monitoring` | ✅ 11 s — `LambdaErrorsAlarm-vehicle-positions` + dashboardin uudet widgetit |
| foundation, data, eventing, ingestion, event-processing | ✅ *(no changes)* |

`cdk diff` ennen deployta näytti **vain lisäyksiä** (ei yhtään olemassa olevan
resurssin korvausta). IAM-muutokset olivat least privilege: `ssm:GetParameter`
täsmälleen yhteen parametriin ja Lambda-invoke vain reitille `/v1/vehicles`.

Waltti-avain oli jo valmiina prodin SSM:ssä, joten erillisiä salaisuussiirtoja ei
tarvittu — **se on kuitenkin aina tarkistettava erikseen per ympäristö**
(`/tampere360/{env}/sources/nysse/api-key`), koska CDK ei luo salaisuuksia.

**Prod-verifiointi** (27.9.2026):

| Tarkistus | Tulos |
|---|---|
| `https://tampere247.online/index.html` | `assets/index-Ch_Do5Yx.css` (sama build kuin devissä) ✅ |
| `GET /v1/vehicles?mode=TRAM` | 19 ratikkaa / 125 bussia, `stale: false` ✅ |
| `/v1/health/sources` | TAMPERE_TRAFFIC, FMI_CAP, NYSSE_ALERTS, POLICE_RSS = `OK` ✅ |
| Etusivu + `www.` | HTTP 200 ✅ |
| Popup selaimessa (`/nysse-kartta`, `/kartta`) | kontrastit 12,8:1 / 6,5:1 / 6,2:1, **0 konsolivirhettä** ✅ |
| CloudWatch-hälytykset | 0 hälytystä `ALARM`-tilassa (myös uusi `prod-errors-vehicle-positions` `OK`) ✅ |

### 27.3 Popupin luettavuus (27.9.2026)

**Ongelma (käyttäjän havainto):** ajoneuvon tietoikkuna oli lähes lukukelvoton —
vaalea teksti valkoisella taustalla.

**Juurisyy:** MapLibren oma CSS tekee popupista valkoisen laatikon
(`.maplibregl-popup-content { background: #fff }`) mutta **ei aseta tekstin
väriä**, joten teksti peri bodyn vaalean `--text`-värin (`#e8eefc`). Lisäksi
`styles.css`issä ei ollut yhtään popup-sääntöä (`grep -n popup` → ei osumia).

**Toinen, helposti ohitse menevä yksityiskohta:** MapLibren CSS tuodaan
`MapView.tsx`:ssä, joten Vite jakaa sen omaan tiedostoon (`MapView-*.css`) ja
selain lataa sen sovelluksen tyylitiedoston **jälkeen**. Samalla spesifisyydellä
MapLibren sääntö voitti oman sääntömme → tausta pysyi valkoisena myös
ensimmäisen korjauksen jälkeen (mitattu: `background: rgb(255,255,255)`).
Siksi omat säännöt on kirjoitettu MapLibren valitsimia tarkemmiksi
(`.maplibregl-popup .maplibregl-popup-content` = 0,2,0 ja nuolelle
`.maplibregl-popup.maplibregl-popup-anchor-top .maplibregl-popup-tip` =
0,3,0) — tumma teema toimii nyt latausjärjestyksestä riippumatta.

**Muutokset:**

| Osa | Muutos |
|---|---|
| `styles.css` (uusi osio "Kartan popupit") | tumma tausta `--surface-2`, teksti `--text`, reunus, varjo, max 280 px, nuoli ja sulkunappi teeman mukaan |
| `styles.css` | fokusrengas: MapLibre siirtää fokuksen sulkunappiin avatessa → UA-oletus (`outline: auto`, näkyi vahingossa syntyneenä laatikkona) pois, tilalle `--accent`-rengas vain `:focus-visible`illa |
| `components/MapView.tsx` | molemmat popupit (tilanne + ajoneuvo) rakennetaan `map-popup__*`-luokilla; tyylittely on CSS:ssä eikä HTML-merkkijonossa |
| `lib/vehicles.ts` | uusi `delayTone()` ja jaettu `delayMinutes()`: viiveen **väri ja teksti eivät voi eriytyä** (sama kynnys) |
| `lib/vehicles.test.ts` | +4 testiä (17) |

Hierarkia: otsikko (15 px, 600, `--text`) → viive (14 px, 700, sävyn mukaan
`--ok` / `--major` / `--accent` / `--text-muted`) → lisätiedot (13 px,
`--text-muted`, mutta arvo `--text`).

**Verifiointi** (paikallinen tuotantobuildi + headless Chrome, lasketut
kontrastit):

| Elementti | Väri / tausta | Kontrasti |
|---|---|---|
| Otsikko | `--text` / `--surface-2` | **12,8:1** ✅ |
| Viive ("ajassa") | `--ok` / `--surface-2` | 6,5:1 ✅ |
| Lisätietorivit | `--text-muted` / `--surface-2` | 6,2:1 ✅ |
| Tilanteen popup (`/kartta`) | `--text` / `--surface-2` | 12,8:1 ✅ |
| Sama prodissa (`tampere247.online`, 27.9.2026) | `--text` / `--surface-2` | 12,8:1 ✅ |

Kaikki ylittävät WCAG AA:n (4,5:1). Popupin tausta on nyt `rgb(27, 39, 64)`
(ennen `rgb(255, 255, 255)`), nuoli seuraa taustaväriä ja sulku-X:stä poistui
ylimääräinen oletusrengas. Sama korjaus koskee myös `/kartta`-sivun
tilannepopupia, jossa oli sama vika.


## 28. Nysse-pysäkit ja pysäkkimonitori (27.9.2026)

`/nysse-kartta`-näkymään lisättiin pysäkit ja pysäkin reaaliaikainen
lähtötaulu. Ominaisuus on tarkoituksella pieni: **ei** ajoneuvon seurantaa,
reitin seuraamista, suosikkeja eikä aikatauluhistoriaa.

| Osa | Ratkaisu |
|---|---|
| Pysäkkidata | Tampereen/Nyssen **GTFS-static** (`stops.txt`): `https://data.itsfactory.fi/journeys/files/gtfs/latest/gtfs_tampere.zip` (ITS Factory, CC BY 4.0) → **3 423 pysäkkiä** |
| Reaaliaikaiset lähdöt | **Waltti SIRI StopMonitoring** v1.3: `POST https://data.waltti.fi/tampere/api/sirirealtime/v1.3/ws` (Basic-auth, sama SSM-avain kuin ajoneuvoissa) |
| Uusi Lambda | `apps/stops` → `tampere360-{env}-stops`, reitit `GET /v1/stops` ja `GET /v1/stops/{stopId}/departures` |
| Välimuistit | staattinen rekisteri **6 h** (`GTFS_STOPS_CACHE_MS`), reaaliaikaiset lähdöt **15 s** (`STOP_CACHE_MS`) — erilliset instanssit, ei sekaantumisvaaraa |
| Kartta | yksi GeoJSON-lähde + MapLibren **oma klusterointi** (radius 50, `clusterMaxZoom: 14`): klusterit ympyröinä **tarkalla lukumäärällä**, yksittäiset pysäkit valkoisina ympyröinä |
| Sidepanel | `components/StopPanel.tsx`: pysäkin nimi + tunniste, lähtölista (linja · määränpää · aika), päivitysaika, loading/virhe/tyhjä-tilat |
| Tila | `showStops` (oletus **false**) ja `selectedStopId` (`null` = paneeli kiinni) |
| `/v1/vehicles` | **ei muutettu**: ajoneuvot ja pysäkkilähdöt ovat eri SIRI-palveluja eri välimuisteilla |

### SIRI StopMonitoring: `PreviewInterval` on pakollinen

SM-pyyntö samaan `/ws`-päätepisteeseen kuin VehicleMonitoring, mutta ilman
`<PreviewInterval>`-elementtiä Walttin yhdyskäytävä vastaa **HTTP 406** tyhjällä
vastauksella. Se näyttää siltä kuin SM-palvelua ei olisi — sama päätepiste
palvelee VM:ää ongelmitta. Toimiva muoto (Nyssen kehittäjäportaalin
dokumentaatiosta) on `siri-sm.ts`:ssä ja testattu `siri-sm.test.ts`issä:

```xml
<StopMonitoringRequest version="1.3">
  <PreviewInterval>PT60M00S</PreviewInterval>
  <MonitoringRef>0015</MonitoringRef>
</StopMonitoringRequest>
```

`MonitoringRef` on **GTFS `stop_id`** — juuri siksi pysäkkirekisterin lähde on
GTFS-static eikä mikään muu: SIRI ei anna pysäkkien luetteloa eikä
koordinaatteja, ja tunnisteavaruuden on osuttava yhteen. Enintään 100
`StopMonitoringRequest`-elementtiä per pyyntö.

### Tietoturva: tunniste upotetaan XML:ään

`stopId` tulee URL-polusta ja menee SIRI-pyyntöön, joten se validoidaan
(`^[A-Za-z0-9:_-]{1,24}$`) **ja** escapetaan. Virheellinen tunniste on `400
INVALID_STOP_ID` eikä "tyhjä pysäkkilista". Testit kattavat XML-injektioyritykset
(`0015</MonitoringRef>`).

### Pysäkit kartalla ja klusterien lukumäärä

Klusterien lukumääräteksti (`point_count_abbreviated`, esim. `1.2k`) vaatii
MapLibren **glyph-lähteen**: `glyphs: https://tiles.openfreemap.org/fonts/...`.
Tämä ei vaatinut CSP-muutosta, koska sama origin (`tiles.openfreemap.org`) on jo
`TILE_ORIGINS`-listalla sekä `img-src`:ssä että `connect-src`:ssä karttatiilien
takia. Pysäkkikerrokset lisätään ajoneuvokerrosten **alle** (`beforeId`), jotta
liikkuva kalusto pysyy luettavimpana. Klusterin klikkaus zoomaa klusterin
sisältöön (`getClusterExpansionZoom`) eikä avaa paneelia.

### Mitatut vasteajat ja kustannukset (dev 27.9.2026)

| Kutsu | Kylmä | Lämmin |
|---|---|---|
| `GET /v1/stops` (3 423 pysäkkiä, ~430 kt) | 3,0 s (sisältää 17 Mt:n GTFS-latauksen + purun) | **0,28 s** |
| `GET /v1/stops/0015/departures` | 0,9 s | ~0,3 s |

GTFS-paketin lataus ja purku mitattiin paikallisesti: **171 ms** (fflate
purkaa vain `stops.txt`:n, ei 100 Mt:n `stop_times.txt`ia). Lambdalla on oma
varattu concurrency **2**, erillään query-Lambdasta (5) ja ajoneuvoista (2).
Kontin muistiksi asetettiin 512 Mt (purku on raskaampi kuin pelkkä HTTP-haku).

### Testit ja verifiointi

`apps/stops/src/*.test.ts` (64 testiä): CSV-jäsennys, koordinaattien
uskottavuus, zip-purku, SM-pyynnön muoto, SM-vastauksen jäsennys, lähtölistan
järjestys ja armoväli, avainkohtainen välimuisti (TTL, in-flight de-dupe, stale,
peek, muistin raja), tunnisteen validointi. Lisäksi
`apps/web/src/lib/stops.test.ts` (12) ja `infra/test/config.test.ts` (+7).
Koko sarja **298 testiä** ✅, ESLint ✅, `npm run build:web` ✅.

Selainverifiointi (headless Chrome + CDP, **puhdas sivulataus** dev-julkaisusta;
karttaolio haettiin React-fiberistä, jotta tarkistukset tehtiin MapLibren omilla
API:lla `querySourceFeatures` / `queryRenderedFeatures` / `project`):

| Vaihe | Tulos |
|---|---|
| Oletus | `Näytä pysäkit` **ei** valittu, klustereita ruudulla 0 ✅ |
| Valinta päälle | `Näytä pysäkit (3423)`, `GET /v1/stops` **200** ✅ |
| Klusterointi zoomilla 11 | 223 featurea joista **216 klusteria**, 27 klusteriympyrää ruudulla ✅ |
| Klusterien lukumäärät | glyph-pyyntö `fonts/Noto%20Sans%20Bold/0-255.pbf` → **200**, ei CSP-rikkomusta ✅ |
| Klusterin klikkaus | zoom 11,00 → **12,20**, paneelia **ei** avattu ✅ |
| Zoom 16 | 21 featurea, **0 klusteria**, 4 yksittäistä pysäkkiä renderöity ✅ |
| Pysäkin klikkaus | `🚏 Lielahden koulu` / `Pysäkki 1409`, lähdöt `21 Ryydynpohja 7 min` + `≈ 36 min`, päivitysaika ✅ |
| Reaaliaikakysely | `GET /v1/stops/1409/departures` **200** (vain valitulle pysäkille) ✅ |
| Sulkeminen | sulkunappi (`elementFromPoint` = `stop-panel__close`) ja **Esc** toimivat, korostus poistui ✅ |
| Konsoli / CSP | **0 konsolivirhettä**, **0 CSP-rikkomusta** ✅ |
| Regressio `/kartta` | 3 tilannemarkerit, popup aukesi, kontrollit vasemmalla, 0 virhettä ✅ |

### Selainverifioinnissa löydetty ja korjattu vika: sulkunappi ei toiminut

**Oire:** pysäkin klikkaus avasi sidepanelin oikein, mutta sulkunapin klikkaus
ei sulkenut sitä — eikä konsolissa ollut mitään.

**Juurisyy:** MapLibren kontrollisäiliöllä (`.maplibregl-ctrl-top-right`) on
`z-index: 2`, ja `.stop-panel` oli `z-index: auto`. Kartan zoom-painikkeet
sijaitsivat oikeassa yläreunassa eli **täsmälleen paneelin sulkunapin päällä**,
ja koska kontrolli piirrettiin myöhemmin (z-index 2 > auto), klikkaus osui
zoom-painikkeeseen. Todennus:
`document.elementFromPoint(closeBtn.x, closeBtn.y).className` palautti
`"maplibregl-ctrl-group button"` eikä `"stop-panel__close"`.

**Korjaus:** karttakontrollit siirrettiin vasempaan reunaan
(`NavigationControl` → `top-left`, `AttributionControl` → `bottom-left`), koska
paneeli on oikealla. Päällekkäisyys poistui kokonaan — sama korjaus koskee
`/kartta`-sivua (kontrollien sijainti on yhteinen `MapView`-komponentissa).

**Miksi tämä oli helppo jäädä huomaamatta:** vika ei näy konsolissa eikä
screenshotissa, jos ei osaa etsiä sitä — `--dump-dom` näyttää paneelin ja
napit oikein. Vasta `elementFromPoint` tai oikea klikkaus paljastaa
päällekkäisyyden.

### Bugikorjaus 27.9.2026: "Lähtötietojen haku epäonnistui: API-virhe 502"

**Oire (käyttäjän havainto):** osalla pysäkeistä (esim. 6154) pysäkkimonitori
näytti virheen `Lähtötietojen haku epäonnistui: API-virhe 502
(/v1/stops/6154/departures)`. Yksittäinen curl samaan pysäkkiin onnistui →
vika oli satunnainen tai pysäkkikohtainen, ei reitityksessä.

**Mittaus — kaksi eri syytä, jotka Waltti esittää samannäköisinä:**

| Syy | Näyttö |
|---|---|
| Tilapäinen lähdevirhe | Lokissa 11:21–11:24 virheet pysäkeille 6155 (10), 1027 (8) ja 6154 (2); sama pysäkkikohtainen testi myöhemmin **200 kolmella peräkkäisellä yrityksellä** |
| Pysäkki puuttuu Walttin reaaliaikarekisteristä | **2 / 60** satunnaisotoksen pysäkkiä (6833, 6837) → 500 myös **24 h `PreviewInterval`illa**; samoin muotoon sopimattomat `9999`, `HQ:1` |

Rajattu pois: kuormitusrajausta ei ole (20 peräkkäistä + 10 rinnakkaista → 200);
`StopPointsDiscovery`-pysäkkirekisteriä ei ole käytettävissä (500). Waltti vastaa
500:lla runkonaan `Something went wrong` kummassakin tapauksessa, joten syy on
**opittava** virheistä.

**Korjaus:**

| Osa | Muutos |
|---|---|
| `apps/stops/src/retry.ts` (uusi) | `withRetry`: yksi uusinta 250 ms viiveellä **vain 5xx- ja verkkovirheille**; 4xx = oma pyyntö väärä, ei uusita. `SiriUpstreamError` (uusi `siri-sm.ts`:ssä) kuljettaa statuskoodin + rungon. |
| `apps/stops/src/coverage.ts` (uusi) | Toistuvista virheistä opittu "ei reaaliaikapeittoa" -merkintä: 3 peräkkäistä virhettä 2 min sisällä **ja jokin toinen pysäkki vastasi samana aikana** → 30 min merkintä, jonka ajan upstream-kutsua ei tehdä. Merkintä vanhenee itsestään (itsestään korjautuva). |
| `apps/stops/src/cache.ts` | Epäonnistumisen jäähdytys (`STOP_FAILURE_COOLDOWN_MS`, 30 s): epäonnistuneelle pysäkille ei soiteta uudelleen, jos tarjolla ei ole vanhaa arvoa. Ilman tätä jokainen 15 s pollaus lähetti **2 uutta yritystä** Walttiin loputtomiin. Vanha arvo ohittaa jäähdytyksen (tuoreus voittaa). |
| `apps/stops/src/handler.ts` | `realtimeCoverage` vastaukseen; peitoton pysäkki → **200** `realtimeCoverage: false`; ennen merkintää **503 + `Retry-After: 15`** (aiemmin 502). Myös välimuistin `stale`-varavastaus lasketaan epäonnistumiseksi. |
| `apps/web/src/api/client.ts` | `ApiError` kuljettaa HTTP-tilakoodin; `apiErrorStatus()` lukee sen (tekstivarmistus varalla) |
| `apps/web/src/lib/stops.ts` | `stopDeparturesNotice()` ja `NO_REALTIME_COVERAGE_TEXT` |
| `apps/web/src/components/StopPanel.tsx` | Ei enää teknistä `API-virhe 502` -tekstiä: rauhallinen huomautus + **"Yritä uudelleen"**-painike; `realtimeCoverage === false` → tiedoksi-tyylinen huomautus. Huomautus pidetään `useRef`issä uusinnan ajan, koska TanStack Query nollaa `error`in uuden yrityksen alkaessa (muuten huomautus välähti ja tilalle tuli virheellinen "Ei lähtöjä"). |

**Miksi 503 eikä 502 ja miksi "ei reaaliaikapeittoa" on 200:** teknisen
virhekoodin näyttäminen käyttäjälle ei auta häntä mitenkään; 5xx kertoo
selaimelle "yritä myöhemmin uudelleen" ja frontend kääntää sen luettavaksi
huomautukseksi. Peitoton pysäkki taas on **tieto** (pysäkki on olemassa, sen
lähtöjä ei vain ole tarjolla) eikä virhe — uusi yritys ei muuta tilannetta.

**Miksi peittomerkintä vaatii "toinen pysäkki vastasi" -ehdon:** ilman sitä
koko Walttin katkos merkitsisi kaikki pysäkit ilman peittoa. Ehto rajaa
merkinnän tilanteeseen, jossa yhdyskäytävä vastaa muille pysäkeille mutta ei
tälle. Tämä on tarkoituksella konservatiivinen: järjestelmä ei väitä pysäkin
peitosta mitään ilman positiivista näyttöä (§20:n periaate "epävarmaa ei
esitetä varmana"). Ilman merkintää pysäkki näyttää rauhallisen
"yritämme uudelleen automaattisesti" -huomautuksen, ja jäähdytys pitää
upstream-kutsut kurissa.

**Verifiointi 27.9.2026 (dev):** API — tavalliset pysäkit `200` +
`realtimeCoverage: true`; peitoton 6833 `503` (~0,5 s = 2 yritystä + tauko) →
15 s myöhemmin `503` **0,07 s:ssa** (jäähdytys) → merkinnän jälkeen `200
realtimeCoverage: false` 0,07 s:ssa. Selain (CDP, pysäkki 9433): "Lähtötietoja
ei juuri nyt saada…" + "Yritä uudelleen" → nappi lukee "Haetaan…" ja huomautus
pysyy näkyvissä (6/6 näytettä) → pysäkin merkinnän jälkeen tiedoksi-huomautus
"Waltti ei tarjoa tälle pysäkille lähtötietoja…"; verkkopyynnöt
`9433:503 ×4 → 9433:200 ×5`; DOM:issa **ei yhtään** `API-virhe`-osumaa;
0 CSP-rikkomusta. Peitottomia pysäkeitä satunnaisotoksissa **6 / 200 ≈ 3 %**
(6833, 6837, 6340, 6350, 6470, 9429, 9433).

**Testit:** `retry.test.ts` (11), `coverage.test.ts` (11), `cache.test.ts`
(+5 jäähdytyksestä), `apps/web/src/lib/stops.test.ts` (+5, sisältää
regressiosuojan sille, ettei `API-virhe 5xx` -teksti enää näy),
`apps/web/src/api/client.test.ts` (4). Koko sarja **334 testiä** ✅, ESLint ✅,
`npm run build:web` ✅. Deploy: `tampere360-dev-api` + `tampere360-dev-frontend`
(vain dev).

### Rajaukset ja tunnetut puutteet

- **Deploy vain deviin** (`tampere360-dev-api`, `-monitoring`, `-frontend`);
  prodia ei muutettu tässä vaiheessa.
- `GET /v1/stops` palautetaan pakkaamattomana (~430 kt), koska API Gatewayn
  HTTP API ei tue vastauksen pakkausta. CloudFront pakkaisi, jos API olisi
  jakelun takana; toistaiseksi vastaus on selaimen välimuistissa 30 min ja
  TanStack Queryn muistissa 24 h, joten se haetaan käytännössä kerran
  istunnossa.
- Lähdöt näytetään vain **valitulle** pysäkille; pysäkkikohtaista
  aikatauluhistoriaa, suosikkeja tai ajoneuvon seurantaa ei toteutettu.
- Peruutus-/poikkeustietoja (esim. peruttu vuoro) ei erikseen korosteta —
  SIRI antaa ne `DepartureStatus`-kentässä, jos niitä halutaan myöhemmin.

