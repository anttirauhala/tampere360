# Hätäohje: API:n tiukka rajoittaminen (kustannuspiikki)

Tämä ohje on tarkoitettu tilanteeseen, jossa Tampere360:n kustannukset alkavat
kasvaa odottamattomasti (väärinkäyttö, skannaus, oma pollausvirhe) ja API:n
liikennettä pitää rajoittaa **heti**, ilman pitkää deploy-kierrosta.

**Periaate:** rajoita kerroksittain ja aloita halvimmasta. Kustannusjärjestys
tässä palvelussa on:

1. **Frontendin pollaus → DynamoDB-lukemat** (30 s välein per avoin selain)
2. API Gateway + Lambda (per-pyyntö-hinta)
3. Keräysputki (adapterit + normalisointi, 1–5 min välein) — pieni
4. Tallennus (S3/DynamoDB) — käytännössä merkityksetön

> API:n sulkeminen yksin ei pysäytä kohtaa 1, jos frontend jää pyörimään
> (se vain saa virheitä). Keräysputki (kohta 3) pyörii myös ilman API:a.

**Kiireellisyysjärjestys:**

| Tilanne | Tee tämä |
|---|---|
| Kulu kasvaa nopeasti, syytä ei vielä tiedossa | Vaihe 0 (mittaa) → Vaihe 1 profiili **B** (1 req/s) |
| Selvästi väärinkäyttö / skannaus API:a vasten | Vaihe 1 profiili **B** + tarvittaessa **C** (Lambda kiinni) |
| Oma liikenne (frontend/bugi) | Vaihe 3 (CloudFront pois) — suurin vaikutus |
| Kulu jatkaa kasvua rajoista huolimatta | Kulu ei tule API:sta → Vaihe 0 uudelleen, laajempi selvitys |

Kaikki Vaiheen 1–3 komennot ovat **peruttavissa yhdellä komennolla** (ks. §5).

---

## 0. Selvitä ensin kulun lähde (2 minuuttia)

Älä sulje vääriä asioita. Hae API-id ja tarkista mittarit:

```bash
# API-id (prod / dev)
aws apigatewayv2 get-apis --region eu-north-1 \
  --query "Items[?Name=='tampere360-prod-api'].ApiId" --output text
aws apigatewayv2 get-apis --region eu-north-1 \
  --query "Items[?Name=='tampere360-dev-api'].ApiId" --output text
# 20.9.2026: prod = e75dymdxu4, dev = vllod80b6i

START=$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M:%SZ); END=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 1) API-pyynnöt (kpl / 5 min)
aws cloudwatch get-metric-statistics --region eu-north-1 \
  --namespace AWS/ApiGateway --metric-name Count \
  --dimensions Name=ApiId,Value=e75dymdxu4 Name=Stage,Value='$default' \
  --start-time "$START" --end-time "$END" --period 300 --statistics Sum \
  --query 'sort_by(Datapoints,&Timestamp)[-8:].[Timestamp,Sum]' --output text

# 2) Query-Lambdan invokaatiot ja virheet
aws cloudwatch get-metric-statistics --region eu-north-1 \
  --namespace AWS/Lambda --metric-name Invocations \
  --dimensions Name=FunctionName,Value=tampere360-prod-api \
  --start-time "$START" --end-time "$END" --period 300 --statistics Sum \
  --query 'sort_by(Datapoints,&Timestamp)[-8:].[Timestamp,Sum]' --output text

# 3) DynamoDB-lukemat HUOM: GSI-kohtaisesti (pelkkä TableName näyttää nollaa!)
for IDX in gsi1-status-startsAt gsi2-category-startsAt; do
  echo "--- $IDX"
  aws cloudwatch get-metric-statistics --region eu-north-1 \
    --namespace AWS/DynamoDB --metric-name ConsumedReadCapacityUnits \
    --dimensions Name=TableName,Value=tampere360-prod-situations \
                 Name=GlobalSecondaryIndexName,Value=$IDX \
    --start-time "$START" --end-time "$END" --period 3600 --statistics Sum \
    --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text
done
```

Tulkinta:

