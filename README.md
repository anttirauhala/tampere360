# Tampere247

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
  → normalisointi-Lambda (yhteinen Tampere247Event-malli)
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
  web/                      # React SPA (Vite) — vaihe 4
  api/                      # Query-Lambda — vaihe 2
  ingest-*/                 # Lähdeadapterit — vaiheet 2–3
  normalize/                # Normalisointi-Lambda — vaihe 2
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
npm run build        # kääntää paketit (event-contracts → sdk → observability → infra)
npm test             # ajaa vitest-testit
npm run test:watch   # testit watch-tilassa
npm run lint         # ESLint
npm run format       # Prettier
```

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

## Lisenssit ja attribuutio

Datalähteet ovat avoimia (CC BY 4.0 tai vastaava). Jokaisen tapahtuman
`attribution`-kenttä kertoo lähteen, ja käyttöliittymä näyttää pakolliset
attribuoinnit (esim. `© OpenStreetMap contributors` karttatiilille,
Ilmatieteen laitos säävaroituksille).
