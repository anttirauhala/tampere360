# Prod-käyttöönotto (tampere247.online)

Tampere360:n tuotantoympäristö ajetaan samassa AWS-tilissä (`132339120388`) ja
samalla alueella (`eu-north-1`) kuin dev, mutta omalla nimiavaruudella:
stackit `tampere360-prod-*` ja oma domain **tampere247.online**. Dev ja prod
eivät jaa yhtään resurssia.

| Osoite | Mihin |
|---|---|
| `https://tampere247.online` | Frontend (CloudFront, ensisijainen) |
| `https://www.tampere247.online` | Sama jakelu (lisänimi) |
| `https://api.tampere247.online` | API (API Gateway HTTP API, custom domain) |

Tämä dokumentti on **runbook**: komennot voi ajaa sellaisenaan.

---

## 1. Esiedellytykset (tarkistettu 20.9.2026)

| Asia | Tila / arvo |
|---|---|
| AWS-tili | `132339120388`, IAM-käyttäjä `tampere360user` |
| Alue | `eu-north-1` (Tukholma) — sama kuin dev |
| Domain + hosted zone | `tampere247.online`, `Z04105072OQTLR436VXG7` ✅ |
| CloudFront-sertifikaatti | `arn:aws:acm:us-east-1:132339120388:certificate/fce78d52-b0b6-4eb9-8abb-d94250666a13` (`tampere247.online` + `*.tampere247.online`, ISSUED) ✅ |
| CDK bootstrap `eu-north-1` | tehty dev-deployn yhteydessä ✅ |
| CDK bootstrap `us-east-1` | **valinnainen** — tarvitaan vain jos WAF otetaan käyttöön (`-c wafEnabled=true`) |
| Node.js | 22.x, `npm ci` + `npm run build` ajettu |

**WAF on tässä vaiheessa pois päältä.** Repon npm-skriptit (`synth:prod`,
`diff:prod`, `deploy:prod`) ajavat kontekstilla `-c wafEnabled=false`, joten
us-east-1-bootstrapia ei tarvita eikä WAF-kustannusta (~5 $/kk) synny.
CloudFront-jakelu, domain, TLS ja Route 53 -tietueet toimivat täysin ilman
WAF:ia. Kun WAF halutaan myöhemmin käyttöön:

```bash
cd infra
npx cdk bootstrap aws://132339120388/us-east-1   # kerran
npx cdk deploy --all -c env=prod -c wafEnabled=true --region eu-north-1
```

---

## 2. Mitä prod-deploy luo

| Stack | Alue | Sisältö |
|---|---|---|
| `tampere360-prod-foundation` | eu-north-1 | KMS data-key (RETAIN) |
| `tampere360-prod-data` | eu-north-1 | S3 raw (RETAIN), DynamoDB Situations / SourceEvents / IngestionState (RETAIN, PITR, deletionProtection) |
| `tampere360-prod-eventing` | eu-north-1 | EventBridge custom bus + arkisto |
| `tampere360-prod-ingestion` | eu-north-1 | 4 aktiivista adapteria (FMI, Tampere Traffic, Poliisi, Nysse) + Scheduler-ajastukset + DLQ:t, normalisointi-Lambda |
| `tampere360-prod-event-processing` | eu-north-1 | situation-processor + domain event DLQ |
| `tampere360-prod-api` | eu-north-1 | HTTP API + query-Lambda + **ACM-sertifikaatti ja custom domain `api.tampere247.online`** |
| `tampere360-prod-frontend` | eu-north-1 | S3 web-bucket (RETAIN) + CloudFront (**tampere247.online**, **www**, TLS 1.2_2021) + **Route 53 A/AAAA** |
| `tampere360-prod-monitoring` | eu-north-1 | CloudWatch-dashboard + hälytykset + SNS |
| `tampere360-prod-waf` | **us-east-1** | CloudFront WebACL (3 AWS managed -sääntöryhmää) — **ei synny oletusarvoisesti**, vain `-c wafEnabled=true` |

Domain-konfiguraatio on versioitu koodissa (`infra/lib/config.ts`,
`ENVIRONMENT_DOMAINS.prod`) ja se on ainoa paikka, jota tarvitsee muuttaa, jos
osoitteet vaihtuvat. Regressiosuoja: `infra/test/config.test.ts`.

---

## 3. Prod-deploy

