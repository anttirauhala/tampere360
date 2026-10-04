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


## 29. Navigaatio ja Joukkoliikenne-paneeli (27.9.2026)

Välilehtijärjestys ja nimet muutettiin ja "Joukkoliikenne poikkeustilanteet"
-poistettiin päänavigaatiosta: sen sisältö näytetään nyt **Nysse-välilehden
sivupaneelissa** kompaktisti.

| Ennen | Nyt |
|---|---|
| Nyt, Kartta, **Nysse kartalla**, Liikenne, **Liikennekamerat**, Säävaroitukset, Poliisi, **Joukkoliikenne poikkeustilanteet**, Lähteiden tila | Nyt, Kartta, **Nysse**, **Kamerat**, **Poliisi**, **Liikenne**, Säävaroitukset, Lähteiden tila |

| Osa | Muutos |
|---|---|
| `components/Layout.tsx` | `NAV` vietiin järjestykseen ja nimettiin uudelleen; **`NAV` on nyt export** regressiosuojatestiä varten |
| `components/TransitDisruptionsPanel.tsx` (uusi) | Joukkoliikenteen poikkeustilanteet (`PUBLIC_TRANSPORT`) sivupaneelina: vakavuusmerkki, otsikko, aika ja **enintään 2 rivin** infoteksti (`-webkit-line-clamp: 2`). Enintään 8 kohdetta (`TRANSIT_PANEL_LIMIT`) ja linkki **"Kaikki poikkeukset →"** reitille `/joukkoliikenne` |
| `pages/NysseMapPage.tsx` | Otsikko `Nysse kartalla` → **`Nysse`**; kartta ja paneeli kaksi palstaa (`.nysse-layout`), lead-teksti ja lähdehuomautus päivitetty |
| `pages/CamerasPage.tsx` | Otsikko `Liikennekamerat` → **`Kamerat`**, jotta sivun otsikko vastaa välilehden nimeä (kuten muillakin sivuilla); kelikamerat mainitaan edelleen lead-tekstissä |
| `styles.css` | `.nysse-layout` (grid `minmax(0, 1fr) 320px`, ≤1100 px yhdeksi palstaksi) ja `.transit-panel*` — max-korkeus `60vh` kartan tahdissa, sisäinen vieritys listalle |
| kommentit | `MapView.tsx`, `CamerasPage.tsx`, `CategoryPage.tsx`, `infra/lib/csp.ts` viittaavat uusiin nimiin |

**Miksi `/joukkoliikenne`-reittiä ei poistettu:** täysi lista säilyy yhtenä
napsautuksena (`TransitDisruptionsPanel` → "Kaikki poikkeukset" sekä Nyt-sivun
koostekortti `CATEGORY_ROUTES.PUBLIC_TRANSPORT`). Sivupaneeli näyttää 8 uusinta,
joten pitkää listaa ei ole pakko mahduttaa pieneen paneeliin eikä
`CategoryPage`-näkymää tarvitse poistaa. Reitti ei enää näy navigaatiossa, ja
testi varmistaa sen (`layout.test.ts`).

**Huom:** sivupaneelin haku käyttää samaa `useSituations`-kyselyä kuin ennenkin
(`category=PUBLIC_TRANSPORT`, 30 s pollaus), joten uusia API-kutsuja tai
backend-muutoksia ei tarvittu — muutos on kokonaan frontendissä.

**Testit:** `apps/web/src/components/layout.test.ts` (4: järjestys ja nimet,
poistettu välilehti, uudelleennimetyt reitit, `end`-lippu vain etusivulla).
Koko sarja **338 testiä** ✅, ESLint ✅, `npm run build:web` ✅,
Prettier ✅ (omat tiedostot). Deploy vain deviin
(`tampere360-dev-frontend`); prodia ei muutettu.

**Selainverifiointi (dev, headless Chrome + CDP, 1440×900 ja 900×900):**

| Tarkistus | Tulos |
|---|---|
| Navigaatio | `Nyt \| Kartta \| Nysse \| Kamerat \| Poliisi \| Liikenne \| Säävaroitukset \| Lähteiden tila` ✅ |
| Poistettu välilehti | ei näy navigaatiossa ✅ (`/joukkoliikenne`-reitti toimii yhä) |
| `/nysse-kartta` | otsikko `Nysse`, paneeli `🚌 Joukkoliikenne poikkeustilanteet` (4 kohdetta: Tesoma F, Käräjätörmä, Tesoma A, Vihola) ✅ |
| Palstat leveällä | kartta x=20…1073, paneeli x=1085…1405 → **vieressä** ✅ |
| Palstat 900 px | paneeli kartan **alla** (y=924 > kartan alaosa 900) ✅ |
| "Kaikki poikkeukset →" | vie `/joukkoliikenne`, täysi lista 10 riviä ✅ |
| `/kamerat` | otsikko `Kamerat`, 24 kamerakorttia ✅ |
| Konsoli / CSP | 0 konsolivirhettä, 0 CSP-rikkomusta ✅ |

## 30. Liikennemäärät: mittausasemat (Digitraffic TMS) (27.9.2026)

Uusi välilehti `/liikennemaarat` näyttää Tampereen seudun **liikenteen
mittausasemien** (TMS/LAM) reaaliaikaisen nopeuden ja liikennemäärän sekä
asemakohtaisen historian (14 vrk volyymit, tuntijakauma, kuukauden
keskinopeudet). Uudet API-reitit `GET /v1/tms/stations` ja
`GET /v1/tms/stations/{tmsNumber}/history`. Tarkempi kuvaus:
[`docs/architecture/tms-stations.md`](../docs/architecture/tms-stations.md).

### Tausta: selvitettiin kolmannen osapuolen API, ei otettu käyttöön

Käyttäjän pyynnöstä tutkittiin `anttirauhala/traffic-stations`
(Digitraffic LAM -kerääjä: CDK + SQS + DynamoDB + API Gateway + React).
Se todettiin toimivaksi mutta ei sopivaksi tuotantoriippuvuudeksi:

| Havainto 27.9.2026 | Seuraus |
|---|---|
| `/api/traffic/station/{id}/daily` palauttaa aina 0 riviä (GSI:n partition key on koko ISO-aikaleima, kysely käyttää pelkkää päivää) | rajapinta on osin rikki |
| `hourly-average` toimii, mutta on heidän laskelmansa kuukauden jaksolta | sama tieto + enemmän saadaan virallisesta lähteestä |
| kerääjä ajaa kerran tunnissa, tallettaa vain `timeWindowStart`-arvoiset anturit | data on osajoukko |
| ei API-avainta eikä usage plania CDK-stackissa | ei tunnettua kiintiötä eikä SLA:ta |
| sivun teksti *"Kaikki oikeudet pidätetään"* | ristiriita oman CC BY -attribuutiomallin kanssa |

**Ratkaisu:** sama data suoraan Digitrafficilta (alkuperäinen lähde, CC BY 4.0).

### Tietolähteet ja kytkentä

| Rajapinta | Käyttö |
|---|---|
| `/api/tms/v1/stations` | 518 aseman metatiedot → suodatus Tampereen seutuun (lat 61,3–61,7 / lon 23,5–24,0 → 21 asemaa, joista **19 keruussa**) |
| `/api/tms/v1/stations/{id}` | kunnan nimi, `names.fi`, suuntien määränpäät ja **`freeFlowSpeed1/2`** (vapaan ajon nopeus) |
| `/api/tms/v1/stations/data` | **kaikkien asemien** reaaliaika yhdellä kutsulla (144 kt gzip / 3,4 Mt purettuna, 0,25 s) |
| `/api/tms/v1/history` | historia-CSV: `api=liikennemaara\|keskinopeus`, `tyyppi=h\|vrk\|kk`, `piste = tmsNumber` |

**Kytkentä, joka oli helppo erehtyä:** historiassa `piste` on aseman
**`tmsNumber`** (438), ei TMS-rajapintojen `id` (23438). Verifioitu 20/21
asemalla nimen perusteella.

**Aito esimerkkidata** (asema 438, 27.9.2026): vuorokausivolyymit
13.–26.9. välillä 36 768 → 39 904 ajoneuvoa; tuntijakauman vilkkain tunti 14
(3 527 ajoneuvoa); keskinopeudet suunnittain Lahti 65,1 km/h (rajoitus 70/70)
ja Rauma 68,0 km/h (60/60).

### Sujuvuusarvio on oma luokittelu

```
suhde = nopeus / vapaa ajon nopeus
  ≥ 0,75 → SUJUVAA · ≥ 0,50 → HIDASTUNUT · < 0,50 → RUUHKAUTUNUT
```

Kolme rajausta: (1) alle 60 kpl/h → `TUNTEMATON`, koska yöllinen yksittäinen
auto ei ole ruuhka; (2) puuttuva arvo on `TUNTEMATON`, ei nolla; (3) luokittelu
kerrotaan käyttäjälle omana arvionamme sekä merkissä että sivun alaviitteessä.

### Toteutuksen aikana havaitut ja korjatut viat

1. **Hidas lähde aikakatkaisi Lambdan:** sama historia-kutsu mitattiin 45 ms …
   **7 597 ms** (lähde muodostaa CSV:n pyynnössä). 10 s timeout petti ja
   käyttäjä näki 503:n (`TimeoutError` lokissa, `loadSpeed`). Korjaus:
   yrityskohtainen timeout **8 s** + **yksi uusintayritys** 400 ms tauolla
   (`apps/tms-stations/src/retry.ts`, sama malli kuin Waltti-uusinnassa §28).
2. **Yksi hidas osa kaatoi koko historian:** `Promise.all` → `allSettled`,
   epäonnistunut osa tyhjäksi ja `partial: true` → käyttäjä näkee kaksi muuta
   kuvaajaa ja huomautuksen.
3. **Kylmän Lambdan throttle näkyi käyttäjälle 503:na:** sivun avaus teki
   **neljä** rinnakkaista kutsua (1 tilannekuva + 3 historiaa) ja varattu
   concurrency oli 2 → API Gateway vastasi `{"message":"Service Unavailable"}`.
   Korjaus: selain tekee **yhden** historianhaun (`type=all`, rinnakkaisuus
   Lambdan sisällä) ja `TMS_RESERVED_CONCURRENCY` nostettiin **3**:een.
   Diagnoosimenetelmä: APIGW-muotoinen runko + 0,07 s vasteaika + lokissa
   onnistunut invokaatio ilman virheriviä = throttlaus, ei sovellusvirhe.
