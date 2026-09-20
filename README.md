# Tampere360

Tampereen seudun reaaliaikainen tilannekuva: liikennehäiriöt, poliisitiedotteet,
pelastustoimi, säävaroitukset, yleisötapahtumat ja joukkoliikenne — kaikki
yhdessä palvelussa.

**Täysin serverless, tapahtumavetoinen AWS-arkkitehtuuri. Infra as Code (AWS CDK v2).**

## Arkkitehtuuri pähkinänkuoressa

```
Ulkoiset lähteet (Tampere Traffic API, Poliisi RSS, FMI CAP,
Visit Tampere/Eventz, Nysse GTFS-RT, pelastustoimi)
  → EventBridge Scheduler
  → lähdekohtaiset Lambda-adapterit (raakadata S3:een)
  → SQS ingestion queue
  → normalisointi-Lambda (yhteinen Tampere360Event-malli)
  → EventBridge custom bus
  → prosessointi (validointi, aluesuodatus, deduplikointi)
  → DynamoDB
  → API Gateway HTTP API
  → React SPA (S3 + CloudFront)
```

Tarkka suunnitelma: [`.clinerules/implementation_plan.md`](./.clinerules/implementation_plan.md)

## Repositoriorakenne

```
apps/                       # Sovellukset (Lambda-handlerit, React)
  web/                      # React SPA (Vite + TanStack Query + MapLibre) — vaihe 4
  api/                      # Query-Lambda — vaihe 2
  ingest-*/                 # Lähdeadapterit — vaiheet 2–3
  normalize/                # Normalisointi-Lambda — vaihe 2
  situation-processor/      # Validointi, aluesuodatus, deduplikointi — vaihe 2
packages/
  event-contracts/          # Yhteinen tapahtumamalli ja sopimustyypit
  source-adapter-sdk/       # EventSourceAdapter-rajapinta + apurit
  observability/            # Jäsennelty logitus, correlation ID, mittarit
infra/                      # AWS CDK -stackit — vaihe 1
docs/architecture/          # Arkkitehtuuridokumentaatio
docs/adr/                   # Arkkitehtuuripäätökset (ADR)
```

## Vaatimukset

- **Node.js 22** (AWS Lambda -runtime `nodejs22.x`; hallitaan nvm:llä)
- npm 10+
- AWS CLI + kredentiaalit (region `eu-west-1`)
- AWS CDK v2 (`npm install -g aws-cdk`)

Node 22:n asennus: ks. `.clinerules/implementation_plan.md` §2.

## Kehitys

```bash
npm install          # asentaa riippuvuudet kaikille workspace-paketeille
npm run build        # kääntää paketit (contracts → sdk → observability → infra) + web-buildin
npm run build:web    # pelkkä React-frontendin build (apps/web/dist)
npm run dev:web      # Vite-dev-palvelin (http://localhost:5173)
npm test             # ajaa vitest-testit
npm run test:watch   # testit watch-tilassa
npm run lint         # ESLint
npm run format       # Prettier
```

### Frontend paikallisesti

Vite-dev-palvelin tarvitsee API-osoitteen. Tuotannossa se luetaan
`/config.json`-tiedostosta (CDK kirjoittaa sen bucketiin), paikallisesti
ympäristömuuttujasta:

```bash
cd apps/web
VITE_API_URL=https://<api-id>.execute-api.eu-north-1.amazonaws.com npm run dev
```

Ilman muuttujaa kyselyt menevät samaan origin-palvelimeen (`/v1/...`), jolloin
Viten proxyä ei ole käytössä — käytä siis `VITE_API_URL`:ia.

## Infra (AWS CDK)

`infra/` sisältää koko AWS-arkkitehtuurin kahdeksana stackina
(foundation, data, eventing, ingestion, event-processing, api, frontend,
monitoring). Komennot (Node 22 + CDK CLI vaaditaan):

```bash
npm run synth        # syntesoi kaikki stackit (cdk synth)
npm run diff         # näyttää muutokset AWS:ään nähden
npm run deploy       # deployaa kaikki stackit (cdk deploy --all)
cd infra && npx cdk bootstrap   # kerran per tili/region ennen deployta
```

Ympäristö valitaan kontekstilla: `npx cdk deploy --all -c env=test`.
Prodilla on omat npm-skriptit: `npm run synth:prod`, `npm run diff:prod`,
`npm run deploy:prod` (ks. [`docs/architecture/prod-deploy.md`](./docs/architecture/prod-deploy.md)).

## Julkaistu ympäristö (dev, eu-north-1)

| Resurssi | Osoite |
|---|---|
| Frontend (CloudFront) | https://d36ic5wsx4b9yl.cloudfront.net |
| API (API Gateway HTTP API) | https://vllod80b6i.execute-api.eu-north-1.amazonaws.com |

```bash
curl https://d36ic5wsx4b9yl.cloudfront.net/config.json
curl "https://vllod80b6i.execute-api.eu-north-1.amazonaws.com/v1/situations?limit=5"
curl https://vllod80b6i.execute-api.eu-north-1.amazonaws.com/v1/health/sources
```

## Tuotanto (prod, eu-north-1)

Prod ajetaan samassa AWS-tilissä omalla nimiavaruudella
(`tampere360-prod-*`) ja omalla domainilla:

| Resurssi | Osoite |
|---|---|
| Frontend (CloudFront) | https://tampere247.online (myös www.) |
| API (HTTP API custom domain) | https://api.tampere247.online |

Prod-deploy lyhyesti (tarkka runbook: [`docs/architecture/prod-deploy.md`](./docs/architecture/prod-deploy.md)):

```bash
npm ci && npm run build     # web-buildi tarvitaan FrontendStackiin
npm run diff:prod           # esitarkistus
npm run deploy:prod         # cdk deploy --all -c env=prod -c wafEnabled=false --region eu-north-1
```

Prod eroaa dev:stä: oma domain + TLS 1.2, rajattu CORS sekä
`RETAIN`-poistopolitiikat ja DynamoDB-PITR (data ei häviä vahinkopoistossa).
WAF on valmiina mutta **ei käytössä oletuksena** (opt-in
`-c wafEnabled=true` + `cdk bootstrap` us-east-1:een).
Domain-, sertifikaatti- ja hosted zone -tiedot ovat versioituna
`infra/lib/config.ts`-tiedostossa (`ENVIRONMENT_DOMAINS.prod`).

```bash
curl https://tampere247.online/config.json
curl "https://api.tampere247.online/v1/situations?limit=5"
curl https://api.tampere247.online/v1/health/sources
```

## Lisenssit ja attribuutio

Datalähteet ovat avoimia (CC BY 4.0 tai vastaava). Jokaisen tapahtuman
`attribution`-kenttä kertoo lähteen, ja käyttöliittymä näyttää pakolliset
attribuoinnit (esim. `© OpenStreetMap contributors` karttatiilille,
Ilmatieteen laitos säävaroituksille).
