Kuvaamasi palvelu sopii erittäin hyvin serverless- ja tapahtumavetoiseen AWS-arkkitehtuuriin. Keskeinen suunnitteluperiaate olisi erottaa tietolähdekohtainen kerääminen yhteisestä tapahtumamallista, jotta esimerkiksi Peto voidaan myöhemmin vaihtaa uuteen pelastustoimen mediapalveluun ilman muutoksia käyttöliittymään tai muihin prosesseihin.
Suositeltu kokonaisarkkitehtuuri

Ulkoiset tietolähteet
├─ Tampere Traffic API
├─ Fintraffic REST / MQTT
├─ Poliisi RSS
├─ Pelastustoimi
├─ FMI CAP / RSS
├─ Visit Tampere / Eventz
├─ Nysse GTFS-RT / SIRI
└─ Digitraffic Rail
│
▼
EventBridge Scheduler / MQTT-yhteys
│
▼
Tietolähdekohtaiset Lambda-adapterit
│
├─ Raakadatan tallennus S3:een
│
▼
SQS ingestion queue
│
▼
Normalisointi-Lambda
│
▼
EventBridge custom event bus
│
├─ Validointi ja aluesuodatus
├─ Duplikaattien tunnistus
├─ Luokittelu ja priorisointi
├─ Geokoodaus
├─ Ilmoitukset
└─ Tilastot
│
▼
DynamoDB + S3
│
▼
API Gateway HTTP API
│
▼
React-sovellus
S3 + CloudFront + Route 53

AWS:n omissa ohjeissa EventBridge, Lambda, SQS, Step Functions ja API Gateway ovat keskeisiä serverless-tapahtuma-arkkitehtuurin rakennusosia. EventBridge Pipes soveltuu puolestaan tapahtumien suodattamiseen, rikastamiseen ja siirtämiseen palvelujen välillä. [aws.amazon.com], [docs.aws.amazon.com]
1. Tietojen kerääminen
Ajastetut lähteet

REST-, RSS-, Atom-, CAP- ja GTFS-RT-lähteet kannattaa hakea EventBridge Schedulerin käynnistämillä Lambda-funktioilla.

Esimerkkiajastukset:
Lähde	Hakuväli MVP:ssä	Toteutus
Tampere Traffic API	1 min	Scheduler → Lambda
Fintraffic REST	1–2 min	Scheduler → Lambda
Poliisi RSS	2–5 min	Scheduler → Lambda
FMI CAP	5 min	Scheduler → Lambda
Visit Tampere	15–60 min	Scheduler → Lambda
Nysse Alerts	1 min	Scheduler → Lambda
Digitraffic Rail	1–2 min	Scheduler → Lambda
Pelastustoimi	lähteen mukaan	Vaihdettava adapteri

EventBridge Scheduler tukee cron- ja rate-ajastuksia, uudelleenyrityksiä, sallittua tapahtuman enimmäisikää ja epäonnistuneiden kutsujen ohjaamista SQS DLQ -jonoon. AWS suosittelee Scheduleria ajastettujen kohteiden kutsumiseen. [docs.aws.amazon.com], [docs.aws.amazon.com], [docs.aws.amazon.com]

Jokaisella lähteellä olisi oma adapteri:

TampereTrafficAdapter
FintrafficRoadAdapter
PoliceRssAdapter
FmiCapAdapter
VisitTampereAdapter
NysseAlertAdapter
DigitrafficRailAdapter
RescueMediaAdapter

Adapteri vastaa vain näistä:

    Datan hakeminen
    Lähteen formaatin jäsentäminen
    Teknisen metadatan lisääminen
    Raakadatan tallentaminen
    Raakatapahtuman lähettäminen käsittelyjonoon

Adapterin ei pidä tehdä lopullista liiketoimintaluokittelua.
Reaaliaikaiset lähteet