4. **Navigaatiotesti oli jäänyt jälkeen:** `layout.test.ts` odotti §29:n
   kahdeksaa välilehteä, mutta commit 808d50e oli lyhentänyt nimen
   ("Nysse kartalla") — 2 testiä punaisella ennen tätä työtä. Korjattu samalla
   ja lisätty uusi välilehti.

### Diagnostiikka, joka ratkaisi vian

Vika näytti ensin Lambdan verkko-ongelmalta, koska sama kutsu `curl`illa kesti
0,3 s. Eristävä mittaus tehtiin itsenäisellä Node-skriptillä, joka toisti
täsmälleen Lambdan pyynnöt (`/tmp/hist-node.mjs`):

| Ajo | Tulos |
|---|---|
| yksittäin, peräkkäin | `vrk` + `accept: text/csv` **7 597 ms**, `vrk` + `accept: application/json` 93 ms, `kk` 1 248 ms, `h` 1 017 ms |
| kolme rinnakkain | 45/77/94 ms (yhteensä 98 ms) |
| kolme rinnakkain ilman `accept`-otsikkoa | 45/62/64 ms (yhteensä 66 ms) |

Johtopäätös: **viive vaihtelee lähteellä**, ei meidän koodissamme, eikä
`accept`-otsikko tai rinnakkaisuus selitä sitä — siksi korjaus on uusintayritys
eikä esimerkiksi otsikon poisto. Vastaava varmistus Lambdan lokista:
`TimeoutError … at async loadSpeed … at async Promise.all (index 2)`, kun
`vrk` ja `h` olivat jo onnistuneet.


### Frontend

`/liikennemaarat`: 19 asemakorttia (otsikko `names.fi`, tienumero, kunta,
mittauksen ikä, molemmat suunnat, nopeus/vapaa nopeus/liikennemäärä,
sujuvuusmerkki) + valitun aseman historia (palkit ja keskinopeustaulukko).
Reaaliaika pollataan 60 s; historia haetaan vain valitulle asemalle
(`staleTime` 30 min). Kaikki muotoilu on `lib/tms.ts`:ssä (puuttuva arvo `—`,
palkit eivät koskaan keksi arvoa). **CSP ei muutu** — data tulee oman API:n
kautta.

### Testit ja verifiointi

| Kohde | Tulos |
|---|---|
| `apps/tms-stations/src/*.test.ts` | 88 (CSV-jäsennys, anturivalinta, sujuvuus, rajaus, metatiedot, parametrit, välimuisti, uusinta) |
| `apps/web/src/lib/tms.test.ts` | 17 |
| `infra/test/config.test.ts` | 9 uutta (TTL:ien suhteet, concurrency, timeoutit, uusinnan aikabudjetti) |
| Koko sarja | **452 testiä** ✅, ESLint ✅, Prettier ✅, `npm run build:web` ✅ |
| API (dev) | `/v1/tms/stations` → 19 asemaa, 0 ruuhkautunutta; `?type=all` → `partial: false`, 14 vrk + 24 h + 2 suuntaa (5,8 s kylmänä, 0,16 s lämpimänä); virheelliset parametrit → 400 (`INVALID_TYPE`, `INVALID_TMS_NUMBER`, `INVALID_DAYS`) |
| Selain (headless Chrome + CDP, 1440×900) | navigaatio sisältää `Liikennemäärät`, otsikko ja aktiivinen välilehti täsmäävät, **19 korttia** (35 × Sujuvaa, 3 × Ei tietoa suunnittain), työkalurivi `19 asemaa · 0 ruuhkautunutta · 1 ilman arviota · päivitetty … · päivittyy 60 s välein` ✅ |
| Historia selaimessa | kortin napsautus avaa paneelin: **3 kuvaajaa** (Vuorokausivolyymit 14 palkkia, Tuntijakauma 24 palkkia, Keskinopeudet suunnittain), yhteensä 38 palkkia + yhteenvedot (`Keskimäärin 17 103 ajoneuvoa vuorokaudessa · 14 päivää`) ja 2 nopeusriviä (Lahti 89,6 km/h / Tampere 86 km/h, rajoitus 100/100) ✅; toisen aseman historia avautuu samoin ✅; sulkeminen ✅; **0 konsolivirhettä, 0 CSP-rikkomusta** ✅ |

Deploy: `tampere360-dev-api`, `tampere360-dev-frontend` ja
`tampere360-dev-monitoring` (hälytys `errors-tms-stations`), yhteensä 8 stackia
ilman muutoksia muihin kuin edellä mainittuihin. **Prodia ei muutettu tässä
vaiheessa.**

### Rajaukset

Ei karttakerrosta (omat muutoksensa §27/§28 tapaan), ei tallennusta
DynamoDB:hen (ei omaa aikasarjaa), vain keruussa olevat asemat, kaksi suuntaa
(kaistakohtaista dataa ei näytetä), ei liikennevalo- eikä kaupungin omaa dataa.


## 31. SPA-deployn chunk-virhe "error loading dynamically imported module" (1.10.2026)

**Käyttäjän havainto:** *"frontendistä tulee välillä virhe eikä sivu lataudu,
erityisesti jos sivu on ollut kauan auki"*:

```
Uncaught TypeError: error loading dynamically imported module:
https://d36ic5wsx4b9yl.cloudfront.net/assets/NysseMapPage-DyiIPu-z.js
```

Virhe koski dev-jakelua, mutta sama rakenne oli myös prodissa
(`tampere247.online`) — kumpikin korjattiin.

### Juurisyy: kolme osaa, jotka yhdessä muodostavat vian

| # | Osa | Mittaus 1.10.2026 |
|---|---|---|
| 1 | Jokainen deploy tuottaa **uudet hash-nimet** ja `BucketDeployment` (`prune: true`) poistaa vanhat tiedostot + invalidoi CloudFrontin | bucketissa vain **12 tiedostoa** = yksi build; selaimen pyytämä `NysseMapPage-DyiIPu-z.js` oli edellisestä buildista |
| 2 | Puuttuva polku ei palauta 404:ää vaan **SPA-fallbackin**: `errorResponses` 403/404 → `/index.html`, siis **HTTP 200 + `content-type: text/html`** → selain hylkää moduulin | `curl -I /assets/NysseMapPage-DyiIPu-z.js` → `200 text/html`, `x-cache: Error from cloudfront` |
| 3 | Jakelun oletusbehavior oli `CACHING_OPTIMIZED`, eikä S3:ssa ole `Cache-Control`-otsaketta → `index.html` jäi CloudFrontin välimuistiin **oletus-TTL:llä (1 vrk)** | juuri `/` → `x-cache: Hit from cloudfront`, ei `cache-control`-otsaketta lainkaan |

Yhdessä: **kauan auki ollut välilehti** käytti muistissaan (ja CloudFrontissa)
vanhaa `index.html`:ää, jonka chunk-nimet oli jo poistettu → lazy-sivun avaus
kaatui. Virhe on viivästynyt ja hiljainen: se ei näy heti deployn jälkeen vaan
vasta kun käyttäjä avaa Kartta- tai Nysse-sivun vanhasta istunnosta.



### Korjaus 1: CloudFront — dokumentti aina tuore, assetit pitkään välimuistiin

`infra/lib/web-cache.ts` (uusi) + `infra/lib/frontend-stack.ts`:

| Polkukuvio | Cache policy | Cache-Control (selaimelle) |
|---|---|---|
| oletus (`/`, `/kartta`, SPA-fallback) | `CACHING_DISABLED` (`4135ea2d-…`) | `no-cache, no-store, max-age=0, must-revalidate` |
| `assets/*` | oma policy `tampere360-{env}-assets`, min/default/max = **31 536 000 s** | `public, max-age=31536000, immutable` |
| `config.json` | `CACHING_DISABLED` | kuten dokumentti |

**Sivuhavainto, joka olisi jäänyt helposti huomaamatta:** CloudFrontin managed
`CachingDisabled` **ei lähetä `Cache-Control`-otsaketta lainkaan** (todettu:
`config.json` on käyttänyt sitä alusta asti eikä otsaketta näy). Ilman
eksplisiittistä otsaketta **selain** voi käyttää heuristista välimuistia —
sama "vanha dokumentti + poistetut chunkit" -ongelma syntyisi siis selaimen
puolella. Siksi `Cache-Control` lisättiin CloudFrontin response headers
policyyn (`customHeadersBehavior`, `override: true`); AWS vahvistaa, että
`Cache-Control` on sallittu custom header ja vaikuttaa **vain** selaimelle,
ei CloudFrontin välimuistiin.

Koska dokumentille ja asseteille tarvitaan eri `Cache-Control`, stackissa on
nyt **kaksi** response headers policya (`…-security-headers` ja
`…-asset-headers`) samalla suojausotsakejoukolla. Suojausotsakkeet rakennetaan
`securityHeadersBehavior()`-funktiolla (uusi objekti per construct).

### Korjaus 2: frontend — yksi uudelleenlataus chunk-virheen jälkeen

| Osa | Tehtävä |
|---|---|
| `apps/web/src/lib/chunk-reload.ts` (uusi) | `recoverFromChunkError` (palautus **kerran**: URL-merkintä `?chunkRetry=1` + `localStorage`-aikaleima), `loadLazyModule` (uusintayritys → palautus → `ChunkLoadError`), `hardReload`, URL-apurit |
| `apps/web/src/lib/lazy-page.tsx` (uusi) | `lazyPage(load, label)` = `lazy()` + edellä mainittu logiikka; kaatumisen jälkeen renderöi `ChunkLoadFailure`-ilmoituksen (ja nollaa merkinnät onnistuneesta latauksesta) |
| `apps/web/src/components/ChunkLoadFailure.tsx` (uusi) | *"Sivun osaa ”Kartta” ei saatu ladattua…"* + **Lataa sivu uudelleen** -nappi (`role="alert"`) |
| `apps/web/src/App.tsx` | `lazy(...)` → `lazyPage(..., 'Kartta' / 'Nysse')` |
| `apps/web/src/main.tsx` | `vite:preloadError`-kuuntelija kattaa myös muut kuin `lazy()`-kääreen kautta kulkevat importit (esim. CSS) |