| Havainto | Johtopäätös |
|---|---|
| API `Count` suuri + Lambda invokaatiot yhtä suuret | Liikenne tulee API:n kautta → Vaihe 1 |
| API `Count` pieni, mutta DynamoDB-lukemat suuret | Jokin muu lukee taulua (oma putki/koodi) → tarkista Lambdat |
| Kaikki pienet, mutta lasku kasvaa | Kulu ei tule tästä palvelusta (sama AWS-tili!) → Cost Explorer, ks. §8 |

---

## 1. Välitön rajoitus sekunneissa (ei deployta)

API Gateway HTTP API:ssa rajoitus on **vain stage-tasolla** (HTTP API ei tue
reittikohtaista throttlausta), joten nämä kaksi vipua riittävät.

### Profiilit

| Profiili | Asetus | Vaikutus | API-osuuden katto |
|---|---|---|---|
| **A – kevyt** | 2 req/s, purske 4 | Palvelu toimii; yksittäinen tykittäjä ei pääse läpi | ~0,17 $/vrk |
| **B – tiukka** | 1 req/s, purske 1 | Vain satunnainen liikenne menee läpi, loput **429** | ~0,09 $/vrk |
| **C – kiinni** | B + Lambda-concurrency 0 | API vastaa virhettä; Lambda ja DynamoDB eivät kuluta lainkaan | ~0,09 $/vrk |

### Profiili A / B — rajoita stage

```bash
# B (tiukka) — suositeltu hätätilanteessa
aws apigatewayv2 update-stage --region eu-north-1 \
  --api-id e75dymdxu4 --stage-name '$default' \
  --default-route-settings '{"ThrottlingRateLimit":1,"ThrottlingBurstLimit":1}'

# A (kevyt)
aws apigatewayv2 update-stage --region eu-north-1 \
  --api-id e75dymdxu4 --stage-name '$default' \
  --default-route-settings '{"ThrottlingRateLimit":2,"ThrottlingBurstLimit":4}'
```

Ylimenevä liikenne saa HTTP 429, **eikä Lambda- tai DynamoDB-kutsuja synny**.
API Gateway veloittaa silti jokaisesta pyynnöstä (~1 $/M), mutta raja pitää
pyyntömäärän kurissa: 1 req/s = enintään 86 400 pyyntöä/vrk ≈ 0,09 $/vrk.
Ilman rajaa 100 req/s voisi kuluttaa kymmeniä euroja vuorokaudessa.

### Profiili C — sulje myös Lambda

```bash
aws lambda put-function-concurrency --region eu-north-1 \
  --function-name tampere360-prod-api --reserved-concurrent-executions 0
```

`reserved-concurrent-executions 0` estää **kaikki** invokaatiot: Lambda ja
DynamoDB eivät kuluta yhtään ja API vastaa 5xx. Käytä, jos pelkkä 1 req/s ei
riitä (esim. liikenne läpäisee rajan ja sekin on liikaa).

### Vaihe 1:n varmistus

```bash
aws apigatewayv2 get-stages --region eu-north-1 --api-id e75dymdxu4 \
  --query 'Items[].DefaultRouteSettings'
# → {"ThrottlingRateLimit": 1.0, "ThrottlingBurstLimit": 1}

aws lambda get-function-concurrency --region eu-north-1 \
  --function-name tampere360-prod-api
# → {"ReservedConcurrentExecutions": 0}      (vain profiili C)

# Käytännön testi: 20 nopeaa kutsua → suurin osa 429
for i in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code} ' \
  https://api.tampere247.online/v1/categories; done; echo
```

**Käyttäjille näkyvä vaikutus:** frontend näyttää virhetilan
("Tilannetietojen haku epäonnistui" / "API-virhe 429"). Se on odotettua.

**Hälytykset laukeavat** (`api-request-spike`, `api-client-errors`,
`api-throttles`, `errors-api`) — ne ovat nyt seuraus, eivät uusi ongelma.

---

## 2. Keräysputken pysäytys (jos kulu tulee putkesta)

Putki pyörii API:sta riippumatta: adapterit 1–5 min välein, normalisointi SQS:n
tahtiin, siivous 5 min välein. Siistein tapa pysäyttää se on **ajastusten
poiskytkentä** (uutta dataa ei kerry, eikä virhehälytyksiä synny).

