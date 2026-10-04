# CI/CD (GitHub Actions)

Tämä dokumentti on **runbook**: GitHub Actions -putki, sen esiedellytykset ja
tunnetut sudenkuopat. Koodi on `.github/`-hakemistossa ja savutesti
`scripts/smoke.mjs`issä.

Suunnitelma on kirjattu
[`implementation_plan.md`](../../.clinerules/implementation_plan.md) §15
(alkuperäinen tavoite) ja §40 (toteutus).

## 1. Työnkulut

| Työnkulku                                                    | Käynnistyy                                                 | Mitä tekee                                                                                  | AWS    |
| ------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| [`ci.yml`](../../.github/workflows/ci.yml)                   | PR + push `main`                                           | `npm ci` → build → ESLint → Prettier → testit → `cdk synth` (dev **ja** prod) → `npm audit` | **ei** |
| [`deploy-dev.yml`](../../.github/workflows/deploy-dev.yml)   | CI vihreä `main`issa (`workflow_run`), lisäksi manuaalinen | OIDC → `cdk diff` → `cdk deploy --all` (dev) → savutesti                                    | OIDC   |
| [`deploy-prod.yml`](../../.github/workflows/deploy-prod.yml) | **vain manuaalinen** (`workflow_dispatch`)                 | OIDC → `cdk diff` → `cdk deploy --all` (prod, `wafEnabled=false`) → savutesti               | OIDC   |

Kaikki kolme käyttävät samaa composite actionia
[`.github/actions/setup`](../../.github/actions/setup/action.yml) (Node `.nvmrc`:stä,
`npm ci`, `npm run build`), jotta CI ja deployt eivät eriydy toisistaan.

**Branch protection:** aseta `main`-haaraan pakolliseksi tarkistukseksi
`checks` (GitHubin UI näyttää sen muodossa `CI / checks`) ja
_rulesetin_ ollessa kyseessä jobin nimi `checks` — ks. §3.

## 2. Esiedellytykset GitHubissa (kerran)

### 2.1 Actions päälle

**Settings → Actions → General**

- Actions permissions: _Allow all actions and reusable workflows_
- Workflow permissions: **Read repository contents and packages** (työnkulut
  korottavat oikeutensa itse: deploy tarvitsee `id-token: write`)
- Ei rastia kohtaan "Allow GitHub Actions to create and approve pull requests"

### 2.2 Environments

**Settings → Environments → New environment**

| Environment | Asetukset                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `dev`       | Ei suojaussääntöjä. _Deployment branches_: Protected branches (tai Selected = `main`).                        |
| `prod`      | **Required reviewers**: lisää hyväksyjä(t). _Deployment branches_: Selected = `main`. Valinnainen wait timer. |

Environment määrää kaksi asiaa kerralla: prod-deploy pysähtyy odottamaan
hyväksyntää **ja** OIDC-tokenin `sub`-väite on
`repo:<omistaja>/<repo>:environment:prod` — prod-roolia ei siis voi käyttää
mistään muusta työnkulusta.

### 2.3 Repository variables

**Settings → Secrets and variables → Actions → Variables**

| Nimi                   | Pakollinen               | Arvo                                                           |
| ---------------------- | ------------------------ | -------------------------------------------------------------- |
| `DEV_DEPLOY_ROLE_ARN`  | kyllä                    | `arn:aws:iam::132339120388:role/tampere360-github-dev-deploy`  |
| `PROD_DEPLOY_ROLE_ARN` | kyllä                    | `arn:aws:iam::132339120388:role/tampere360-github-prod-deploy` |
| `AWS_REGION`           | ei (oletus `eu-north-1`) | `eu-north-1`                                                   |

Nämä ovat **variableita, eivät salaisuuksia** — rooli-ARN ei ole salaisuus.
Repositorioon **ei tarvita yhtään GitHub-salaisuutta**: tunnistautuminen
tapahtuu OIDC:llä (periaate: "Do not commit secrets" toteutuu rakenteellisesti).

### 2.4 Branch protection

**Settings → Branches** (tai Rulesets): vaadi `main`-haaralle

- _Require status checks to pass_ → `checks` (näkyy listassa vasta, kun CI on
  ajanut kerran)
- valinnaisesti _Require a pull request before merging_

### 2.5 Dependabot

**Settings → Code security and analysis** → _Dependabot alerts_ ja
_Dependabot security updates_ päälle. Ajastetut päivitykset tulevat
[`.github/dependabot.yml`](../../.github/dependabot.yml)istä (npm + Actions,
viikoittain).

### 2.6 Järjestys