Fintrafficin MQTT:n kaltaiset pitkäkestoiset yhteydet eivät ole Lambdalle yhtä luontevia kuin lyhyet HTTP-haut. Vaihtoehdot ovat:
MVP

Käytä Fintrafficin REST-rajapintaa ajastetusti. Se on yksinkertaisin, halvin ja operatiivisesti helpoin ratkaisu.
Myöhempi reaaliaikainen toteutus

Jos MQTT tuo todellista lisäarvoa, vaihtoehdot ovat:

    AWS IoT Core, jos ulkoinen MQTT-palvelu voidaan yhdistää hallitusti
    pieni jatkuvasti käynnissä oleva ECS Fargate -palvelu
    erillinen MQTT-bridge, joka julkaisee vastaanotetut viestit EventBridgeen tai SQS-jonoon

En ottaisi Fargatea käyttöön pelkästään arkkitehtuurisen puhtauden vuoksi. Minuutin välein tehtävä REST-haku on todennäköisesti Tampere247:n ensimmäiseen versioon riittävän reaaliaikainen.
2. Keräysputken rakenne

Suosittelen kahta vaihetta:

Source Lambda
│
▼
SQS Raw Event Queue
│
▼
Normalizer Lambda
│
▼
EventBridge Event Bus

Miksi SQS ennen EventBridgeä?

SQS toimii kuormaa tasaavana ja virhetilanteita eristävänä puskurina:

    lähteen hetkellinen suuri vastaus ei kuormita jatkokäsittelyä
    Lambda voi käsitellä viestit erissä
    epäonnistuneet viestit voidaan siirtää DLQ:hun
    lähteen hakeminen ja datan käsittely eivät ole tiukasti kytkettyjä
    käsittely voidaan tehdä idempotentisti
    osittain epäonnistuneen Lambda-erän viestit voidaan käsitellä uudelleen

EventBridge puolestaan toimii hyvin normalisoitujen domain-tapahtumien reitittimenä, koska tapahtumia voidaan suodattaa tyypin, vakavuuden, lähteen ja alueen mukaan.

EventBridge rules:

category = TRAFFIC
-> traffic processor

category = WEATHER
-> warning processor

severity = CRITICAL
-> notification processor

location.municipality = Tampere
-> Tampere serving model

eventType = EVENT_CANCELLED
-> removal/status processor

EventBridge Pipes voi myöhemmin vähentää omaa integraatiokoodia, sillä se tukee muun muassa suodatusta, eräkäsittelyä ja rikastamista Lambdan tai Step Functionsien avulla. [aws.amazon.com]
3. Yhteinen tapahtumamalli

Tämä on koko ratkaisun tärkein osa. Kaikki ulkoiset lähteet muunnetaan samaan Tampere247Event-malliin.

Esimerkiksi:

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
"title": {
"fi": "Liikenneonnettomuus Rantaväylällä"
},
"description": {
"fi": "Liikenne on ruuhkautunut..."
},
"location": {
"municipality": "Tampere",
"district": null,
"address": null,
"latitude": 61.498,
"longitude": 23.760,
"geometry": null,
"areaCodes": ["TAMPERE"]
},
"validity": {
"startsAt": "2026-09-06T07:30:00Z",
"endsAt": null
},
"publishedAt": "2026-09-06T07:32:00Z",
"updatedAt": "2026-09-06T07:38:00Z",
"tags": [
"onnettomuus",
"Rantaväylä"
],
"attribution": {
"name": "Tampereen kaupunki",
"required": true
}
}

Mallissa kannattaa erottaa:

    tapahtuman oma tunniste
    lähdejärjestelmän tunniste
    kanoninen duplikaattiavain
    julkaisu-, päivitys- ja voimassaoloajat
    tapahtuman tila
    vakavuus
    sijainti ja geometria
    lähde ja lisenssi
    kieliversiot
    alkuperäisen sisällön tarkiste

Tapahtuman elinkaari

Älä käsittele kaikkea vain uutena tapahtumana. Mallinna elinkaari:

DISCOVERED
→ ACTIVE
→ UPDATED
→ ENDED
→ ARCHIVED

tai

DISCOVERED
→ CANCELLED

Normalisoidut domain-tapahtumat voivat olla esimerkiksi:

SituationDiscovered
SituationUpdated
SituationEnded
SituationCancelled
SituationMerged

Tämä ratkaisee tilanteen, jossa esimerkiksi tietöiden päättymisaika muuttuu tai poliisi päivittää aiempaa tiedotetta.
4. Duplikaattien käsittely

Duplikaatit tulevat olemaan keskeinen ongelma, koska Tampereen Traffic API sisältää jo Fintrafficin tietoja. Sama onnettomuus voi lisäksi näkyä:

    Tampereen liikennetiedotteessa
    Fintrafficissa
    poliisin tiedotteessa
    Nysse-häiriönä

Duplikaattien käsittely kannattaa tehdä kahdella tasolla.
4.1 Tekninen idempotenssi

Muodosta avain:

source + sourceId + sourceRevision

tai, jos revisionumeroa ei ole:

SHA-256(source + sourceId + relevantContent)

DynamoDB-kirjoitus tehdään ehdollisena:

attribute_not_exists(processingKey)

Näin saman lähdeviestin uudelleenkäsittely ei luo uutta tapahtumaa.
4.2 Semanttinen yhdistäminen

Eri lähteistä tulevien tapahtumien yhdistäminen tehdään seuraavin perustein:

    ajallinen läheisyys
    maantieteellinen etäisyys
    tapahtumatyyppi
    otsikon ja kuvauksen yhtäläisyys
    tie-, katu-, linja- tai paikannimi
    lähteiden välinen luottamusjärjestys

MVP:ssä riittää sääntöpohjainen ratkaisu:

sama tapahtumatyyppi
AND etäisyys alle 500 metriä
AND alkamisaikojen ero alle 30 minuuttia
=> mahdollinen sama tilanne

Älä poista lähdetapahtumia. Luo niiden päälle kanoninen Situation, johon liittyy yksi tai useampi SourceEvent.

Situation
├─ Tampere Traffic source event
├─ Police source event
└─ Nysse source event

Tällöin käyttöliittymä näyttää yhden tilanteen mutta voi kertoa, että tieto on vahvistettu kolmesta lähteestä.
5. Sijaintisuodatus ja paikkatieto

Tampere247 tarvitsee vähintään kolme sijaintitasoa:

    Tampereen kunnan alue
    Tampereen seutu
    Pirkanmaa

AWS:ssa ei ole välttämätöntä ottaa heti käyttöön raskasta paikkatietokantaa. Alkuun riittää:

    Tampereen ja lähikuntien rajat GeoJSONina S3:ssa
    Lambdaan ladattu geometria
    point-in-polygon-tarkistus
    koordinaattien perusteella muodostettu geohash
    DynamoDBen kunta-, kaupunginosa- ja geohash-kentät

Jos sijainti löytyy vain tekstinä:

"Tampereella Hämeenkadun ja ..."

käsittelyjärjestys voisi olla:

    Paikan tunnistus tunnetusta katu- ja paikannimihakemistosta
    Tampereen kaupunginosan tai kunnan tunnistus
    AWS Location Servicen geokoodaus tarvittaessa
    Jos tulos on epävarma, tapahtuma merkitään locationConfidence-arvolla

Esimerkiksi:

{
"locationConfidence": 0.78,
"locationMethod": "TEXT_GEOCODING"
}

Tärkeä periaate on, ettei epävarmaa koordinaattia esitetä käyttöliittymässä varmana.
6. Tietokannat ja tallennus
DynamoDB operatiiviseksi tietokannaksi

DynamoDB sopii aktiiviseen tilannekuvaan:

    aktiiviset tapahtumat
    tulevat tapahtumat
    tapahtuman yksityiskohdat
    lähdekohtaiset tilat
    duplikaattiavaimet
    käyttäjän mahdolliset suosikit ja tilaukset