Vuokaavio: import kaatuu → **toinen yritys** (hetkellinen verkkohäiriö) → yhä
kaatuu → onko palautus jo yritetty (URL-merkintä **tai** tuore aikaleima)?
**ei** → merkitse + `window.location.replace(url + ?chunkRetry=1)` (lupaus jää
ratkeamatta, joten Suspense näyttää lataustilan eikä virhe välähdä) · **kyllä**
→ ilmoitus + nappi. Onnistunut lataus nollaa merkinnät (myös URL:sta), joten
seuraava deploy saa taas yhden automaattisen uudelleenlatauksen.

**Miksi merkintä on URL:ssa eikä pelkässä `localStorage`issa** (löydetty
selainverifioinnissa 1.10.2026): aikaleimaan nojautuva vartija petti kahdessa
tilanteessa — kun kello hyppii (selaimen virtuaaliaika) tai kun tallennus on
estetty (yksityinen tila), jolloin syntyi **2053 uudelleenlatauksen silmukka**.
URL-parametri säilyy dokumentin vaihdon yli eikä riipu kellosta eikä
tallennuksesta.

**Miksi reload eikä chunkin uudelleenhaku:** vanha dokumentti osoittaa aina
vanhoihin nimiin; vain uusi `index.html` sisältää nykyiset chunk-nimet.

**Sivutuote: `event.preventDefault()` kaatoi koko sivun.** Viten
preload-helper kääntää estetyn `vite:preloadError`-tapahtuman niin, että
dynaaminen import ratkeaa `undefined`illa (ei hylkää) → Reactin `lazy` lukee
`moduleObject.default` → `TypeError: … reading 'default'` → ilman error
boundarya **koko sivu jäi tyhjäksi** (`#root` tyhjä). Korjaus: käsittelijä ei
estä virhettä, ja `loadLazyModule` käsittelee tyhjän tuloksen
epäonnistumisena.

**Miksi `prune: true` pidetään:** vanhojen chunkkien säilytys kasvattaisi
bucketia rajatta (~7 Mt/deploy), ja elinkaarisääntö poistaisi hiljaisen kauden
aikana myös nykyisen buildin. Korjaukset 1 ja 2 riittävät (uusi kävijä saa
tuoreen dokumentin; avoin välilehti korjautuu automaattisesti).

### Testit

| Kohde | Tulos |
|---|---|
| `apps/web/src/lib/chunk-reload.test.ts` (uusi, **20**) | uusintayritys ennen palautusta; palautus **kerran**; URL-merkintä estää silmukan **myös ilman `localStorage`ia**; vartijan ikkuna, `clear()`, rikkoutunut arvo; `ChunkLoadError` kuljettaa nimen ja syyn; lupaus jää odottamaan; **tyhjä moduulitulos = epäonnistuminen** (Viten preload-helper) |
| `infra/test/frontend-cache.test.ts` (uusi, **5**) | oletusbehavior käyttää samaa no-store-policya kuin `config.json`; `assets/*` oma policy (min/default/max = 1 v, gzip+br); **Cache-Control-otsakkeet** dokumentille (`no-store`) ja asseteille (`immutable` + TTL); SPA-fallback 403/404 → 200 `/index.html` säilyy. Testi synteesoi `FrontendStack`in tilapäisellä build-hakemistolla (`webDistPath`-prop) — ei siis vaadi `npm run build:web`iä |
| Koko sarja | **477 testiä** ✅, ESLint ✅, `npm run build:web` ✅, Prettier ✅ (omat tiedostot) |

### Verifiointi

| Tarkistus | Tulos |
|---|---|
| `cdk synth tampere360-dev-frontend` | `DefaultCacheBehavior.CachePolicyId = 4135ea2d-…` (CachingDisabled, sama kuin `config.json`); `assets/*` → `Ref: WebAssetsCachePolicy…`; `CachePolicyConfig` `Min/Default/MaxTTL: 31536000`, gzip+br |
| Julkaistu `index.html` (dev + prod) | `cache-control: no-cache, no-store, max-age=0, must-revalidate`, `x-cache: Miss from cloudfront` (ei enää välimuistissa) |
| Julkaistu asset | `cache-control: public, max-age=31536000, immutable`, `content-type: text/javascript` |
| Puuttuva chunk | yhä `200 text/html` (SPA-fallback) — tarkoituksellista, frontend hoitaa sen uudelleenlatauksella |
| **Selainsimulaatio** (paikallinen tuotantobuildi, `NysseMapPage`-chunk poistettu, headless Chrome `--dump-dom` + palvelimen loki) | dokumenttilataukset **2** (`/nysse-kartta/` + `?chunkRetry=1`) = tasan yksi automaattinen uudelleenlataus; `?chunkRetry=1`-osoitteella vain **1** lataus; DOM:issa `role="alert"`-ilmoitus *”Sivun osaa ”Nysse” ei saatu ladattua…"* + Lataa-nappi; `window.onerror`/`unhandledrejection`-koetin: **0 virhettä**; `#root` renderöi sovellusrungon (ei tyhjää sivua) |
| Vertailu: vanha logiikka | pelkällä aikaleimalla **2053 reloadia** (silmukka); `preventDefault`illa `#root` jäi tyhjäksi virheeseen *reading 'default'* |
| Deploy | dev `tampere360-dev-frontend` ✅; prod `tampere247.online` ✅ |

### Dokumentaatio

`docs/architecture/spa-chunk-reload.md` (uusi): oire, juurisyy mittauksineen,
korjaus, regressiosuojat ja toistettavat verifiointikomennot.

### Rajaukset ja tunnetut puutteet

- Jos käyttäjän selaimessa on **ennen tätä korjausta** tallennettu vanha
  `index.html`, se voi olla voimassa heuristisen välimuistin ajan; korjauksen
  jälkeen uudet vastaukset eivät enää jää välimuistiin.
- Ilmoitus (`ChunkLoadFailure`) näytetään lazy-ladatuille sivuille (Kartta,
  Nysse). Muiden sivujen koodi on samassa `index-*.js`-tiedostossa, jonka
  latausvirheestä selain näyttää oman virhesivunsa — `vite:preloadError`
  kattaa silti CSS- ja modulepreload-virheet.
- `prune: false` (vanhojen chunkkien säilytys) on dokumentoitu vaihtoehto,
  jota **ei** otettu käyttöön; muutospiste on `frontend-stack.ts`in
  `BucketDeployment`.

tuoreen dokumentin; avoin välilehti korjautuu automaattisesti).


## 32. Tampereen nykyinen sää Nyt-sivulla (1.10.2026)

Nyt-sivun otsikkotasolle, **oikeaan laitaan**, lisättiin pieni sääkortti:
Tampereen nykyinen sää (lämpötila, tuuli, kosteus, havaintoaika). Data tulee
**FMI:n avoimesta WFS-rajapinnasta** (CC BY 4.0, ei API-avainta). Uusi API-reitti
`GET /v1/weather/current`. **Sää-välilehteä ei vielä lisätty** — Lambda on
rakennettu niin, että sama API palvelee myöhemmin kokonaista Sää-sivua.

### Arkkitehtuuri: oma Lambda, ei selainta suoraan

| Ratkaisu | Perustelu |
|---|---|
| Oma Lambda `apps/weather` (kuten §27/§28/§30) | sää ei tule DynamoDB:stä; oma varattu concurrency (2) erottaa reitin query- (5), ajoneuvo- (2), pysäkki- (2) ja mittausasema-Lambdasta (3) |
| Muistivälimuisti **5 min** + stale-fallback **30 min** | FMI:n WFS:llä on pyyntörajat (10 000/vrk, yhteensä 600 / 5 min); N selainta → 1 upstream-kutsu / TTL / lämmin kontti |
| **Ei** CSP-muutosta | data tulee oman API:n kautta; selain saa pienen JSONin eikä WaterML-XML:ää |
| **Ei** SSM/Secrets | FMI on avoin; ei API-avainta |

Vaihtoehto (ei valittu): selain hakisi suoraan FMI:ltä (CORS `*`) kuten
kelikamerat Digitrafficilta — mutta vastaus on WaterML 2.0 -XML:ää
(~28 kt / parametri), joten jäsennys kuuluu palvelimelle.

### FMI-rajapinta (verifioitu 1.10.2026)

```
GET https://opendata.fmi.fi/wfs
  ?service=WFS&version=2.0.0&request=getFeature
  &storedquery_id=fmi::observations::weather::timevaluepair
  &fmisid=101118
  &parameters=temperature,windspeedms,windgust,winddirection,humidity,pressure,precipitation1h,n_man
  &starttime=<now-3h>
```

- **Asema:** `101118` **Tampere-Pirkkala lentoasema** — FMI:n täydellisin
  havaintoasema Tampereen alueella. (Härmälä 101124 antaa lämpötilan mutta **ei
  tuulta**; Siilinkari 101311 tuulen mutta ei luotettavaa lämpöä.)
- **Muoto:** WaterML 2.0; jokainen parametri on oma `wfs:member`. Puuttuva arvo
  on `<wml2:value>NaN</wml2:value>` → tulkitaan `null`iksi (§20: ei arvausta).
- Valitaan **viimeisin ei-puuttuva** havainto per parametri; `observedAt` =
  viimeisin kelvollinen aikaleima.

### Tiedostot

| Osa | Muutos |
|---|---|
| `apps/weather/` (uusi) | `fmi.ts` (WFS-URL, haku, ExceptionReport→virhe), `parse.ts` (WaterML→arvot), `cache.ts`, `handler.ts`, `types.ts` + testit |
| `infra/lib/config.ts` | `WEATHER_*`-vakiot (TTL, stale, timeout, asema, concurrency 2) |
| `infra/lib/api-stack.ts` | `WeatherFunction` + `WEATHER_ROUTES = ['/v1/weather/current']` |
| `infra/bin/app.ts` | `weather` mukaan valvontalistaan (`LambdaErrorsAlarm-weather`) |
| `apps/web/src/api/weather.ts` | tyypit + `fetchCurrentWeather` + `WEATHER_POLL_MS = 300_000` |
| `apps/web/src/api/queries.ts` | `useCurrentWeather()` (pollaus 5 min, ei taustalla) |
| `apps/web/src/lib/weather.ts` | puhtaat muotoilijat + `describeCondition` |
| `apps/web/src/components/WeatherCard.tsx` | pieni kortti |
| `apps/web/src/pages/NowPage.tsx` | otsikkorivi `.now-head` (otsikko vasen, sää oikea) |
| `apps/web/src/styles.css` | `.now-head`, `.weather-card*` (≤760 px kortti koko leveydelle) |
| `apps/web/src/components/Layout.tsx` | footteri: "Säävaroitukset ja -havainnot: Ilmatieteen laitos" + huomautus kuvauksen tulkinnasta |