⚠️ **Älä sammuta `normalize`-Lambdaa ensin.** Jos adapterit tuottavat yhä
viestejä jonoon, ne päätyvät 5 vastaanoton jälkeen `ingestion-dlq`-jonoon
(näkyvyysaika 360 s → ~30 min) ja ne on myöhemmin ajettava käsin takaisin.
Oikea järjestys: **(1) lähteet seis → (2) jonon annetaan tyhjentyä →
(3) vasta sitten muut Lambdat.**

```bash
GROUP=tampere360-prod-sources

# 1) Lähteiden ajastukset pois päältä
for s in $(aws scheduler list-schedules --region eu-north-1 --group-name $GROUP \
             --query 'Schedules[].Name' --output text); do
  EXPR=$(aws scheduler get-schedule --region eu-north-1 --group-name $GROUP \
           --name "$s" --query 'ScheduleExpression' --output text)
  aws scheduler update-schedule --region eu-north-1 --group-name $GROUP \
    --name "$s" --schedule-expression "$EXPR" \
    --flexible-time-window '{"Mode":"OFF"}' --state DISABLED
  echo "DISABLED $s"
done

# 2) Tilanteiden siivous seis (eri ryhmä: default)
EXPR=$(aws scheduler get-schedule --region eu-north-1 --group-name default \
         --name tampere360-prod-situation-expiry --query 'ScheduleExpression' --output text)
aws scheduler update-schedule --region eu-north-1 --group-name default \
  --name tampere360-prod-situation-expiry --schedule-expression "$EXPR" \
  --flexible-time-window '{"Mode":"OFF"}' --state DISABLED

# 3) Jonon pituus (odota, että viestit menevät nollaan)
aws cloudwatch get-metric-statistics --region eu-north-1 --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=tampere360-prod-ingestion \
  --start-time "$(date -u -d '-20 min' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --period 300 --statistics Maximum \
  --query 'sort_by(Datapoints,&Timestamp)[-3:].[Timestamp,Maximum]' --output text

# 4) Vasta tarvittaessa käsittely-Lambdat kiinni
for fn in normalize situation-processor situation-expiry; do
  aws lambda put-function-concurrency --region eu-north-1 \
    --function-name "tampere360-prod-$fn" --reserved-concurrent-executions 0
done
```

> Vaihtoehto: pelkkä adapterien (`ingest-*`) concurrency 0 riittää myös —
> silloin ajastukset käynnistyvät turhaan, mutta hakua ei tapahdu.

---

## 3. Frontendin pysäytys — suurin yksittäinen kuluerä

Frontend pollaa 30 sekunnin välein per avoin selain, ja jokainen pollaus lukee
DynamoDB:stä kymmeniä itemeitä. Kovalla liikenteellä tämä on **isoin kuluerä** —
API:n rajoittaminen yksin ei pysäytä sitä.

```bash
# 1) Hae jakelun id
aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Comment,'Tampere360 prod')].[Id,Comment]" --output table

ID=<jakelun-id>
ETAG=$(aws cloudfront get-distribution-config --id "$ID" --query 'ETag' --output text)
aws cloudfront get-distribution-config --id "$ID" --query 'DistributionConfig' > /tmp/cf-config.json
python3 -c "import json;p='/tmp/cf-config.json';d=json.load(open(p));d['Enabled']=False;json.dump(d,open(p,'w'))"
aws cloudfront update-distribution --id "$ID" --if-match "$ETAG" \
  --distribution-config file:///tmp/cf-config.json
```

CloudFront päivittyy 1–3 minuutissa; sen jälkeen sivusto ei lataudu (403/503)
eikä pollausta tapahdu. Palautus: sama rutiini arvolla `d['Enabled']=True`.

Vaihtoehto: koko frontend-stack alas — web-bucket on `RETAIN`, joten sisältö
säilyy:

```bash
cd infra && npx cdk destroy tampere360-prod-frontend -c env=prod --region eu-north-1
```

---

## 4. Koko API pois päältä (raskaampi keino)

```bash
cd infra
npx cdk destroy tampere360-prod-api -c env=prod --region eu-north-1
```

| Asia | Vaikutus |
|---|---|
| Poistaa | HTTP API, custom domain `api.tampere247.online`, API:n ACM-sertifikaatti (eu-north-1), Route 53 -tietueet |
| Data | **Ei katoa** — Situations/SourceEvents/IngestionState ovat eri stackissa ja `RETAIN`-suojattuja |
| Frontend | Jää toimimaan, mutta API-kutsut epäonnistuvat (virhetila) |
| Palautus | `npx cdk deploy tampere360-prod-api -c env=prod -c wafEnabled=false --region eu-north-1` (sertifikaatin DNS-validointi ~2–3 min) |