```bash
# 0) Riippuvuudet ja build (web-buildi tarvitaan FrontendStackiin)
npm ci
npm run build

# 1) Esitarkistus: mitä AWS:ään ollaan luomassa/muuttamassa
npm run diff:prod

# 2) Deploy (kysyy hyväksynnät; 8 stackia eu-north-1:een, ei WAF:ia)
npm run deploy:prod
```

Komennot ilman npm-skriptejä (sama kuin skripteissä, WAF pois päältä):

```bash
cd infra
npx cdk diff   --all -c env=prod -c wafEnabled=false --region eu-north-1
npx cdk deploy --all -c env=prod -c wafEnabled=false --region eu-north-1
```

Hyödyllisiä variantteja:

| Tilanne | Komento |
|---|---|
| WAF käyttöön (vaatii us-east-1-bootstrapin) | `... -c env=prod -c wafEnabled=true` |
| Ilman omaa domainia (pelkkä savutesti) | `... -c env=prod -c domainEnabled=false` |
| Vain yksi stack | `npx cdk deploy tampere360-prod-api -c env=prod --region eu-north-1` |
| Tietty profiili | `... --profile <profiili>` |
| Ei interaktiivisia kysymyksiä (CI) | `... --require-approval never` |

Deploy kestää ensimmäisellä kerralla noin 10–15 min (CloudFront + API-sertifikaatin
DNS-validointi). Lopuksi CDK tulostaa outputit:
`FrontendCustomUrl`, `ApiCustomUrl`, `ApiDomain`, `DistributionDomainName`.

> **Jos deploy näyttää pysähtyvän eikä mitään synny:** `cdk deploy --all` kysyy
> **jokaiselta stackilta erikseen** hyväksynnän ("Do you wish to deploy these
> changes (y/n)?"). Kysymystä varten CDK luo change setin (CloudFormation-tila
> `REVIEW_IN_PROGRESS`); jos vastaat `n` tai sessio katkeaa, change set ja tyhjä
> stack poistetaan eikä **mitään** resurssia synny. CloudTrailissa tämä näkyy
> jonona `CreateChangeSet → DeleteChangeSet/DeleteStack` per stack, ja
> `aws cloudformation list-stacks` näyttää stackit tilassa `DELETE_COMPLETE`.
> Tämä on **odotettu** lopputulos keskeytyneestä ajosta — siivottavaa ei jää.
>
> Aja sen vuoksi ilman kysymyksiä ja mieluiten irrallisena, jotta terminaalin
> katkeaminen ei keskeytä 10–15 min kestävää deployta:
>
> ```bash
> nohup npm run deploy:prod -- --require-approval never > /tmp/prod-deploy.log 2>&1 &
> tail -f /tmp/prod-deploy.log      # seuraa etenemistä
> ```

---

## 4. Deployn jälkeen: savutestit

```bash
# Frontend + ajonaikainen konfiguraatio
curl -s https://tampere247.online/config.json
curl -sI https://tampere247.online | head -5          # 200, HSTS, CSP

# API omalla domainilla
curl -s "https://api.tampere247.online/v1/situations?limit=5" | head -c 400
curl -s https://api.tampere247.online/v1/health/sources

# Suojausotsakkeet
curl -sI https://tampere247.online | grep -i 'strict-transport\|content-security'
```

Tarkista AWS:stä:

```bash
# DNS osoittaa CloudFrontiin
dig +short tampere247.online A
dig +short api.tampere247.online A

# CloudFront-sertifikaatti on otettu käyttöön
aws acm describe-certificate --region us-east-1 \
  --certificate-arn arn:aws:acm:us-east-1:132339120388:certificate/fce78d52-b0b6-4eb9-8abb-d94250666a13 \
  --query 'Certificate.InUseBy'
# API:n sertifikaatti syntyi eu-north-1:een
aws acm list-certificates --region eu-north-1

# WAF — vain jos se on otettu käyttöön (-c wafEnabled=true)
aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1

# Stackit
aws cloudformation list-stacks --region eu-north-1 \
  --query 'StackSummaries[?starts_with(StackName,`tampere360-prod`)].{Name:StackName,Status:StackStatus}' --output table
```

Ensimmäinen data putkesta: Schedulerit käynnistyvät 1–5 min välein. Seuraa
CloudWatch-dashboardia `tampere360-prod-pipeline` ja `/v1/health/sources`-rajapintaa.
Hälytykset menevät SNS-topiciin `tampere360-prod-alarms` — tilaa siihen oma
sähköposti, jos haluat hälytykset itsellesi:

