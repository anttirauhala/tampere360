# ADR 0001 — CI/CD GitHub Actionsilla ja OIDC-tunnistautumisella

- **Tila:** Hyväksytty
- **Päivä:** 4.10.2026
- **Konteksti:** [implementation_plan.md](../../.clinerules/implementation_plan.md) §15 (CI/CD) ja §40 (toteutus)
- **Runbook:** [docs/architecture/ci-cd.md](../architecture/ci-cd.md)

## Tausta

Tampere360 on TypeScript-monorepo (npm workspaces: `apps/`, `packages/`,
`infra/`) ja koko infrastruktuuri on AWS CDK v2:ta. Deployt tehtiin
tähän asti käsin paikallisella AWS-profiililla (`npm run deploy`,
`npm run deploy:prod`). Suunnitelma (§15) edellyttää:

- PR-tarkistukset (lint, testit, `cdk synth`, turvatarkistukset)
- `main`-haarasta automaattinen dev-deploy ja manuaalisen hyväksynnän takana
  oleva prod-deploy
- AWS-kirjautuminen **OIDC-roolilla**, ei pitkäikäisiä access key -avaimia

Repo on GitHubissa (`anttirauhala/tampere360`), joten GitHub Actions on
luonnollinen valinta CI-alustaksi.

## Päätös

1. **Kolme työnkulkua:** `ci.yml` (ei AWS:ää), `deploy-dev.yml`
   (`workflow_run` CI:n jälkeen + manuaalinen), `deploy-prod.yml`
   (vain `workflow_dispatch`).
2. **OIDC, ei salaisuuksia.** AWS-kirjautuminen `aws-actions/configure-aws-credentials@v4`:llä;
   GitHub Environment määrää tokenin `sub`-väitteen
   (`repo:<owner>/<repo>:environment:dev|prod`). Repositorioon ei tallenneta
   yhtään AWS-avainta eikä GitHub-secretiä.
3. **Prod on hyväksynnän takana** GitHub Environmentin _required reviewers_
   -säännöllä (`deploy-prod.yml` ei käynnisty automaattisesti mistään syystä).
4. **Dev-deploy ajetaan siitä commitista, jonka CI validoi**
   (`workflow_run.head_sha`), joten CI ja deploy eivät voi eriytyä.
5. **Sama komentoputki paikallisesti ja CI:ssä.** Kaikki vaiheet ovat
   npm-skriptejä/composite action; CI ei tee mitään, mitä ei voi ajaa käsin.
6. **`cdk synth` ajetaan sekä deville että prodille PR-tarkistuksessa**
   ilman kredentiaaleja (tili annetaan kontekstina/ympäristömuuttujana), joten
   domain/TLS-konfiguraation regressiot näkyvät ennen mergeä.
7. **Savutesti on osa deployta** (`scripts/smoke.mjs`), ja se lukee osoitteet
   `cdk deploy --outputs-file`-tiedostosta — ei kovakoodattuja osoitteita.

## Perustelut

| Ratkaisu                                | Miksi                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_run` push-triggerin sijaan    | Deploy ei käynnisty ennen kuin CI on vihreä, eikä tämä vaadi branch protection -asetusta.                                                                                                                                                                                                                                                                                                                                                                                        |
| Environment `prod` OIDC-subissa         | Sama mekanismi antaa sekä manuaalisen hyväksynnän että teknisen rajauksen: prod-roolia ei voi käyttää muusta työnkulusta kuin `deploy-prod.yml`:stä.                                                                                                                                                                                                                                                                                                                             |
| Kaksi erillistä deploy-roolia           | Dev-roolin vuotaminen ei avaa prodia. Roolien oikeudet ovat samat, mutta luottamusrajaus on eri.                                                                                                                                                                                                                                                                                                                                                                                 |
| `npm audit` kahdessa portaassa          | `--audit-level=critical` pysäyttää putken, `--audit-level=high` raportoi lokiin mutta ei pysäytä. Nykyiset korkeat löydökset ovat transitiivisia DoS-advisoryja build-aikaisissa työkaluissa (`brace-expansion` `aws-cdk-lib`/`glob`/`@typescript-eslint`in alla, `@vitest/mocker`), eivätkä ne kulkeudu Lambda-bundleihin; korjaus vaatisi `npm audit fix --force`in (breaking). Täysin pysäyttävä portti olisi tehnyt CI:stä punaisen heti alusta ilman korjausmahdollisuutta. |
| `.clinerules/` pois Prettieristä        | Agenttisäännöt ja pitkä suunnitteludokumentti eivät ole sovelluskoodia; muotoilu toisi ~1200 riviä kohinaa.                                                                                                                                                                                                                                                                                                                                                                      |
| Ei WebSocket-/integraatiotestejä CI:ssä | Selaintason verifiointi on tähän asti tehty headless-Chromella käsin; sen automatisointi on oma työnsä (Vaihe 5 jatko).                                                                                                                                                                                                                                                                                                                                                          |

## Vaihtoehdot, joita ei valittu

- **Pitkäikäiset AWS access keyt GitHub Secretsissä.** Yksinkertaisin, mutta
  vuotava avain on pysyvä pääsy koko tiliin. Hylätty suunnitelman §15:n
  mukaisesti.
- **AWS CodePipeline / CodeBuild.** Toimisi, mutta CI-logiikka ja PR-tarkistukset
  eläisivät eri paikassa kuin koodi, ja PR-integraatio olisi heikompi.
- **Automaattinen prod-deploy mainista.** Ei sovi palveluun, jossa on
  `RETAIN`-databucketit, DynamoDB-PITR ja käsin ylläpidettävät SSM-avaimet;
  prod vaatii ihmisen päätöksen.
- **Erillinen test-ympäristö CI:ssä.** `test` on kontekstina tuettu, mutta
  ylimääräinen ympäristö tuo kustannuksia ilman lisäarvoa MVP:ssä.

## Seuraukset

**Hyvät**

- Julkaisu on toistettava ja jäljitettävä: sama komentoputki, sama commit,
  savutesti jokaisen dev/prod-deployn jälkeen.
- Repositorioon ei tarvita salaisuuksia; tunnistautuminen on lyhytaikainen.
- Prod-muutos vaatii aina ihmisen hyväksynnän, ja kuka tahansa näkee
  Actions-lokista mitä ajettiin.

**Huomioitavat**

- **OIDC-roolit ja bootstrap-`--trust` ovat käsin ylläpidettäviä** AWS:ssä
  (CloudFormationin ulkopuolella) — sama periaate kuin SSM-avaimissa.
- Deploy-roolilla on laajat oikeudet (`PowerUserAccess` + `IAMFullAccess`),
  koska CDK luo rooleja. Tämä on tiedostettu riski ja dokumentoitu
  runbookissa; tarvittaessa rooli voidaan rajata tag-ehdoin.
- Deploy-/synth-komennot sisältävät AWS-tilin ja alueen
  (`CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`) — ne ovat julkisia tietoja,
  mutta alueen vaihtuessa workflowt on päivitettävä.
- Prettier on nyt portti CI:ssä: muotoilemattomat tiedostot pysäyttävät
  putken. Tämä on tarkoituksellista, ja baseline korjattiin ennen käyttöönottoa.
- **`package-lock.json` oli epäsynkronissa** (`apps/saunas` ja
  `apps/water-temperature` puuttuivat), joten `npm ci` olisi kaatunut heti.
  Lukitus synkronointiin ennen putken käyttöönottoa; jatkossa jokainen
  workspace-`package.json`in muutos edellyttää lukitustiedoston päivitystä.
