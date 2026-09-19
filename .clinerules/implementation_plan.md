# Tampere360 — Toteutussuunnitelma

> Lähdeaineisto: `.clinerules/architecture.md` (773 riviä) + lähteiden validointi 6.9.2026
> Tilanne: Vaihe 0 ✅, Vaihe 1 ✅ (CDK-infra, 8 stackia), Vaiheet 2–3 ✅
> (FMI CAP, Digitraffic, poliisi-RSS ja Nysse Waltti toimivat päästä päähän;
> tapahtumalähde disabloitu, API 404 — ks. §18). Deploy: `tampere360-dev-*`
> eu-north-1. Seuraavaksi Vaihe 4 (React-käyttöliittymä).

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

### Vaihe 4 — Frontend
- `apps/web`: Vite + React + TS
- TanStack Query (30–60 s pollaus), React Router
- MapLibre GL JS -kartta (OSM-tiilet, attribuutio), tilannemarkerit
  kategorioittain, kategorianäkymät, Lähteiden tila
- HTML-sanitisointi; attribution-näyttö lisenssien mukaan
- `BucketDeployment` CDK:ssa

### Vaihe 5 — Testit, valvonta, CI
- Yksikkötestit fixture-pohjaisesti (test-fixtures-paketti)
- Contract-testit adaptereille
- CloudWatch-dashboard + hälytykset käyttöön
- GitHub Actions -workflow (PR-tarkistukset + OIDC-deploy)
- ADR-dokumentit keskeisistä päätöksistä

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