```bash
aws sns subscribe --region eu-north-1 \
  --topic-arn "$(aws cloudformation describe-stacks --region eu-north-1 \
     --stack-name tampere360-prod-monitoring \
     --query 'Stacks[0].Outputs[?OutputKey==`AlarmTopicArn`].OutputValue' --output text)" \
  --protocol email --notification-endpoint oma@esimerkki.fi
```

---

## 5. Prod-erot dev-ympäristöön verrattuna

| Asia | dev | prod |
|---|---|---|
| Domain | CloudFront-oletusdomain | `tampere247.online` + `www` + `api.` |
| TLS | CloudFrontin oletus | `TLSv1.2_2021` (CloudFront), `TLS_1_2` (API) |
| WAF | ei | ei oletusarvoisesti (opt-in: `-c wafEnabled=true`, vaatii us-east-1-bootstrapin) |
| API throttlaus / `limit` | 10 req/s (purske 20), oletus-limit 20, Lambda-concurrency 5 | sama (samat vakiot, ks. `infra/lib/config.ts`) |
| CORS | `*` | `https://tampere247.online`, `https://www.tampere247.online` |
| S3 / DynamoDB / KMS poisto | `DESTROY` (+ auto-delete) | `RETAIN`, ei auto-deletea |
| DynamoDB PITR / deletionProtection | pois | päällä |
| Stackien nimet | `tampere360-dev-*` | `tampere360-prod-*` |

---

## 6. Päivitykset ja palautus

**Uuden version julkaisu:** `npm run deploy:prod`. Frontendin
`BucketDeployment` invalidoi CloudFrontin automaattisesti, joten
`apps/web`-muutokset näkyvät heti deployn valmistuttua (`config.json`-behavior
on `CACHING_DISABLED`).

**Palautus (rollback):**
- Frontend: `git revert` + `npm run deploy:prod`, tai CloudFront →
  Distribution → *Invalidations* (`/*`).
- Lambda-koodi: `cdk deploy tampere360-prod-ingestion` edellisellä commitilla.
- Infra: `git revert` + `npm run diff:prod` — tarkista aina ennen deployta,
  ettei CloudFormation korvaa resursseja (esim. DynamoDB-GSI-muutokset ovat
  hitaita ja vaativat yhden indeksimuutoksen per deploy).
- Dataa ei palauteta deploylla: DynamoDB PITR (35 pv) ja S3-arkisto ovat
  tarvittaessa käytettävissä.

**Koko ympäristön poisto:** `npm run destroy` **ei** poista prod-resursseja
kokonaan, koska S3, DynamoDB ja KMS ovat `RETAIN`. Ne pitää poistaa erikseen
(DynamoDB-taulujen `deletionProtection` pois ensin). Tämä on tarkoituksellista:
vahinkopoisto ei hävitä dataa.

---

## 7. Tunnettuja sudenkuoppia

1. **`-c wafEnabled=true` oli aiemmin hiljainen bugi.** CDK antaa
   komentorivikontekstin merkkijonona (`"true"`), joten vanha `=== true` ei
   lauennut — WAF:ia ei koskaan syntynyt. Korjattu `contextFlag()`-apurilla
   (`infra/bin/app.ts`). Sama koskee `-c domainEnabled=false`.
2. **Jos WAF otetaan käyttöön, bootstrap us-east-1:een tarvitaan**
   (`npx cdk bootstrap aws://132339120388/us-east-1`) — muuten deploy kaatuu
   virheeseen `S3 bucket cdk-hnb659fds-assets-...-us-east-1 does not exist`.
   Ilman WAF:ia (oletus) us-east-1:tä ei tarvita.
3. **Sertifikaatti väärällä alueella** → CloudFront vaatii ACM-sertifikaatin
   `us-east-1`:stä, API Gateway oman alueensa (eu-north-1) sertifikaatin.
   Siksi API:n sertifikaatti luodaan CDK:lla DNS-validoituna, kun taas
   CloudFrontin sertifikaatti tuodaan ARN:na.
4. **DNS-tietueet ovat CDK:n hallinnassa.** Älä luo `tampere247.online`,
   `www` tai `api` -tietueita käsin — deploy kaatuu törmäykseen.
5. **Idempotenssi ja prosessointilogiikan muutokset** (ks.
   `.clinerules/implementation_plan.md` §20): kun normalisointi- tai
   situation-processor-logiikka muuttuu, `SourceEvents` on tyhjennettävä,
   jotta samat lähdetapahtumat synnyttävät tilanteet uudelleen.