1. Tämä konfiguraatio (2.1–2.5) ja AWS-osuus (§3).
2. `.github/`-tiedostot pushattaisiin `main`-haaraan.
3. Vasta sen jälkeen Actions-listassa näkyvät _Run workflow_ -painikkeet
   (`workflow_dispatch`) ja `workflow_run` alkaa laueta.

## 3. Esiedellytykset AWS:ssä (kerran)

Tili `132339120388`, alue `eu-north-1`. Tavoite: **ei pitkäikäisiä avaimia** —
GitHub saa lyhytaikaisen tokenin OIDC:n kautta.

### 3.1 GitHub OIDC -identiteettipalvelu

**IAM → Identity providers → Add provider → OpenID Connect**

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

(Konsoli hakee thumbprintin automaattisesti — tämä on helpoin tapa. CLI:llä
`aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com`.)

### 3.2 Kaksi deploy-roolia

Molemmat luodaan konsolissa (IAM → Roles → Create role → Web identity →
GitHub) tai CLI:llä. Trust policy jätetään **tarkasti rajatulle subille**:

`tampere360-github-dev-deploy`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::132339120388:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:anttirauhala/tampere360:environment:dev"
        }
      }
    }
  ]
}
```

`tampere360-github-prod-deploy`: sama, mutta `sub` =
`repo:anttirauhala/tampere360:environment:prod`.

### 3.3 Roolien oikeudet

CDK luo ja päivittää IAM-rooleja, CloudFormation-stackeja, Lambda-funktioita,
S3/DynamoDB/CloudFront/Route 53/SNS/KMS/EventBridge/SQS/Logs-resursseja.
Käytännön valinta tälle repolle:

| Rooli                           | Managed policyt                                                 |
| ------------------------------- | --------------------------------------------------------------- |
| `tampere360-github-dev-deploy`  | `PowerUserAccess` + `IAMFullAccess`                             |
| `tampere360-github-prod-deploy` | `PowerUserAccess` + `IAMFullAccess` (tai `AdministratorAccess`) |

`IAMFullAccess` tarvitaan, koska CloudFormation luo rooleja; ilman sitä deploy
kaatuu stackin puoliväliin. Kevennys jatkoon: dev-rooli voidaan rajata
tag-ehdolla vain `environment=dev`-resursseihin.

### 3.4 CDK bootstrap uskomaan CI-rooliin

`eu-north-1` on jo bootstrapattu (ks. [prod-deploy.md](./prod-deploy.md) §1),
mutta bootstrap-roolit eivät tunne CI-roolia:

```bash
cd infra
npx cdk bootstrap aws://132339120388/eu-north-1 \
  --trust arn:aws:iam::132339120388:role/tampere360-github-dev-deploy \
  --trust arn:aws:iam::132339120388:role/tampere360-github-prod-deploy \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

Komento päivittää bootstrap-roolien luottamuspolitiikat; stackit ja data
säilyvät ennallaan.

> **WAF ja us-east-1:** `deploy-prod.yml` ajaa kontekstilla
> `-c wafEnabled=false`, joten us-east-1-bootstrapia **ei** tarvita. Jos WAF
> otetaan joskus käyttöön (`-c wafEnabled=true`), myös us-east-1 on
> bootstrapattava tällä samalla `--trust`-listalla.

> **Muista:** jokainen API-avain (esim. Waltti/Nysse) viedään **erikseen per
> ympäristö** SSM:ään (`/tampere360/{env}/sources/...`). CDK ei luo
> salaisuuksia, eikä CI tarvitse niitä deployta varten — mutta uusi ympäristö
> tuottaa `ERROR API_KEY_MISSING` -tilan `/v1/health/sources`-vastaukseen,
> kunnes avain on viety.

## 4. Savutesti (`scripts/smoke.mjs`)

Deploy-workflown viimeinen vaihe. Lukee osoitteet `cdk deploy
--outputs-file`-tiedostosta — mitään ei ole kovakoodattu, ja prodissa
käytetään ensisijaisesti custom domainia (`ApiCustomUrl` / `FrontendCustomUrl`).

```bash
# Deployn jälkeen (outputs-tiedosto syntyy deployn yhteydessä)
node scripts/smoke.mjs --outputs infra/cdk-outputs-dev.json --env dev

# ...tai suoraan osoitteilla
node scripts/smoke.mjs --api https://api.tampere247.online \
                       --frontend https://tampere247.online
```

| Tarkistus                         | Kriteeri                                          |
| --------------------------------- | ------------------------------------------------- |
| `GET <api>/v1/situations?limit=1` | 200, `{ items: [...] }`, rivillä `situationId`    |
| `GET <api>/v1/health/sources`     | 200, `status: OK`, **ei yhtään** `ERROR`-lähdettä |
| `GET <frontend>/`                 | 200, sisältää brändin `Tampere 247`               |
| `GET <frontend>/config.json`      | 200, `apiUrl` on http(s)-osoite                   |