Suosittelen vähintään kolmea loogista kokonaisuutta:
Situations

Kanoniset käyttöliittymässä näkyvät tilanteet.
SourceEvents

Alkuperäisestä lähteestä normalisoidut tapahtumat.
IngestionState

Lähdekohtainen tekninen tila:

{
"source": "POLICE_RSS",
"lastSuccessfulFetch": "2026-09-06T07:35:00Z",
"etag": "...",
"lastModified": "...",
"cursor": null,
"status": "OK"
}

Taulut voidaan toteuttaa joko erillisinä DynamoDB-tauluina tai single-table-mallina. Valitsisin ensimmäiseen versioon erilliset taulut, koska niiden käyttötarkoitukset, säilytysajat ja indeksit ovat erilaiset.
S3 raakadataksi ja historiaksi

Jokainen onnistuneesti haettu lähdevastaus kannattaa tallentaa S3:een:

s3://tampere247-raw/
source=tampere-traffic/
year=2026/month=09/day=06/hour=10/
source=police-rss/
source=fmi-cap/

Hyödyt:

    lähdeadapteri voidaan ajaa uudelleen vanhaa dataa vasten
    normalisointia voidaan kehittää ilman uutta ulkoista hakua
    virhetilanteita voidaan tutkia
    audit trail säilyy
    myöhempi analytiikka on mahdollista
    lähteen muuttuminen voidaan todentaa

Aseta S3 Lifecycle:

    aktiivinen raakadata esimerkiksi 30–90 päivää
    sen jälkeen Glacier-luokkaan
    tai poisto lähteen käyttöehtojen ja oman tarpeen perusteella

OpenSearch vasta myöhemmin

Amazon OpenSearch Serverless voi olla perusteltu, kun tarvitaan:

    vapaasanahaku
    relevanssijärjestys
    suodatus monilla samanaikaisilla ehdoilla
    tekstin samankaltaisuushaku
    edistyneet geohaut

MVP:tä varten DynamoDB-indeksit riittävät todennäköisesti:

GSI1: status + startsAt
GSI2: category + startsAt
GSI3: municipality + startsAt
GSI4: geohash + startsAt

7. Backend API

React-sovellukselle sopii:

API Gateway HTTP API
│
▼
Query Lambda
│
▼
DynamoDB

Esimerkkirajapinnat:

GET /v1/situations
GET /v1/situations/{id}
GET /v1/map
GET /v1/categories
GET /v1/sources
GET /v1/health/sources

Listausrajapinnan parametreja:

GET /v1/situations
?category=TRAFFIC,WEATHER
&status=ACTIVE
&area=TAMPERE
&from=2026-09-06T00:00:00Z
&to=2026-09-07T00:00:00Z
&limit=50
&cursor=...

Käytä cursor-pohjaista sivutusta, älä offset-sivutusta.

API Gateway HTTP API on REST API -tuotetta kevyempi ja edullisemmaksi suunniteltu vaihtoehto. Se tukee Lambda-integraatiota, CORS-asetuksia sekä OAuth 2.0- ja OpenID Connect -auktorisointia. [docs.aws.amazon.com]
Reaaliaikaiset päivitykset käyttöliittymään

MVP:ssä React voi päivittää listan esimerkiksi 30–60 sekunnin välein. Tämä on usein täysin riittävä.

Myöhemmin vaihtoehdot ovat:

    API Gateway WebSocket API
    AWS AppSync -subscriptionit
    Server-Sent Events erillisellä toteutuksella

En ottaisi WebSocketeja ensimmäiseen versioon, ellei vaatimus ole näyttää muutoksia muutaman sekunnin sisällä.
8. React-frontend

Frontend voidaan toteuttaa näin:

Route 53
│
CloudFront + AWS WAF
│
Private S3 bucket
│
React SPA