6. **WAF (jos käytössä) ja rajapinnan luonne.** `AWSManagedRulesCommonRuleSet`
   sisältää `SizeRestrictions_BODY`-säännön; palvelu on toistaiseksi pelkkä
   GET-rajapinta, joten sääntö ei haittaa. Jos myöhemmin lisätään
   POST-rajapintoja, säännöt on tarkistettava uudelleen.

---

## 8. Kustannussuojat ja valvonta

API on **julkinen GET-rajapinta ilman API-avainta**, joten CORS ei estä
komentoriviltä tehtävää tykitystä. Suojat on mitoitettu sen mukaan:

| Suoja | Arvo | Missä |
|---|---|---|
| API Gateway -throttlaus | **10 req/s**, purske 20 → ylimenevä saa HTTP 429 (ei Lambda/DynamoDB-kutsua) | `infra/lib/config.ts` → `API_THROTTLE` |
| Query-Lambdan varattu concurrency | **5** | `infra/lib/config.ts` → `QUERY_RESERVED_CONCURRENCY` |
| `limit`-parametri | oletus **20**, yläraja 200 (jokainen item = DynamoDB-luku) | `apps/api/src/params.ts` |
| Hälytykset | API-pyyntöpiikki ≥ 1000 / 5 min, API 4xx (sis. 429) ≥ 100 / 5 min, Lambda-throttlaukset ≥ 1 | `tampere360-<env>-api-request-spike`, `-api-client-errors`, `-api-throttles` |
| AWS Budget | Kuukausibudjetti 10 $/kk (suositus: lisää 3 $ actual ja 5 $ forecast) | AWS Budgets |

Pahin skenaario rajalla (10 req/s jatkuvasti vuorokauden, `limit=100`):
**~20–30 $/vrk**. Ilman rajausta DynamoDB-lukemat yksin voisivat maksaa
satoja euroja vuorokaudessa. Nämä testataan: `infra/test/config.test.ts`
(hälytysrajat eivät saa ylittää throttlen sallimaa maksimia).

### Hälytykset sähköpostiin (kerran)

Hälytykset menevät SNS-topiciin, jonka **tilaajat on lisättävä käsin** —
muuten kukaan ei näe niitä:

```bash
aws sns subscribe --region eu-north-1 \
  --topic-arn "arn:aws:sns:eu-north-1:132339120388:tampere360-prod-alarms" \
  --protocol email --notification-endpoint oma@esimerkki.fi
# vahvista tilaus sähköpostiin tulleesta linkistä
```

Budjetti-ilmoitukset samaan topiciin (MonitoringStackin topic policy sallii
`budgets.amazonaws.com`-julkaisun):

```bash
# 3 $ toteutunut kulu
aws budgets create-notification --account-id 132339120388 \
  --budget-name Kuukausibudjetti \
  --notification NotificationType=ACTUAL,ComparisonOperator=GREATER_THAN,Threshold=3,ThresholdType=ABSOLUTE_VALUE \
  --subscribers SubscriptionType=SNS,Address=arn:aws:sns:eu-north-1:132339120388:tampere360-prod-alarms

# 5 $ ennustettu kulu
aws budgets create-notification --account-id 132339120388 \
  --budget-name Kuukausibudjetti \
  --notification NotificationType=FORECASTED,ComparisonOperator=GREATER_THAN,Threshold=5,ThresholdType=ABSOLUTE_VALUE \
  --subscribers SubscriptionType=SNS,Address=arn:aws:sns:eu-north-1:132339120388:tampere360-prod-alarms
```

> Huom: ilman SNS-tilaajaa myös nämä ovat äänettömiä. Tarkista nykytila:
> `aws budgets describe-notifications-for-budget --account-id 132339120388 --budget-name Kuukausibudjetti`.

### Jos haluat laskea kustannuskattoa edelleen

1. **Frontendin `limit`** (`apps/web/src/api/queries.ts`) on 100 — API:n oletus
   ei siis vaikuta siihen. Pienennys (esim. 50) puolittaa DynamoDB-lukukustannuksen,
   mutta vähentää samalla Nyt-sivulla näkyvien tilanteiden määrää.
2. **CloudFront API:n eteen** ja lyhyt cache (30–60 s): imee piikit ja laskee
   sekä Lambda- että DynamoDB-kutsuja (vaatii `Cache-Control`-otsakkeen API:sta).
3. **WAF rate-based rule** (ks. §3): ~5 $/kk + pyyntömaksut.