**Puuttuva lähde on varoitus, ei virhe.** Tuoreessa ympäristössä Schedulerit
kirjaavat tilan vasta ensimmäisellä ajokerralla (FMI 5 min, POLICE 2–5 min);
savutesti yrittää uudelleen 10 × 15 s. Sen sijaan selkeä `ERROR` (esim.
`API_KEY_MISSING`) pysäyttää putken — se on oikea havainto.

Parametrit: `--attempts <n>`, `--delay-ms <ms>` (nopea paikallinen ajo),
`--help`. Paluukoodit: `0` = läpi, `1` = tarkistus epäonnistui,
`2` = käyttövirhe (esim. outputs-tiedostosta puuttuu stack).

## 5. Sama putki paikallisesti

CI on pelkkiä komentoja — ne voi ajaa käsin:

```bash
npm ci
npm run build          # paketit → infra → apps-typecheck → web
npm run lint
npm run format:check
npx vitest run
(cd infra && npx cdk synth -c env=dev)
(cd infra && npx cdk synth -c env=prod -c wafEnabled=false)
npm audit --audit-level=critical   # CI:n portti
npm audit --audit-level=high       # raportti (ei pysäytä)
```

Kolme helppoa kompastuskiveä näissä komennoissa:

- **`--all` ei ole `synth`-eikä `diff`-lippu** (se kuuluu `deploy`/`destroy`ille) —
  `cdk synth` ja `cdk diff` kattavat kaikki stackit ilman sitä. Väärä lippu ei
  kaada komentoa, mutta tulostaa _Unknown option(s): --all_ -varoituksen.
- **`cdk synth` ajetaan `infra/`-hakemistossa**, koska `cdk.json` (ja samalla
  `--app`-polku) on siellä. Juuresta ajettuna CDK valittaa
  `--app is required …`. Sama koskee `cdk diff`ia ja `cdk deploy`ta —
  työnkuluissa niillä on `working-directory: infra`, ja siksi
  `--outputs-file` annetaan **absoluuttisena** polkuna
  (`${{ github.workspace }}/infra/cdk-outputs-<env>.json`), jotta myös juuresta
  ajettava savutesti löytää saman tiedoston.
- **Argumetit workspace-skriptille** annetaan muodossa
  `npm run <skripti> -w <workspace> -- <args>`; pelkkä `npm run synth -- -c env=x`
  ei välitä kontekstia oikein (ks. `package.json`in `synth:prod`).

Deploy paikallisesti (kun AWS-profiili on asetettu) on edelleen tuettu:
`npm run diff` / `npm run deploy` / `npm run diff:prod` / `npm run deploy:prod`
(ks. [prod-deploy.md](./prod-deploy.md)). CI ja paikallinen deploy käyttävät
samoja npm-skriptejä ja -konteksteja.

## 6. Tunnetut sudenkuopat

1. **Prettier-baseline.** `npm run format:check` oli punainen 43 tiedostolla
   (§16). Korjaus ajettiin omassa commitissaan (`npm run format`), ja
   `.clinerules/` rajattiin `.prettierignore`illa pois: se on agenttisääntöjä
   ja pitkämuotoista suunnitteludokumentaatiota (~3400 riviä), joiden
   muotoilu toisi ~1200 riviä pelkkää kosmetiikkaa.
2. **`cdk synth` vaatii web-buildin.** `FrontendStack` heittää ilman
   `apps/web/dist/index.html`iä → `npm run build` (tai vähintään
   `npm run build:web`) on ajettava **ennen** synthiä. Siksi se on composite
   actionissa.
3. **`pretest` ajaa koko buildin.** CI:ssä käytetään `npx vitest run`ia, jotta
   build ei aja kahteen kertaan.
4. **Alue.** `infra/bin/app.ts` oletus on `eu-west-1`, mutta **sekä dev että
   prod ovat `eu-north-1`**. Workflowt asettavat `CDK_DEFAULT_ACCOUNT` ja
   `CDK_DEFAULT_REGION`-ympäristömuuttujat, joten synteesi ja deploy kohdistuvat
   oikein. Jos alue joskus vaihtuu, muuta se workflowjen `env`-lohkoon
   (tai aseta repo-muuttuja `AWS_REGION`).
5. **`-c env=prod` vaatii AWS-tilin.** `infra/bin/app.ts` heittää ilman tilia.
   CI:ssä tili tulee `CDK_DEFAULT_ACCOUNT`-ympäristömuuttujasta
   (julkinen tieto, myös `infra/lib/config.ts`issä), joten PR-tarkistus toimii
   ilman kredentiaaleja.