> Pelkkä Route 53 -tietueen poisto **ei riitä**: suora
> `*.execute-api.*.amazonaws.com`-osoite jää auki.

---

## 5. Palautus normaalitilaan

| Asia | Normaaliarvo (koodissa) | Palautus |
|---|---|---|
| Stage-throttlaus | **10 req/s**, purske 20 | `update-stage … --default-route-settings '{"ThrottlingRateLimit":10,"ThrottlingBurstLimit":20}'` |
| Query-Lambda | varattu concurrency **5** | `put-function-concurrency … --reserved-concurrent-executions 5` |
| Muut Lambdat | ei varausta | `aws lambda delete-function-concurrency --function-name tampere360-prod-<nimi>` |
| Ajastukset | `ENABLED` | `update-schedule … --state ENABLED` (sama rutiini kuin §2) |
| CloudFront | `Enabled=true` | sama rutiini kuin §3 |

**Nopein ja varmin palautus koko ympäristölle:**

```bash
npm run deploy:prod     # CDK palauttaa throttlen, concurrencyt ja ajastukset koodin mukaiseksi
```

⚠️ Tämä tarkoittaa myös: **manuaaliset hätärajat eivät kestä seuraavaa
deployta.** Pysyvä kiristys tehdään koodissa — `infra/lib/config.ts`
(`API_THROTTLE`, `QUERY_RESERVED_CONCURRENCY`, `EXPIRY_SWEEP_MINUTES`) ja
deploy. Silloin arvot ovat versionhallinnassa ja regressiosuojan piirissä
(`infra/test/config.test.ts`).

---

## 6. Mitä ei pidä tehdä hätätilanteessa

| Älä | Miksi |
|---|---|
| Poista DynamoDB-tauluja tai S3-bucketteja | Tietojen menetys. `RETAIN` pitää ne myös stackin poiston jälkeen, joten ne jäisivät roikkumaan. |
| Muuta S3-lifecyclea tai EventBridge-arkistoa | Ei vaikuta akuuttiin kuluun, mutta rikkoo datan säilytyksen ja uudelleenajon. |
| Poista API Gateway -stagea käsin | CloudFormation ei palauta sitä hallitusti → seuraava deploy voi kaatua. Käytä throttlea (§1) tai Lambdaa (§1 C). |
| Muokkaa CloudFrontia ilman `--if-match "$ETAG"` | Päivitys epäonnistuu tai ylikirjoittaa toisen muutoksen. |
| Oleta, että kulu tulee tästä palvelusta | Sama AWS-tili sisältää dev-ympäristön, WAF:n (jos päällä), muut projektit ja koko tilin budjetin. |

---

## 7. Seuranta rajoituksen aikana

```bash
START=$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%SZ); END=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# API-pyynnöt ja 4xx (sis. 429) / 5 min
for M in Count 4xx 5xx; do
  echo "--- $M"
  aws cloudwatch get-metric-statistics --region eu-north-1 \
    --namespace AWS/ApiGateway --metric-name $M \
    --dimensions Name=ApiId,Value=e75dymdxu4 Name=Stage,Value='$default' \
    --start-time "$START" --end-time "$END" --period 300 --statistics Sum \
    --query 'sort_by(Datapoints,&Timestamp)[-6:].[Timestamp,Sum]' --output text
done

# Lambda-throttlaukset (kertoo, että varattu concurrency on täynnä)
aws cloudwatch get-metric-statistics --region eu-north-1 \
  --namespace AWS/Lambda --metric-name Throttles \
  --dimensions Name=FunctionName,Value=tampere360-prod-api \
  --start-time "$START" --end-time "$END" --period 300 --statistics Sum \
  --query 'sort_by(Datapoints,&Timestamp)[-6:].[Timestamp,Sum]' --output text

# DynamoDB-lukemat GSI-kohtaisesti
aws cloudwatch get-metric-statistics --region eu-north-1 \
  --namespace AWS/DynamoDB --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=tampere360-prod-situations \
               Name=GlobalSecondaryIndexName,Value=gsi1-status-startsAt \
  --start-time "$START" --end-time "$END" --period 300 --statistics Sum \
  --query 'sort_by(Datapoints,&Timestamp)[-6:].[Timestamp,Sum]' --output text
```