CloudFront voi jakaa S3:ssa olevat HTML-, CSS-, JavaScript- ja kuvatiedostot reunapalvelimilta, ja S3-origin voidaan pitää yksityisenä. [docs.aws.amazon.com]

Frontendissä käyttäisin esimerkiksi:

    React
    TypeScript
    Vite
    TanStack Query
    React Router
    MapLibre GL JS tai Leaflet
    Vitest
    MSW integraatiotestien API-mockaukseen

TanStack Query hoitaa käyttöliittymässä:

    välimuistin
    taustapäivitykset
    retry-logiikan
    cursor-sivutuksen
    vanhan datan näyttämisen päivityksen aikana

Mahdolliset näkymät:

    Nyt: aktiiviset häiriöt ja varoitukset
    Tänään: tapahtumat ja ennakoidut häiriöt
    Kartta
    Liikenne
    Säävaroitukset
    Kulttuuri ja tapahtumat
    Joukkoliikenne
    Lähteiden tila

9. Lähdekohtaiset ratkaisut

Nysse tarjoaa dokumentaation mukaan GTFS Realtime -syötteissä muun muassa Trip Updates-, Vehicle Position- ja Alert-tiedot. Alert-syötteen enimmäishakutiheydeksi on dokumentoitu 60 sekuntia, ja lisäksi tarjolla on SIRI General Message -rajapinta. [dev.public...tampere.fi]

Poliisin sivulla on erillinen Sisä-Suomen poliisilaitoksen RSS-syöte sekä päivittyvien uutisten yleinen RSS-syöte. [poliisi.fi]

Suosittelisin seuraavaa priorisointia:
Lähde	MVP	Huomio
Tampere Traffic API	Kyllä	Ensisijainen liikenteen lähde
Poliisi RSS	Kyllä	Sisä-Suomen syöte
FMI CAP	Kyllä	Aluesuodatus Pirkanmaa/Tampere
Visit Tampere	Kyllä	Tulevat yleisötapahtumat
Nysse Alerts	Kyllä	Ei ajoneuvosijainteja vielä
Pelastustoimi	Adapteri valmiiksi	Lähde vaihdettavissa
Fintraffic Road	Vaihe 2	Täydentävä ja varmistava lähde
Digitraffic Rail	Vaihe 2	Tampereen aseman häiriöt
Liikennekamerat	Vaihe 2	Näytä lähin kamera
MQTT	Vaihe 2–3	Vain jos REST-viive ei riitä
Liikennevalodata	Ei MVP	Edellyttää trendianalyysiä
Sähkö ja vesi	Ei MVP	Luotettava häiriölähde puuttuu

Tampere Traffic API:n ja Fintrafficin dataa ei kannata näyttää rinnakkain sellaisenaan. Ensimmäisessä versiossa käyttäisin Tampereen rajapintaa ensisijaisena lähteenä ja Fintrafficia myöhemmin täydentävänä tai puuttuvien tapahtumien tarkistuslähteenä.
10. Pelastustoimen vaihtuva lähde

Tätä varten kannattaa määritellä rajapinta kooditasolla:

interface EventSourceAdapter {
readonly source: SourceSystem;

fetch(context: FetchContext): Promise<RawSourceBatch>;

parse(batch: RawSourceBatch): Promise<ParsedSourceEvent[]>;

checkpoint(batch: RawSourceBatch): Promise<SourceCheckpoint>;
}

Pelastuslähteen vaihtaminen tarkoittaa silloin vain uutta toteutusta:

PetoAdapter
korvataan
RescueMediaAdapter

Normalisoija ja käyttöliittymä näkevät molemmilta saman tyypin:

RESCUE_INCIDENT

Adapterien lähdekohtaiset konfiguraatiot kannattaa pitää Parameter Storessa:

/tampere247/prod/sources/rescue/enabled
/tampere247/prod/sources/rescue/base-url
/tampere247/prod/sources/rescue/poll-interval