6. **`sentItems` ja tuore deploy (§39).** Adapterit lähettävät vain
   _muuttuneet_ tietueet ja muistavat lähetetyt `IngestionState`-tauluun. Jos
   deploy korvaa ingestion- tai event-processing-stackin, jo lähetetyt
   tapahtumat **eivät palaa itsestään**. Korjaus on datan operaatio (ei
   automatisoitu): poista lähdekohtaiset `sentItems`-kartat
   `IngestionState`-taulusta ja anna Schedulerien ajaa kerran.
7. **Stackien järjestys.** `bin/app.ts` luo event-processingin **ennen**
   ingestionia, koska CloudFormation deployaa siinä järjestyksessä. Muuten
   tuore deploy voi menettää ensimmäiset tapahtumat (havaittu §39:ssä).
8. **CDK:n hallitsemat logiryhmät ovat `RETAIN`.** `cdk destroy` ei poista
   `/aws/lambda/tampere360-*`-ryhmiä, joten seuraava deploy voi törmätä
   `already exists`. Devin uudelleenluonnissa ryhmät poistetaan käsin.
9. **Deploy ei koskaan käynnisty PR:stä**, eikä prod koskaan automaattisesti.
   Prod-kulku on aina: _Run workflow_ → GitHub Environment `prod` → hyväksyjä.
10. **`package-lock.json` oli epäsynkronissa.** `apps/saunas` ja
    `apps/water-temperature` puuttuivat lukitustiedostosta, joten `npm ci`
    kaatui heti: _`npm ci` can only install packages when your package.json and
    package-lock.json … are in sync / Missing: @tampere360/saunas@0.1.0 from
    lock file_. Lukitus synkronointiin ennen putken käyttöönottoa — ilman tätä
    koko CI olisi ollut punainen ensimmäisestä ajosta lähtien (todennettu
    `npm ci --dry-run`illa). Muistisääntö: kun workspacen `package.json`
    muuttuu, myös lukitustiedosto on päivitettävä.
11. **`npm audit --audit-level=high` on tällä hetkellä punainen** (1 high,
    2 moderate): transitiiviset `brace-expansion`-DoS-advisoryt
    `aws-cdk-lib`:n, `glob`in ja `@typescript-eslint`in alla sekä
    `@vitest/mocker`. Yksikään ei kulkeudu Lambda-bundleihin, eikä korjaus
    onnistu ilman `npm audit fix --force`ia (breaking). Siksi CI:ssä on kaksi
    porrasta: `--audit-level=critical` on portti ja `--audit-level=high` vain
    raportti; Dependabot päivittää riippuvuuksia PR:inä.
12. **Format-baseline muuttaa asset-hasheja.** Prettier muotoili myös
    Lambda-lähteitä (`apps/*/src`) ja web-koodia, joten ensimmäinen deploy
    baseline-commitin jälkeen päivittää Lambda-koodit ja web-assetin
    (uusi `S3Key`). Tämä on todettu `cdk diff`illä: vain asset-hashit
    muuttuvat, **yksikään resurssi ei korvaudu** (foundation/data/eventing/
    monitoring: ei eroja).

## 7. Vianetsintä

| Oire                                                      | Todennäköinen syy                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Roolin trust policyn `sub` ei vastaa environmentia/haaraa, tai OIDC-provideria ei ole luotu                                                    |
| `is not authorized to perform: cloudformation:...`        | Deploy-roolilta puuttuu oikeuksia (ks. §3.3)                                                                                                   |
| `Access Denied` bootstrap-bucketiin                       | `cdk bootstrap --trust` puuttuu (§3.4)                                                                                                         |
| `npm ci` kaatuu                                           | `package-lock.json` ja `package.json` eri versiossa — aja `npm install` paikallisesti ja committoi lock                                        |
| CI vihreä, deploy ei käynnisty                            | `workflow_run` vaatii, että **CI on määritelty `main`-haarassa** ja että ajo päättyi `success`iin; manuaalinen ajo löytyy Actions → Deploy dev |
| Savutesti: `HTTP 403` frontendistä                        | CloudFront-invalidointi kesken — yritykset jatkuvat automaattisesti                                                                            |
| Savutesti: `lähteet virhetilassa: ...`                    | Oikea havainto: katso syykoodi (`error`) ja SSM-parametri                                                                                      |
| Savutesti: `ei vielä kirjausta: FMI_CAP`                  | Varoitus; FMI kirjaa tilan 5 min välein                                                                                                        |
| `Workflow permissions` -virhe `id-token`                  | Työnkulun jobilta puuttuu `permissions: id-token: write` tai repossa ei ole sallittu OIDC:tä                                                   |