Hälytykset ja niiden tila:

```bash
aws cloudwatch describe-alarms --region eu-north-1 \
  --alarm-name-prefix tampere360-prod \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}' --output table
```

Dashboard: CloudWatch → `tampere360-prod-pipeline`.

---

## 8. Jos kulu jatkaa kasvua rajoituksista huolimatta

Silloin kulu **ei tule tästä API:sta**. Sama AWS-tili sisältää muitakin
kulueriä, joten selvitä laajemmin:

```bash
# Kulut palveluittain (viimeiset 7 vrk)
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -d '-7 days' +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[-1]' --output json
```

Tagipohjainen erittely (`project=tampere360` on kaikissa Tampere360-resursseissa)
vaatii, että tagi on aktivoitu Cost Explorerissa (Billing → Cost allocation tags).
Sen jälkeen:

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -d '-7 days' +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY --metrics UnblendedCost \
  --group-by Type=TAG,Key=project
```

Huomioitavaa:

- **Budjetti `Kuukausibudjetti` (10 $/kk) on koko tilin budjetti** — se ei kerro,
  mikä projekti kuluttaa. Tagi-rajattu budjetti (`project=tampere360`) antaisi
  oikean kuvan.
- Jos liikenne on selvästi väärinkäyttöä eikä laannu, pysyvämmät torjuntakeinot
  ovat: **WAF rate-based rule** CloudFrontin eteen (vaatii
  `cdk bootstrap aws://<tili>/us-east-1` + ~5 $/kk) tai **CloudFront-välimuisti
  API:n eteen** (30–60 s cache laskee DynamoDB-lukuja ~95 %).

---

## 9. Pikanäppäimet

**PROD — tiukka rajoitus (profiili B):**

```bash
API=e75dymdxu4
aws apigatewayv2 update-stage --region eu-north-1 --api-id $API --stage-name '$default' \
  --default-route-settings '{"ThrottlingRateLimit":1,"ThrottlingBurstLimit":1}'
```

**PROD — lisäksi Lambda kiinni (profiili C):**

```bash
aws lambda put-function-concurrency --region eu-north-1 \
  --function-name tampere360-prod-api --reserved-concurrent-executions 0
```

**PROD — palautus:**

```bash
API=e75dymdxu4
aws apigatewayv2 update-stage --region eu-north-1 --api-id $API --stage-name '$default' \
  --default-route-settings '{"ThrottlingRateLimit":10,"ThrottlingBurstLimit":20}'
aws lambda put-function-concurrency --region eu-north-1 \
  --function-name tampere360-prod-api --reserved-concurrent-executions 5
```

**DEV — sama logiikka:** API-id `vllod80b6i`, funktio `tampere360-dev-api`.

---

## 10. Tarkistuslista hätätilanteeseen

- [ ] Kulun lähde selvitetty (§0 mittarit — älä sokeasti sulje)
- [ ] Rajoitus asetettu: profiili A (2 req/s) / B (1 req/s) / C (+Lambda kiinni)
- [ ] Varmistettu: `get-stages` ja `get-function-concurrency`
- [ ] Tarvittaessa keräysputki seis oikeassa järjestyksessä (§2)
- [ ] Tarvittaessa frontend seis (§3)
- [ ] Todettu, että laukenneet hälytykset ovat seuraus (ei uusi vika)
- [ ] Tilanteen päätyttyä: palautus (§5) + `npm run deploy:prod`
- [ ] Jatkotoimenpide päätetty: pysyvä kiristys koodiin, WAF vai CloudFront-välimuisti

---

## Liittyvät dokumentit

- [`docs/architecture/prod-deploy.md`](./architecture/prod-deploy.md) — käyttöönotto,
  valvonta ja kustannussuojien normaalitilat (§8)
- [`.clinerules/implementation_plan.md`](../.clinerules/implementation_plan.md) —
  §14 (tietoturva ja rajoitukset), §20–§23 (toteutuksen aikana korjatut asiat)
- Koodi: `infra/lib/config.ts` (`API_THROTTLE`, `QUERY_RESERVED_CONCURRENCY`,
  `EXPIRY_SWEEP_MINUTES`), `apps/api/src/params.ts` (`limit`)