Salaisuudet, kuten API-avaimet, kuuluvat Secrets Manageriin.
11. Virheenkäsittely ja uudelleenajo

Jokaiseen asynkroniseen vaiheeseen tarvitaan:

    rajattu retry exponential backoffilla
    DLQ
    idempotentti käsittely
    tapahtuman correlation ID
    CloudWatch-hälytykset
    käsittelemättömän datan säilytys

EventBridge voi ohjata epäonnistuneet toimitukset SQS DLQ -jonoon, jolloin virheen aiheuttanut tapahtuma voidaan tutkia ja käsitellä myöhemmin uudelleen. [docs.aws.amazon.com]

Lisäksi custom event bus kannattaa arkistoida ainakin rajatulla säilytysajalla. EventBridge Archive tukee tapahtumien suodattamista, määritettävää säilytysaikaa ja arkistoitujen tapahtumien uudelleenajoa. [docs.aws.amazon.com], [docs.aws.amazon.com]

Esimerkki:

Source Scheduler DLQ
Raw Ingestion DLQ
Normalization DLQ
Domain Event Delivery DLQ

Älä tee yhtä yhteistä DLQ:ta kaikelle. Lähdevaihe ja normalisointi tarvitsevat erilaiset korjaustoimet.
12. Valvonta

CloudWatch-dashboardiin ainakin:
Lähdekohtaiset mittarit

    viimeisin onnistunut haku
    haettujen tietueiden määrä
    uusien tapahtumien määrä
    lähteen HTTP-vastausaika
    virheiden määrä
    peräkkäiset epäonnistumiset
    datan ikä
    rakenteeltaan virheellisten tapahtumien määrä

Putken mittarit

    SQS-jonon pituus
    vanhimman viestin ikä
    Lambda errors ja throttles
    DLQ-viestit
    normalisointiviive
    EventBridge failed invocations
    DynamoDB throttling

Liiketoimintamittarit

    aktiiviset tilanteet kategorioittain
    lähteittäin vastaanotetut tapahtumat
    yhdistettyjen duplikaattien määrä
    ilman sijaintia jääneiden osuus
    epävarmasti geokoodattujen osuus
    lähteen julkaisusta käyttöliittymään kulunut aika

Hälytyksiä:

Poliisi RSS ei päivittynyt 30 minuuttiin
Tampere Traffic API epäonnistui 5 kertaa
FMI-data on yli 15 minuuttia vanhaa
DLQ:ssa on vähintään yksi viesti
Normalisointijonon vanhin viesti yli 5 minuuttia

13. Tietoturva

Vaikka data on julkista, palvelu on julkisesti internetissä, joten toteuttaisin vähintään:

    CloudFront + AWS WAF
    S3 Block Public Access
    CloudFront Origin Access Control
    API Gateway throttling
    tarkat CORS-säännöt
    Lambda-roolikohtainen least privilege IAM
    KMS-salaus vähintään omalle tapahtuma- ja käyttäjädatalle
    Secrets Manager API-avaimille
    CloudTrail
    AWS Config tai Security Hub tuotantoympäristössä
    riippuvuuksien haavoittuvuusskannaus CI-putkessa
    CSP- ja muut selaimen suojausotsakkeet CloudFrontissa

Lähteistä saatava HTML tulee puhdistaa ennen esittämistä. RSS-kuvauksia ei pidä viedä Reactiin käsittelemättömänä dangerouslySetInnerHTML-sisältönä.
14. Infrastructure as Code

Valitsisin tähän AWS CDK v2:n TypeScriptillä, koska:

    frontend ja backend ovat TypeScriptiä
    infrastruktuuri voidaan jakaa uudelleenkäytettäviin constructeihin
    Lambda-tyypit ja event contractit voidaan jakaa paketeissa
    CDK synthesoi infrastruktuurin CloudFormationiksi
    infra voidaan yksikkötestata