### UI ja rehellisyys

- Iso lämpötila + lyhyt kuvaus (emoji) + rivi `Tuuli … · Kosteus …` +
  `Havainto <aika> sitten · <asema>`.
- **Puuttuva arvo jää pois** — ei nollaa eikä arvausta. Hakuvirhe ei näytä
  virhettä eikä riko sivua: sääkortti vain jää pois (täydentävä tieto).
- Lyhyt kuvaus ("Puolipilvistä" tms.) on **oma tulkintamme** pilvisyydestä
  (`n_man` oktat) ja sateesta → kerrotaan kortin `title`-tekstissä ja footterissa
  (sama periaate kuin vakavuusluokittelu §24).

### Testit ja verifiointi

`apps/weather/src/*.test.ts` (24) — WaterML-jäsennys (viimeisin ei-NaN, NaN→null,
puuttuva parametri, asematiedot, tyhjä/rikkinäinen vastaus), WFS-URL ja
ExceptionReport, välimuisti (TTL, in-flight, stale) ja handler (404/200/503).
`apps/web/src/lib/weather.test.ts` (11) ja `infra/test/config.test.ts` (+5).
ESLint ✅, Prettier ✅ (omat tiedostot), `npm run build:web` ✅, `cdk synth` ✅
(route `GET /v1/weather/current`). Deploy vain deviin (`tampere360-dev-*`);
prodia ei muutettu.

### Myöhempi Sää-välilehti

API laajenee muotoon `GET /v1/weather/forecast` (FMI Harmonie). Reittinimitys:
nykyinen **`/saa` = Säävaroitukset** (CategoryPage WEATHER) — uusi sää-välilehti
vaatii reittipäätöksen (esim. varoitukset → `/saavaroitukset`, `/saa` = sää).
Tehdään omana muutoksenaan.

## 33. Saunat-välilehti (1.10.2026)

Uusi välilehti `/saunat` näyttää Tampereen seudun saunat listana. Jokaisesta
saunasta näytetään **nimi, osoite, lisätiedot, aukioloaika tänään sekä hinnat**.
Uusi API-reitti `GET /v1/saunas`. Tarkempi kuvaus:
[`docs/architecture/saunas.md`](../docs/architecture/saunas.md).

### Tietolähde: saunahaku.fi (selvitettiin SPA-bundlesta)

| Asia | Arvo |
|---|---|
| Rajapinta | `GET https://08aapg0u7e.execute-api.eu-west-1.amazonaws.com/prod/sauna-list` |
| Vastaus | 200 `application/json`, ei avainta, `access-control-allow-origin: *` |
| Sisältö | taulukko saunoja (~22, ~55 kt): `id, name, streetAddress, postalCode, city, openingHours[], phone, webPage, info, kiosk, restaurant, isNew` |
| Aukiolo | `openingHours[] = { weekday: 'MONDAY'…'SUNDAY', openingTime: 'HH:MM:SS', closingTime: 'HH:MM:SS', prices: [{ priceType, price }] }` |
| Hintaluokat | `ADULT, CHILD, STUDENT, PENSIONER, UNEMPLOYED, CONSRIPT` (CONSRIPT on lähteen kirjoitusasu) |

Rajapinnalla ei ole dokumentoitua skeemaa → normalisointi on **puolustava**:
tuntematon kenttätyyppi ei kaada vastausta, ja `id`/`name`-tön tietue pudotetaan.

### Arkkitehtuuri: oma Lambda (kuten §27–32)

```
Selain → GET /v1/saunas → apps/saunas-Lambda → muistivälimuisti → saunahaku.fi → JSON
```

| Ratkaisu | Perustelu |
|---|---|
| Oma Lambda `apps/saunas`, varattu concurrency **2** | Ei DynamoDB:tä, ei SSM-avainta; concurrency erottaa reitin query- (5) ja muiden reittien katosta |
| Välimuisti **15 min** + stale-fallback **7 vrk** | Aukioloajat/hinnat muuttuvat harvoin; N selainta → 1 upstream-kutsu / TTL |
| Yksi uusintayritys (5xx/verkko) | Sama malli kuin §28/§30; 4xx **ja** muotovirhe (status 0) eivät uusi |
| Upstream-timeout **4 s**, Lambdan timeout 10 s | 2 × 4 s + 0,3 s < 10 s (regressiotesti valvoo) |
| **Ei CSP-muutosta** | data tulee oman API:n kautta (sama origin) |

### Frontend

| Osa | Muutos |
|---|---|
| `apps/web/src/api/saunas.ts` | tyypit + `fetchSaunas()` + `SAUNAS_STALE_TIME_MS` (30 min) |
| `apps/web/src/api/queries.ts` | `useSaunas()` — ei automaattipollausta, `refetchOnWindowFocus: false` |
| `apps/web/src/lib/saunas.ts` | puhtaat funktiot: `todayWeekday` (Suomen aika), `todaysSessions`, `saunaTodayStatus`, `saunaPrices`, `priceTypeLabel`, `formatPrice`, `formatAddress`, `sortSaunas` |
| `apps/web/src/pages/SaunasPage.tsx` | otsikko "Saunat", työkalurivi + "Päivitä tiedot", korttiruudukko |
| `apps/web/src/components/SaunaCard.tsx` | nimi (+Uusi) · osoite · aukiolo tänään · hinnat · lisätiedot · puhelin · verkkosivu |
| `apps/web/src/App.tsx` | reitti `/saunat` |
| `apps/web/src/components/Layout.tsx` | NAV: `Saunat` ennen Lähteiden tilaa + footer "Saunatiedot: saunahaku.fi" |
| `apps/web/src/styles.css` | `.sauna-grid`, `.sauna-card*`, `.sauna-badge*` |

**Tulkinta vaatimuksesta:** *Aukiolo tänään* = päivän jaksot Suomen ajassa
(useampi jakso pilkulla, esim. `08.00–12.00, 16.00–22.00`); `Ei aukioloa tänään`,
jos muita päiviä on, ja `Ei aukioloaikoja`, jos lähde ei anna yhtään (remontti).
*Hinnat* = päivän jaksot deduplikoituna; jos tänään ei ole aukioloa, koko viikon
hinnat, jotta hinta ei katoa. Puuttuvaa ei arvata (§20).

### Testit ja verifiointi

`apps/saunas/src/*.test.ts` (23: jäsennys, normalisointi, välimuisti, uusinta),
`apps/web/src/lib/saunas.test.ts` (21, sis. aikavyöhykeregression) ja
`infra/test/config.test.ts` (+5, sis. uusinnan aikabudjetti). Koko sarja
**566 testiä** ✅, ESLint ✅, `npm run build:web` ✅, `cdk synth` ✅
(reitti `GET /v1/saunas`, hälytys `tampere360-dev-errors-saunas`).
Deploy vain deviin (`tampere360-dev-*`); prodia ei muutettu.

### Rajaukset

Ei karttakerrosta, ei tallennusta DynamoDB:hen eikä kaupunkikohtaista
suodatinta. Lista järjestetään **tänään auki olevat ensin**, kummankin ryhmän
sisällä nimen mukaan aakkosissa; aukiolo näytetään vihreällä ja "ei auki tänään"
punaisella. Saunahaku.fi:n lisenssiä ei ole vahvistettu, joten footer kertoo
vain lähteen nimen ("Saunatiedot: saunahaku.fi").

## 34. Veden lämpötila Saunat-sivulle (1.10.2026)