AWS CDK tukee infrastruktuurin määrittelyä TypeScriptillä ja provisioi resurssit CloudFormationin kautta. AWS nostaa hyödyiksi muun muassa lähdekoodihallinnan, testauksen, code review'n sekä uudelleenkäytettävät constructit. [docs.aws.amazon.com]

Repository voisi olla:

tampere247/
apps/
web/
api/
ingest-tampere-traffic/
ingest-police/
ingest-fmi/
ingest-events/
ingest-nysse/
normalize/
packages/
event-contracts/
source-adapter-sdk/
observability/
test-fixtures/
infra/
bin/
lib/
frontend-stack.ts
api-stack.ts
ingestion-stack.ts
event-processing-stack.ts
data-stack.ts
monitoring-stack.ts
security-stack.ts
docs/
architecture/
adr/

Stack-jako:

FoundationStack
DataStack
EventingStack
IngestionStack
ApiStack
FrontendStack
MonitoringStack

Kaikkia Lambda-funktioita ei kuitenkaan kannata tehdä omaksi CDK-stackikseen. CloudFormation-riippuvuuksien hallinta muuttuu silloin turhan monimutkaiseksi.
15. CI/CD

Suositeltu putki:

Pull request:
npm ci
lint
unit tests
contract tests
cdk synth
cdk diff
security checks
frontend build

Main branch:
deploy dev
integration tests
smoke tests
manual approval
deploy prod
smoke tests

Ympäristöt:

dev
test
prod

Mieluiten omiin AWS-tileihinsä ainakin:

non-production account
production account

GitHub Actionsista tai Azure DevOpsista AWS:ään kirjaudutaan OIDC-roolilla. Pitkäikäisiä AWS access key -avaimia ei tallenneta CI-järjestelmään.
16. Konkreettinen MVP

Tekisin ensimmäisen version seuraavasti:
Lähteet

    Tampere Traffic API
    Poliisi RSS
    FMI CAP
    Visit Tampere
    Nysse Alerts
    Tyhjäksi tai kokeelliseksi merkitty Rescue Media -adapteri

AWS-palvelut

S3 + CloudFront
API Gateway HTTP API
Lambda
EventBridge Scheduler
EventBridge custom event bus
SQS + DLQ
DynamoDB
S3 raw archive
CloudWatch
AWS CDK

MVP:n ulkopuolelle

    OpenSearch
    AI-luokittelu
    WebSocketit
    Fintraffic MQTT
    liikennevalojen analyysi
    live-ajoneuvokartta
    sähkö- ja vesihäiriöt
    automaattiset käyttäjäilmoitukset

Lopullinen suositus

Paras perusrakenne Tampere247:lle olisi:

Ajastettu tai stream-pohjainen lähde
→ lähdeadapteri
→ raakadata S3:een
→ SQS
→ yhteiseen malliin normalisointi
→ EventBridge
→ validointi, sijaintisuodatus ja deduplikointi
→ DynamoDB
→ API Gateway + Lambda
→ React / CloudFront

Ratkaisun tärkeimmät arkkitehtuuripäätökset ovat:

    Yhteinen, lähderiippumaton tapahtumamalli
    Raakadatan pysyvä tallennus uudelleenkäsittelyä varten
    SQS käsittelypuskurina ja EventBridge domain-tapahtumien reitittimenä
    Idempotenssi kaikissa kuluttajissa
    Kanonisen tilanteen erottaminen yksittäisistä lähdetapahtumista
    Pelastustoimen toteuttaminen vaihdettavana adapterina
    DynamoDB MVP:n ensisijaisena operatiivisena tietokantana
    CDK v2 TypeScriptillä koko infrastruktuurin hallintaan

Tällä rakenteella palvelu pysyy alkuvaiheessa varsin yksinkertaisena mutta kestää myöhemmin Fintraffic MQTT:n, live-kartan, ilmoitukset, vapaasanahaun ja uusien tietolähteiden lisäämisen ilman kokonaisarkkitehtuurin uusimista.