Saunat-sivun (`/saunat`) leadin alle lisättiin **Näsijärven pintaveden
lämpötila**. Uusi API-reitti `GET /v1/water/temperature`, oma Lambda
**5 minuutin välimuistilla**. Tarkempi kuvaus:
[`docs/architecture/saunas.md`](../docs/architecture/saunas.md#veden-lämpötila).

### Tietolähde: SYKE Hydrologiarajapinta

| Asia | Arvo |
|---|---|
| Rajapinta | `GET https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata` (OData 3.0) |
| Suure | `LampoPintavesi` = "Pintaveden lämpötila" (T, °C) |
| Asema | `Paikka_Id` **1694 — Näsijärvi, Kyrönlahti** (Ylöjärvi) |
| Lisenssi | **CC BY 4.0** (Suomen ympäristökeskus); ei API-avainta |
| Muoto | `Accept: application/json` — rajapinta hylkää `$format`-kyselyparametrin |

**Miksi juuri tämä asema:** Tampereen kunnan alueella ei ole yhtään pintaveden
lämpötilaa mittaavaa asemaa, joka raportoisi säännöllisesti — Näsijärvi on
Tampereen järvi ja Kyrönlahti sen pohjoispää. Havainto on päivittäinen
(30.9.2026: 11,9 °C). Kysely hakee uusimman rivin (`$orderby=Aika desc&$top=1`)
ja paikkatiedot samalla kutsulla (`$expand=Paikka`).

### Arkkitehtuuri: oma Lambda (kuten §27–33)

```
Selain → GET /v1/water/temperature → apps/water-temperature
          → muistivälimuisti (5 min) → SYKE Hydrologiarajapinta (OData) → JSON
```

| Ratkaisu | Perustelu |
|---|---|
| Oma Lambda `apps/water-temperature`, varattu concurrency **2** | Ei DynamoDB:tä, ei SSM-avainta; concurrency erottaa reitin muiden kattosta |
| **Välimuisti 5 min** (vaatimus) + stale-fallback **7 vrk** | Havainto on päivittäinen; N selainta → 1 SYKE-kutsu / 5 min / lämmin kontti |
| **Ei CSP-muutosta** | Data tulee oman API:n kautta — OData jää palvelimelle |
| **Ei** uusintayritystä | Sama malli kuin säässä (§32): yksi kutsu + 5 min välimuisti riittää |

### Frontend

| Osa | Muutos |
|---|---|
| `apps/web/src/api/water.ts` | tyypit + `fetchWaterTemperature()` + `WATER_TEMPERATURE_POLL_MS` (5 min) |
| `apps/web/src/api/queries.ts` | `useWaterTemperature()` (pollaus 5 min, ei taustalla) |
| `apps/web/src/lib/water.ts` | `formatWaterTemperature` (11,9 °C), `formatMeasurementDate` (30.9.2026) |
| `apps/web/src/pages/SaunasPage.tsx` | `.sauna-water`-rivi leadin alla; jää pois, jos arvoa ei saada |
| `apps/web/src/components/Layout.tsx` | footer: "Veden lämpötila: SYKE (CC BY 4.0)" |

Havainnon päivä luetaan **merkkijonosta** eikä `new Date`illa, jotta
aikavyöhykkeen tulkinta ei siirrä päivää yhdellä (§20).

### Testit ja verifiointi

`apps/water-temperature/src/*.test.ts` (14: URL, `parseDdmmss`, OData-jäsennys,
välimuisti), `apps/web/src/lib/water.test.ts` (4) ja
`infra/test/config.test.ts` (+5, sis. **5 min välimuistin** regressiosuoja).
Koko sarja **592 testiä** ✅, ESLint ✅, `npm run build:web` ✅, `cdk synth` ✅
(reitti `GET /v1/water/temperature`, hälytys
`tampere360-dev-errors-water-temperature`). Deploy vain deviin
(`tampere360-dev-*`); prodia ei muutettu.

## 35. Sama säävaroitus toistui monta kertaa — juurisyy ja upsert-korjaus (3.10.2026)

**Käyttäjän havainto:** Säävaroitukset-sivulla (`/saa`) näkyi monta riviä, jotka
olivat kuitenkin sama varoitus.

**Mittaus (dev, 3.10.2026):** `GET /v1/situations?category=WEATHER&status=ACTIVE`
palautti **12 riviä**, jotka kaikki olivat sama "Tuulivaroitus maa-alueille"
(eri julkaisuajat, osin eri `startsAt`). FMI:n RSS-syötteessä oli 9 voimassa
olevaa varoitusta, joista **täsmälleen yksi** osui Pirkanmaalle → sivulla olisi
pitänyt näkyä **1 rivi**.

### Juurisyy (kolme osaa)

1. **FMI lähettää saman varoituksen CAP-viestisarjana** (alkuperäinen `Alert` +
   toistuvat `Update`-viestit ~1–5 min välein). Jokaisella viestillä on **uusi
   `<identifier>`**, mutta tunnisteen **viimeinen '.'-osuus pysyy samana** koko
   varoituksen ajan — sama häntä toistuu myös `<references>`-ketjussa
   (verifioitu: 14–22 referenssitunnistetta jakoi hännän).
2. **Adapteri käytti koko identifieriä `sourceId`:nä** →
   `canonicalKey = FMI_CAP:<koko identifier>` ja
   `processingKey = FMI_CAP:<identifier>:<contentHash>` **muuttuivat joka
   päivityksellä** (myös sisältö muuttui: `sent`, probabiliteetti 30 %→60 %,
   `onset` 22:00→21:00).
3. **Prosessori loi aina uuden `situationId`-ULIDin** `PutCommand`illa → jokainen
   FMI-päivitys synnytti **uuden Situation-rivin**.

Sama rakenne oli jättänyt duplikaatteja myös muille lähteille: dev-taulussa oli
**34 ylimääräistä riviä** (TRAFFIC 30, NYSSE 4), koska myös Digitraffic/Nysse
lähettävät päivityksiä samalla `canonicalKey`lla.

### Korjaus

| Osa | Muutos |
|---|---|
| `apps/ingest-fmi/src/cap-parser.ts` | uusi `warningIdentity(identifier)` = tunnisteen **vakaa häntä** (vain `urn:oid:`-muotoiset; muut sellaisenaan) |
| `apps/ingest-fmi/src/handler.ts` | `sourceId = warningIdentity(cancelTargetId(parsed))` → `canonicalKey`/`processingKey` pysyvät vakaina koko elinkaaren ajan. Koko identifier säilyy raakadatassa (`raw.identifier`) ja S3:ssa |
| `apps/situation-processor/src/situation.ts` (uusi) | `deriveSituationId(canonicalKey)` = `sha256(canonicalKey)[0..26]` (deterministinen, URL-turvallinen hex → **ei uutta GSI:tä**, kiertää §20:n GSI-rajoituksen) ja `buildSituationUpsert(event, now, epoch)` → `UpdateCommand`-parametrit |
| `apps/situation-processor/src/handler.ts` | `PutCommand` + uusi ULID → `UpdateCommand` deterministisellä id:llä. `SourceEvents`-idempotenssi (`attribute_not_exists(processingKey)`) säilyy: identtinen uudelleentoimitus ohitetaan, aidot päivitykset **päivittävät samaa riviä** |

**Ensimmäinen havainto säilyy:** `createdAt` ja `firstSeenAt` asetetaan
`if_not_exists`-ehdolla, joten päivitys ei nollaa rivin luontia eikä tapahtuman
ensihavaintoa. Terminaalille asetetaan `expiresAt`-TTL, aktiiviselta se
`REMOVE`taan. `municipality`/`geohash` ovat sparse-GSI:iden avaimia: asetetaan
vain jos arvo on, muuten poistetaan.

**Sivuhyöty:** §22:n tunnettu rajoitus ("peruutus luo uuden rivin samalla
canonicalKeylla, vanha suljetaan siivouksella") poistuu — peruutus päivittää nyt
saman rivin `CANCELLED`-tilaan.

### Datan siivous (vain dev)

Vanhat rivit säilyttivät vanhan avaimen eivätkä korjaantuisi itsestään. Tehtiin
yksinkertainen migraatio: `scan` → jokaiselle `canonicalKey`lle jätettiin
**uusin** rivi (järjestys `updatedAt → firstSeenAt → createdAt`) ja se
uudelleenavaimistettiin `deriveSituationId`-tunnisteeseen; muut rivit poistettiin.

| Vaihe | Tulos |
|---|---|
| Vanhan FMI-muodon rivit (`FMI_CAP:urn:oid:…`) | 13 kpl poistettu (12 ACTIVE-duplikaattia + 1 ENDED) |
| Koko taulun uudelleenavaimistus | **puts 103, deletes 137, errors 0** |

> Prod-dataa **ei** muutettu. Sama migraatio toistetaan prodissa, kun muutos
> viedään tuotantoon.

### Verifiointi (dev)

| Tarkistus | Tulos |
|---|---|
| Säävaroitukset API | **1 rivi** (oli 12) — "Tuulivaroitus maa-alueille" ✅ |
| Taulun eheys | 104 riviä, 104 uniikkia `canonicalKey`ta, **0 duplikaattia**, 0 ei-determinististä id:tä ✅ |
| Adapterin toisto (sama sisältö) | ei uutta riviä — `SourceEvents`-idempotenssi ohittaa ✅ |
| **Päivityspolku (selftest)** | sama `canonicalKey`, eri `processingKey` + muuttunut `title`/`startsAt` → **sama `situationId`**, sisältö päivittyi, **`firstSeenAt` säilyi** ✅ (selftest-data poistettiin ajon jälkeen) |
| Muut kategoriat API:ssa | TRAFFIC 3, POLICE 38, PUBLIC_TRANSPORT 10; kaikki uniikkeja ✅ |
| Lähteet | TAMPERE_TRAFFIC, FMI_CAP, NYSSE_ALERTS, POLICE_RSS = `OK` ✅ |

### Testit ja dokumentaatio

`apps/ingest-fmi/src/cap-parser.test.ts` (+5: hännän poiminta, Alert vs Update
→ sama identiteetti, eri varoitukset → eri, ei-`urn:oid`, tyhjä) ja
`apps/situation-processor/src/situation.test.ts` (uusi, 13: determinismi,
`if_not_exists`, lajitteluajan putoaminen, TTL SET/REMOVE, sparse municipality).
Koko sarja **610 testiä** ✅, ESLint ✅, tyyppitarkistus ✅, `npm run build` ✅,
Prettier ✅ (uudet tiedostot; olemassa olevat `ingest-fmi/handler.ts`,
`cap-parser.test.ts` ja `situation-processor/handler.ts` olivat jo ennestään
§16:n korjauslistalla, joten niitä ei muotoiltu diffin säilyttämiseksi).

**Deploy vain deviin:** `tampere360-dev-ingestion` ja
`tampere360-dev-event-processing` (kaksi Lambda-koodimuutosta, 88,9 s).
`cdk diff` näytti vain `FmiCapAdapterFunction`- ja
`SituationProcessorFunction`-koodimuutokset — ei muita resursseja.
**Prodia ei muutettu, eikä muutoksia committoitu.**

### Rajaukset

- Vain dev. Prod toistetaan samana muutoksena (`npm run deploy:prod` +
  migraatio prod-taululle), kun dev on vahvistettu.
- `situationId` vaihtuu ULID:sta hashiksi — sitä käytetään vain läpinäkymättömänä
  avaimena (detail-reitti, React-avain, kartan property), ei järjestys- tai
  ULID-oletuksia (tarkistettu).
- `situation-expiry`-logiikka säilyy ennallaan; sivusisar-sulku on nyt FMI:llä
  harmitonta (peruutus päivittää saman rivin).

## 36. Nyt-sivun aikamuotoilu: "Alkaa/Alkoi" ja viikonpäivä (3.10.2026)

Nyt-sivun koostekorttien ajankohtaan kaksi muutosta:

1. **"Alkaa" tulevaisuudessa.** Jos tapahtuman oma alkuaika (`startsAt`) on
   tulevaisuudessa, näytetään **"Alkaa"** eikä "Alkoi". Säävaroituksen alkuaika
   on usein tulevaisuudessa, joten "Alkoi" oli harhaanjohtava.
2. **Viikonpäivä eteen.** Nyt-sivun korteilla ajankohdan edessä näytetään
   viikonpäivälyhenne **pienellä alkukirjaimella** (esim. `la 3.10.2026 klo 07.00`,
   `ti`, `ma`). Pieni alkukirjain vastaa fi-FI:n lyhyttä viikonpäivämuotoa.

| Osa | Muutos |
|---|---|
| `apps/web/src/lib/format.ts` | uusi `TimeFormatOptions { weekday?: boolean }`; `formatTime(iso, options)` lisää `weekday: 'short'`; `formatCompactTime(times, options)` valitsee `Alkaa`/`Alkoi` apurilla `isFuture` |
| `apps/web/src/components/SummaryCard.tsx` | Nyt-sivun koostekortti kutsuu `formatCompactTime(item, { weekday: true })` |

**Rajaus:** viikonpäivä näytetään **vain Nyt-sivun koostekorteilla**
(`SummaryCard`). Kategoria-/tyyppisivut (`CategoryPage`) ja joukkoliikenteen
sivupaneeli näyttävät edelleen ajankohdan ilman viikonpäivää — mutta saavat
"Alkaa/Alkoi"-logiikan, koska se on jaetussa `formatCompactTime`-funktiossa.
Muut `formatTime`-kutsujat (kamerat, TMS, saunat, lähteet) säilyvät ennallaan
(viikonpäivä ei ole oletus).

**Testit:** `apps/web/src/lib/format.test.ts` +8 (formatTime weekday + oletus,
`formatCompactTime` tyhjä/Alkaa/Alkoi/Julkaistu/weekday/tuleva+weekday) → 30.
Koko sarja **618 testiä** ✅, ESLint ✅, `npm run build:web` ✅, Prettier ✅
(muokatut tiedostot; `lib/format.ts` oli jo ennestään §16:n korjauslistalla,
joten sitä ei muotoiltu diffin säilyttämiseksi).

**Verifiointi (dev, headless Chrome):** Nyt-sivun DOM renderöi mm.
`Alkaa ti 6.10.2026 klo 00.00` (tuleva säävaroitus), `Julkaistu pe 2.10.2026
klo 18.41` ja `Alkoi ma 1.6.2026 klo 07.00` — viikonpäivä pienellä ja oikea
muoto tulevalle ajalle ✅. Julkaistu bundle sisältää `` `Alkaa`:`Alkoi` `` ja
`weekday?{weekday:`short`}`.

## 37. Saunat-sivun lähdelinkki saunahaku.fi (3.10.2026)

Saunat-sivulla lähde mainittiin kolmessa paikassa pelkkänä tekstinä. Ne
muutettiin klikattaviksi linkeiksi, jotka avaavat **https://saunahaku.fi**
uuteen välilehteen.

| Osa | Muutos |
|---|---|
| `apps/web/src/lib/saunas.ts` | uusi vakio `SAUNA_SOURCE_URL = 'https://saunahaku.fi'` — yksi paikka, jota lead, alahuomautus ja footteri käyttävät |
| `apps/web/src/pages/SaunasPage.tsx` | lead `…lisätiedot (saunahaku.fi ↗)` ja alahuomautus `Tiedot: saunahaku.fi.` linkeiksi (`sourceLink`-apurilla) |
| `apps/web/src/components/Layout.tsx` | footterin `Saunatiedot: saunahaku.fi.` linkiksi |
| `apps/web/src/styles.css` | `.page__lead-link` = accent-väri + alleviivaus (WCAG 1.4.1: linkki ei erotu pelkällä värillä) |

**Miksi `sourceLink` eikä pelkkä `href`:** sama apuri kuin korttien
lähdelinkeissä (§23) — se hyväksyy vain http(s)-osoitteet, joten
`javascript:`- ja `data:`-osoitteet eivät koskaan päädy linkiksi (§14).
Kaikki kolme linkkiä avataan `target="_blank" rel="noopener noreferrer"`;
leadin `↗` on sovelluksen vakiomerkintä ulkoiselle linkille.

**Sanamuodot säilyivät:** vain maininta muuttui linkiksi (sulut ja lauseet
ennallaan). Ei API-, infra- eikä CSP-muutosta — ulkoinen `<a>` ei aiheuta
selainpyyntöä.

**Testit:** `apps/web/src/lib/saunas.test.ts` +2 (vakion https-muoto ja
`sourceLink`-tulos: `href` `https://saunahaku.fi/`, label `saunahaku.fi`) →
saunas-testit 26 ✅. Koko sarja ✅, ESLint ✅, Prettier ✅,
`npm run build:web` ✅.

**Verifiointi 3.10.2026 (dev, `d36ic5wsx4b9yl.cloudfront.net`, headless
Chrome `--dump-dom`):** julkaistu `index.html` osoittaa omaan buildiin
(`assets/index-DJfesDdp.js`), CSS sisältää `.page__lead-link`in, ja DOM:issa
on **täsmälleen 3** saunahaku-linkkiä:

| Paikka | DOM |
|---|---|
| Lead | `<a class="page__lead-link" href="https://saunahaku.fi/" target="_blank" rel="noopener noreferrer">saunahaku.fi ↗</a>` |
| Alahuomautus | `Tiedot: <a href="https://saunahaku.fi/" target="_blank" rel="noopener noreferrer">saunahaku.fi</a>.` |
| Footteri | `Saunatiedot: <a href="https://saunahaku.fi" target="_blank" rel="noopener noreferrer">saunahaku.fi</a>.` |

Sivu renderöi 22 saunakorttia ja veden lämpötilan (12,5 °C) ✅; sivun
konsolissa ei virheitä eikä CSP-rikkomuksia.

Lisäksi **CDP-klikkauskoe** (headless Chrome, `Input.dispatchMouseEvent`, koska
vastaava koe paljasti aiemmin §28:ssa peittoon jääneen sulkunapin): linkin
keskipisteessä `document.elementFromPoint` osuu linkkiin (ei peittoa), laskettu
tyyli on `rgb(77, 163, 255)` (= `--accent`) + `underline`, ja klikkaus avasi
**uuden välilehden** osoitteeseen `https://saunahaku.fi/` ✅. Lead-teksti
renderöityy muodossa
`Tampereen seudun saunat — aukiolo tänään, hinnat ja lisätiedot (saunahaku.fi ↗).`

**Deploy:** dev `tampere360-dev-frontend` (75,4 s) ja **prod**
`tampere360-prod-frontend` (`npm run deploy:prod` → `cdk deploy --all
-c env=prod -c wafEnabled=false --region eu-north-1`, 84,8 s). `cdk diff --all`
näytti ennen deployta **vain** frontendin uuden asset-versioinnin (muut stackit
"no differences"), joten prodissa ei muuttunut mikään muu.

**Prod-verifiointi 3.10.2026 (`tampere247.online` + `www.`):** julkaistu
`index.html` osoittaa samaan buildiin (`assets/index-DJfesDdp.js`), DOM:issa on
**3** saunahaku-linkkiä (lead, alahuomautus, footteri), 22 saunakorttia ja veden
lämpötila; CDP-klikkauskoe avasi uuden välilehden `https://saunahaku.fi/` ✅,
0 konsolivirhettä.

**Huomio taustaprosessista:** ennen tätä työtä käynnissä ollut aiempi prod-deploy
(`tampere360-prod-*`, alkanut klo 16.38) oli synsannut assetinsa ennen tämän
muutoksen buildia, joten se vei prodiin vielä vanhan bundlen. Tässä työssä tehty
erillinen prod-deploy korjasi tilanteen (ks. yllä).



## 38. Kapean näytön osiovalitsin navigaatiossa (3.10.2026)

**Käyttäjän havainto:** *"kun sovellus avataan mobiilissa, menu vie liikaa tilaa:
valinnat ovat alekkain. Muuta: kun ollaan kapealla näytöllä, osio valitaan
dropdown-tyylisellä valinnalla eikä buttonilla."*

### Oire ja mittaus

Päänavigaatiossa oli 7 `NavLink`-painiketta (`.nav`, `flex-wrap: wrap`), jotka
rivittyivät kapealla näytöllä neljälle riville. Mitattu dev-buildista
(headless Chrome, 390×844):

| | Otsikon korkeus 390 px |
|---|---|
| Ennen (painikkeet) | **184 px** |
| Jälkeen (valitsin) | **121 px** |

→ **63 px (34 %) vähemmän**, ja sisällölle jää vastaava määrä enemmän tilaa
ensimmäisellä ruudulla.

### Ratkaisu: natiivi `<select>` + CSS-breakpoint

| Osa | Muutos |
|---|---|
| `apps/web/src/components/Layout.tsx` | `<nav>`-elementtiin painikkeiden lisäksi `<label class="nav__select">` + `<span class="nav__select-text">Osio</span>` + natiivi `<select class="nav__select-input">`; `useLocation` + `useNavigate` ja `onChange` → `navigate(to)` |
| `apps/web/src/styles.css` | `.nav__select` on oletuksena `display: none`; `@media (max-width: 480px)` piilottaa painikkeet (`.nav > .nav__link`) ja näyttää valitsimen (`display: flex`), ja asettaa `.nav { width: 100% }` |
| uusi `activeNavPath(pathname)` + `NAV_SELECT_PLACEHOLDER` | Valitsimen arvo: mikä `NAV`-kohde "omistaa" nykyisen polun; tyhjä merkkijono = ei mikään |
| `apps/web/src/components/layout.test.ts` | +5 testiä `activeNavPath`ille |

**Miksi natiivi `<select>` eikä oma pudotusvalikko:** mobiilissa avautuu
käyttöjärjestelmän oma valitsin (isot kosketuskohteet, tuttu vuorovaikutus),
näppäimistö ja ruudunlukija toimivat ilman lisätyötä, eikä uutta komponenttia,
tilaa (avoin/kiinni) eikä ulkoaklikkauksen käsittelyä tarvita. Ulkoasua **ei**
riisuta (`appearance` säilyy), joten nuoli ja tumma teema (`color-scheme: dark`)
tulevat ilmaiseksi.

**Miksi CSS-mediaquery eikä `matchMedia`:** repossa ei ole yhtään JS-pohjaista
mediaqueryä — kaikki responsiivisuus on CSS:ssä. Valitsimen breakpoint on
**480 px** (ks. tarkennus luvun lopussa): sitä kapeammalla painikkeet eivät
enää mahdu järkevästi, mutta kapea työpöytäikkuna ja tabletti pitävät
painikkeet.

**Miksi vain toinen näkyy kerrallaan:** piilotus tehdään `display: none`illä,
joka poistaa elementin myös saavutettavuuspuusta → ruudunlukija ei lue
navigaatiokohteita kahteen kertaan eikä piilotettuihin linkkeihin voi tabata.
Valitsimessa on `aria-label="Valitse osio"` ja näkyvä "Osio"-etiketti
(`<label>` kääre), joten kentällä on nimensä.

### Reunatapaus: sivut, jotka eivät ole päänavigaatiossa

`/liikenne`, `/saa`, `/poliisi` ja `/joukkoliikenne` ovat olemassa olevia
reittejä (`App.tsx`), mutta **eivät** `NAV`-listassa — ne avautuvat Nyt-sivun
koostekorteista ja joukkoliikenteen sivupaneelista. Ilman käsittelyä valitsin
näyttäisi niillä virheellisesti "Etusivua". Siksi `activeNavPath` palauttaa
näillä poluilla `NAV_SELECT_PLACEHOLDER`in ja valitsimeen lisätään **vain
silloin** `<option value="" disabled>Valitse osio…</option>`. Valinta ei siis
koskaan näytä väärää osiota, ja käyttäjä näkee yhdellä silmäyksellä, ettei sivu
ole päänavigaatiossa.

### Mittaukset (headless Chrome + CDP, paikallinen tuotantobuildi)

Emulointi asetetaan **navigoinnin jälkeen** — ennen navigointia asetettu
`Emulation.setDeviceMetricsOverride` ei päde uuteen dokumenttiin, mikä näkyi
aluksi ristiriitaisina tuloksina (mittaus kertoi aina edellisen ajon leveyden).
Siksi jokainen mittaus tarkistaa myös `window.innerWidth`in ja
`matchMedia('(max-width: 480px)')`-tuloksen.

Lopullinen raja (480 px) mitattiin yhdellä sivulatauksella, jossa viewport
vaihdettiin lennossa (`Emulation.setDeviceMetricsOverride` + 0,6 s odotus):

| Leveys | `mq480` | Näkyvät painikkeet | Valitsin | Otsikon korkeus |
|---|---|---|---|---|
| 390 px | `true` | 0 | `flex` | **121 px** |
| 480 px | `true` | 0 | `flex` | **121 px** |
| 481 px | `false` | 7 | `none` | 147 px |
| 600 px | `false` | 7 | `none` | 147 px |
| 768 px | `false` | 7 | `none` | 147 px |
| 900 px | `false` | 7 | `none` | 110 px |
| 1440 px | `false` | 7 | `none` | 65 px |

Eli raja on tarkalleen **≤ 480 px**, eikä työpöytänäkymä (1440 px) muutu
millään tavalla. Välillä 481–~880 px painikkeet vievät 3 riviä (147 px), mikä
on käyttäjän nimenomainen valinta: valitsin halutaan vain puhelinlevyisille
näytöille.

Toiminnallinen verifiointi samalla menetelmällä:

| Tarkistus | Tulos |
|---|---|
| 390 px `/` | 0 painiketta näkyvissä, valitsin `display: flex`, arvo `/` → "Etusivu" ✅ |
| Valitsimen vaihto → `/saunat` | `location.pathname` vaihtui, valitsimen arvo `/saunat`, aktiivinen `NavLink` "Saunat", `aria-current="page"` säilyi ✅ |
| `/liikenne` | valitsimen arvo `''` ja teksti "Valitse osio…" (disabled), 8 optiota (7 + paikanvaraaja), 0 painiketta ✅ |
| 1440 px `/` | 7 painiketta näkyvissä, valitsin `display: none`, otsikko 65 px (ennallaan) ✅ |
| Optiot | `/ | Etusivu`, `/kartta | Tapahtumat kartalla`, `/nysse-kartta | Nysse kartalla`, `/kamerat | Kamerat`, `/liikennemaarat | Liikennemäärät`, `/saunat | Saunat`, `/lahteet | Lähteiden tila` — sama järjestys ja nimet kuin painikkeissa ✅ |
| Konsoli | ei React- eikä CSP-virheitä; ainoat virheet ovat paikallisen preview'n `/v1/...` 404:t (config.json puuttuu lokaalisti → API-osoite on suhteellinen) ✅ |


### Testit

`apps/web/src/components/layout.test.ts` (+5, uusi `describe('activeNavPath')`):

| Testi | Suojaa |
|---|---|
| "tunnistaa jokaisen navigaatiokohdan omaksi polukseen" | kaikki 7 `NAV`-polkua palautuvat sellaisenaan |
| "ei sekoita /liikenne- ja /liikennemaarat-reittejä keskenään" | `/liikenne` → paikanvaraaja, `/liikennemaarat` → itsensä (etuliitesekoittuminen) |
| "palauttaa paikanvaraajan, kun polku ei ole päänavigaatiossa" | `/liikenne`, `/saa`, `/poliisi`, `/joukkoliikenne`, `/tuntematon` |
| "tunnistaa alipolut ja päätösvinon vain ei-tarkoille kohteille" | `/kartta/123` ja `/kartta/` → `/kartta`; etusivu on tarkka (`end`) |
| "paikanvaraaja ei osu mihinkään navigaatiokohtaan" | `NAV_SELECT_PLACEHOLDER` ei voi osua vahingossa |

Koska vitest ajetaan `environment: 'node'`issa ilman jsdomia, itse `<select>`in
renderöintiä ei testata yksikkötestillä — siksi logiikka on eristetty puhtaaseen
funktioon ja varsinainen näkyvyys on verifioitu selaimessa (yllä).

| Tarkistus | Tulos |
|---|---|
| `npx vitest run apps/web/src/components/layout.test.ts` | **9 testiä** ✅ (4 ennestään + 5 uutta) |
| `npx eslint apps/web/src` | ✅ |
| `npx prettier --check` (muokatut tiedostot) | ✅ |
| `npm run build:web` | ✅ (`tsc --noEmit` + vite) |

### Rajaukset ja tunnetut puutteet

- **Julkaistu deviin ja prodiin 3.10.2026** (ks. tarkennus ja prod-luku luvun
  lopusta).
- Breakpoint on **480 px** (ks. tarkennus luvun lopussa) — kapea työpöytäikkuna
  ja tabletti pitävät painikkeet.
- Valitsin sisältää vain päänavigaation kohteet, ei kategorioiden omia sivuja
  (`/liikenne`, `/saa`, `/poliisi`, `/joukkoliikenne`) — ks. reunatapaus yllä.
- Bränditekstin pienentäminen mobiilissa (esim. `small`-rivin piilotus) toisi
  vielä ~16 px lisää; ei tehty tässä.
- Ei muutoksia reititykseen, API:in, CSP:hen eikä infraan — muutos on kokonaan
  `apps/web`:ssä.
- **Committoitu ja pushaattu** (`4e7e867`) — ks. luvun lopun prod-luku.



### Julkaisu (vain dev)

`npx cdk deploy tampere360-dev-frontend --require-approval never` (127 s).
Deploy vaihtoi vain frontendin assetteja; muut stackit eivät ole riippuvaisia
tästä muutoksesta. **Prodia ei muutettu tässä vaiheessa** (ks. luvun lopun
prod-luku, jossa muutos vietiin myös tuotantoon).

Julkaistu build on täsmälleen sama kuin paikallinen:
`index-BEoGmt0b.js` + `index-Dr3Mtx3L.css`. CSP-otsake (`default-src 'self'`,
`script-src 'self'`, `connect-src` API + tiilet) **ei vaatinut muutosta** —
ulkoinen `<select>` ei aiheuta uusia origineja.

**Julkaistun dev-sivuston verifiointi** (headless Chrome + CDP,
`https://d36ic5wsx4b9yl.cloudfront.net`):

| Tarkistus | Tulos |
|---|---|
| 390 px `/` | `innerWidth 390`, `mediaMatches true`, otsikko **121 px** (painikkeilla 184 px), näkyviä painikkeita **0**, valitsin `display: flex`, arvo `/` → "Etusivu", 7 optiota ✅ |
| Valitsimen vaihto | → `/saunat`: `location.pathname` vaihtui, valitsin `/saunat` / "Saunat", aktiivinen linkki "Saunat" ✅ |
| `/liikenne` | valitsin `''` / "Valitse osio…" (disabled) ✅ |
| 1440 px `/` | 7 painiketta, valitsin `display: none`, otsikko 65 px ✅ |
| Verkkopyynnöt | **0 epäonnistunutta pyyntöä** (paikallisessa preview'ssä 404:äävät `/v1/...` toimivat julkaistuna) ✅ |
| Konsoli | **0 virhettä, 0 CSP-rikkomusta** ✅ |
| Kuvakaappaus 390×844 | Otsikko: brändi + "Osio \| Etusivu" -valitsin; sisältö (Nyt-otsikko, sääkortti) alkaa heti valitsimen alta ✅ |

### Tarkennus (3.10.2026): breakpoint 760 → 480 px

**Käyttäjän havainto:** *"nyt valikko typistyy myös kapealla desktopilla, typistä
vasta esim. alle 480?"* — 760 px oli liian leveä raja: valitsin korvasi
painikkeet jo kapeassa työpöytäikkunassa.

| Osa | Muutos |
|---|---|
| `apps/web/src/styles.css` | navigaation `@media (max-width: 760px)` → `@media (max-width: 480px)` |
| `apps/web/src/components/Layout.tsx` | kommentti päivitetty vastaamaan uutta rajaa |

**Muut 760 px -säännöt jäivät ennalleen** (Nyt-sivun taustakuva, sääkortti,
koostekortin infoteksti) — ne koskevat sisältöä, eivät navigaatiota, eikä
käyttäjän havainto kohdistunut niihin.

| Leveys | Valitsin | Otsikon korkeus | Huom |
|---|---|---|---|
| 390 px | näkyy | **121 px** | puhelin |
| 480 px | näkyy | **121 px** | raja |
| 481 px | ei (painikkeet) | 147 px | 3 painikeriviä |
| 768 px | ei | 147 px | tabletti |
| 1440 px | ei | 65 px | työpöytä |

Eli välillä 481–~880 px painikkeet vievät 3 riviä (147 px) — tämä on käyttäjän
nimenomainen valinta: valitsin halutaan vain puhelinlevyisille näytöille.
Kapea työpöytäikkuna ja tabletti pitävät tutut painikkeet.

**Julkaisu (vain dev):** `npx cdk deploy tampere360-dev-frontend
--require-approval never` (90 s) → uudet assetit
`index-CESABh7N.js` + `index-DS0hhBo7.css`. Julkaistun dev-sivuston
verifiointi (headless Chrome + CDP): 390 px → valitsin `flex`, arvo `/`
("Etusivu"), valinnan vaihto `/kamerat` navigoi ja aktiivinen linkki päivittyi;
**481 px → 7 painiketta, valitsin `display: none`**; 1440 px → 7 painiketta;
**0 konsolivirhettä ja 0 CSP-rikkomusta**. Testit 625/625 ✅, web 179/179 ✅,
ESLint ✅, Prettier ✅, `npm run build:web` ✅. Tässä vaiheessa vain dev
(prod vietiin myöhemmin samana päivänä, ks. luvun loppu).

> **Huomio julkaistun CSS:n tarkistuksesta:** buildin LightningCSS muuntaa
> `@media (max-width: 480px)` muotoon `@media (width<=480px)`. Julkaistua
> CSS:ää grepatessa kannattaa siis etsiä merkkijonoa `480px` tai `width<=480px`,
> ei `max-width:480px` — muuten syntyy virheellinen vaikutelma, ettei sääntöä
> ole julkaistu (näin kävi tässä verifioinnissa, ennen kuin asia tarkistettiin).


### Commit ja prod-julkaisu 3.10.2026

Muutos committoitiin ja pushaattiin repoon: **`4e7e867`**
`feat(web): use a dropdown selector for navigation on narrow screens`
(4 tiedostoa, +349/−2: `Layout.tsx`, `layout.test.ts`, `styles.css`,
`implementation_plan.md`). Ei salaisuuksia.

**Prod-diff ennen deployta** (`npx cdk diff --all -c env=prod -c wafEnabled=false
--region eu-north-1`): **vain 1 stack erosi** — `tampere360-prod-frontend`
(pelkästään `WebDeployment`-assetin `SourceObjectKeys`). Muut seitsemän stackia
ilmoittivat `There were no differences`, eli backend oli jo ajan tasalla
(§37:n `--all`-deploy oli vienyt aiemmat muutokset). Tämän vuoksi deploy
kohdistettiin **täsmälleen muuttuneeseen stackiin**, jotta mikään muu ei voi
muuttua vahingossa:

```bash
npx cdk deploy tampere360-prod-frontend \
  -c env=prod -c wafEnabled=false --region eu-north-1 --require-approval never
```

Kesto **76,5 s**. WAF on edelleen pois päältä (`wafEnabled=false`), kuten
§21:ssä on päätetty.

| Tarkistus | Tulos |
|---|---|
| `tampere247.online` + `www.` | HTTP 200 ✅ |
| Julkaistu build | `index-CESABh7N.js` + `index-DS0hhBo7.css` — **sama build kuin devissä** ✅ |
| Assetin otsakkeet | `content-type: text/css`, `cache-control: public, max-age=31536000, immutable` ✅ |
| 390 px / 480 px | valitsin `flex`, 0 painiketta, otsikko 121 px ✅ |
| 481 / 600 / 768 px | 7 painiketta, valitsin `display: none`, otsikko 147 px ✅ |
| 1440 px | 7 painiketta, otsikko 65 px ✅ |
| Valitsimen vaihto (390 px) | `/saunat` → `location.pathname` vaihtui, valitsin `/saunat`, aktiivinen linkki "Saunat" ✅ |
| Konsoli | **0 virhettä, 0 CSP-rikkomusta** ✅ |


## 39. Kustannusoptimointi: muuttumattomien ohitus, yksi S3-objekti per ajo, S3 Bucket Key (4.10.2026)

**Lähtökohta:** koko tilin kustannus ~1,2 $/vrk (≈ 1,1 €/vrk). Se ei ollut
yksittäinen "queue"-rivi vaan jakautui: S3 ~0,35 $, KMS ~0,31 $, CloudWatch
~0,16 $, **SQS ~0,12 $**, DynamoDB ~0,11 $, EventBridge ~0,08 $ /vrk.
Syy oli yhteinen: **adapterit kirjoittivat ja lähettivät jokaisen raakatietueen
uudelleen joka pollauskierroksella** — Nysse ja Tampere Traffic minuutin välein.
Mittaus 7 vrk:lta: `tampere360-dev-ingestion` 238 619 lähetettyä viestiä,
`tampere360-prod-ingestion` 238 634 (≈ **34 000 viestiä/vrk/ympäristö**), vaikka
tietueita oli ~20–25 ja ne muuttuivat harvoin. Dedup tapahtui vasta
normalisoinnissa (`processingKey`), jolloin SQS-pyyntö, S3-PUT, KMS-kutsu ja
Lambda-ajo oli jo maksettu. Sama juurisyy selitti S3:n PUT-pyynnöt
(~2 M/kk ≈ 10 $/kk) ja KMS-pyynnöt (1,09 M/kk = 3,21 $ + avain 0,92 $): ilman
S3 Bucket Keytä **jokainen objektioperaatio tekee KMS-kutsun** (AWS: bucket key
vähentää KMS-pyyntöjä jopa 99 %).

### Toteutus

| Osa | Muutos |
|---|---|
| `packages/source-adapter-sdk/src/incremental.ts` (uusi) | `selectChangedItems` (vertaa `contentHash`ia), `buildSentItems` (kartta koko joukosta → kadonneet siivoutuvat), `dropSentItems` (epäonnistuneet jäävät uudelleenlähetettäviksi) |
| `packages/source-adapter-sdk/src/archive.ts` (uusi) | `buildRawArchive` (JSON-kirjekuori `{schemaVersion, source, batchId, fetchedAt, itemCount, items[]}`), `rawArchiveKey` (sama `source=/year=/month=/day=/hour=/<batchId>.json`) |
| `packages/source-adapter-sdk/src/checkpoint.ts` | `SaveCheckpointInput.sentItems` + `loadSentItems(tableName, source)`. Tila IngestionState-tauluun (PK = source) → **ei IAM-muutosta** (`grantReadWriteData` oli jo) |
| Kaikki 5 adapteria | lähettävät vain muuttuneet tietueet; **yksi S3-objekti per ajokerta** (kirjoitus vain kun jokin muuttui). FMI säilyttää CAP-XML:n `sourceText`-kentässä |
| `infra/lib/data-stack.ts` | `bucketKeyEnabled: true` raakabucketiin |
| `apps/api/src/handler.ts` | `/v1/sources` projisoi kentät eksplisiittisesti — sisäinen `sentItems`-kartta **ei vuoda** julkisesta API:sta |

`itemsReceived` säilytettiin = lähteen palauttamien relevanttien tietueiden
määrä, joten Lähteiden tila -näkymä ei muutu.

### Verifiointi (dev)

| Tarkistus | Tulos |
|---|---|
| Testit / ESLint / Prettier / build | **645 testiä** ✅, ESLint ✅, build ✅ |
| Deploy dev (8 stackia) | ✅ 791 s |
| **SQS-lähetykset** `dev-ingestion` | **132 → 0 viestiä / 5 min** kun mikään ei muutu ✅ |
| **S3-objektit** | tasan **1 per lähde** (nysse ajaa minuutin välein → 1 objekti) ✅ |
| `sentItems` | TAMPERE_TRAFFIC 3, NYSSE 10, FMI 1, POLICE 33 ✅ |
| Koko putki | adapteri → normalize → EventBridge → processor → DynamoDB ✅; `/v1/situations` palauttaa kaikki kategoriat ✅ |

**Ei committoja. Prodia ei muutettu.**

### Muutos paljasti kaksi aiemmin piilossa ollutta vikaa

**(1) Stackkien deploy-järjestys menetti tapahtumia.** `cdk deploy --all` loi
ingestion-stackin (4/8) ennen event-processingiä (5/8). Tuoreessa dev-deployssa
normalisoija julkaisi tapahtumat 06:02:48 UTC, mutta situation-processor ja
EventBridge-sääntö syntyivät 06:02:55 — tapahtumat julkaistiin sääntöön, jota ei
ollut, ja ne **hävisivät pysyvästi**. Aiemmin tämä ei näkynyt, koska tietue
lähetettiin uudelleen joka minuutti; nyt `sentItems` merkitsi ne lähetetyiksi →
**Poliisi/Nysse/FMI eivät koskaan ilmestyneet UI:hin** (vain 3 TRAFFIC-riviä).
Korjaus: (a) `infra/bin/app.ts` luo **event-processingin ennen ingestionia**
(templaatit ennallaan, `cdk diff` → "no differences"); (b) datan korjaus:
`sentItems` poistettiin ja adapterit ajettiin uudelleen → POLICE 33,
PUBLIC_TRANSPORT 10, WEATHER 1, TRAFFIC 3 (47 tilannetta).
**Operatiivinen muistisääntö:** jos lähetyksen ohi menee tapahtumia (esim. uusi
deploy), poista `sentItems`-kartat IngestionState-taulusta — muuten ne eivät
palaa itsestään.

**(2) CDK:n hallitsemat Lambda-logiryhmät ovat `RETAIN`.** Devin `cdk destroy`
ei poista `/aws/lambda/tampere360-dev-*`-logiryhmiä, joten seuraava deploy
törmäsi `already exists` (ensimmäinen dev-deploy kaatui tähän). Ne poistettiin
käsin. Sama asia on pieni CloudWatch-kustannuserä (logit eivät vanhene) —
suositus jatkoon: eksplisiittinen `logRetention` (dev 3 pv / prod 30 pv).

### Rajaukset

Muutokset vietiin **vain deviin**. Prod toistetaan samana muutoksena
(`npm run deploy:prod`) ja sen jälkeen prodin `sentItems`-kartat on tyhjennettävä
kertaalleen, jotta tuoreen deploin aikana mahdollisesti menetetyt tapahtumat
syntyvät uudelleen.

