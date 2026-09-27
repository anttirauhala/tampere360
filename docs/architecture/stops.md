# Nysse-pysäkit ja pysäkkimonitori (`/v1/stops`, `/v1/stops/{stopId}/departures`)

> Tila: toteutettu 27.9.2026 (Vaihe 4+, ks.
> `.clinerules/implementation_plan.md` §28).
> Deploy: `tampere360-dev-api`, `tampere360-dev-monitoring`,
> `tampere360-dev-frontend` (vain dev).

## Tehtävä

Näyttää Nysse-kartalla (`/nysse-kartta`) pysäkit ja avata pysäkin klikkauksesta
sidepanel, jossa on pysäkin reaaliaikaiset lähdöt. Pysäkit ovat oletuksena
piilossa ("Näytä pysäkit" -valinta), koska niitä on 3 423.

Ominaisuus on tarkoituksella pieni: **ei** ajoneuvon seurantaa, reitin
seuraamista, suosikkeja eikä aikatauluhistoriaa.

## Kaksi eri dataa — kaksi eri välimuistia

```
GTFS static (stops.txt)          Waltti SIRI StopMonitoring
        ↓                                    ↓
GET /v1/stops                     GET /v1/stops/{stopId}/departures
        ↓                                    ↓
pysäkkikerros kartalla            sidepanelin lähtölista
  cache 6 h (Lambda)                cache 15 s (Lambda)
  selain 24 h                       selain 15 s
```

Ajoneuvot pysyvät ennallaan: **`/v1/vehicles` ei käytä StopMonitoring-dataa**
eikä sen toteutusta muutettu (§28 kohta 5).

## Tietolähteet

| Asia | Arvo |
|---|---|
| Pysäkit | Tampereen/Nyssen GTFS-static: `https://data.itsfactory.fi/journeys/files/gtfs/latest/gtfs_tampere.zip` (ITS Factory, CC BY 4.0) |
| Pysäkkien määrä | 3 423 (verifioitu 27.9.2026); kentät `stop_id`, `stop_name`, `stop_lat`, `stop_lon` |
| Lähdöt | Waltti SIRI **StopMonitoring** v1.3: `POST https://data.waltti.fi/tampere/api/sirirealtime/v1.3/ws` (Basic-auth) |
| Avain | SSM `/tampere360/{env}/sources/nysse/api-key` — **sama** kuin ajoneuvoissa ja Nysse-adapterissa |
| Päivitysväli | Waltti: SM 30 s, VM 1 s (dokumentoitu) |

### SIRI StopMonitoring: kaksi helppoa ansaa

1. **`PreviewInterval` on pakollinen.** Ilman sitä Walttin yhdyskäytävä vastaa
   `HTTP 406` tyhjällä vastauksella — virhe näyttää siltä kuin SM-palvelua ei
   olisi olemassa, vaikka sama päätepiste palvelee VehicleMonitoringia
   ongelmitta. Toimiva pyyntö (Nyssen kehittäjäportaalin dokumentaatiosta):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <Siri xmlns="http://www.siri.org.uk/siri" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         version="1.3" xsi:schemaLocation="http://www.kizoom.com/standards/siri/schema/1.3/siri.xsd">
     <ServiceRequest>
       <StopMonitoringRequest version="1.3">
         <PreviewInterval>PT60M00S</PreviewInterval>
         <MonitoringRef>0015</MonitoringRef>
       </StopMonitoringRequest>
     </ServiceRequest>
   </Siri>
   ```

2. **Yksi `StopMonitoringRequest` per pysäkki** (enintään 100 pyyntöä
   kerrallaan). `MonitoringRef` on **GTFS `stop_id`** (esim. `0015`), joten
   pysäkkirekisteri ja reaaliaikainen kysely osuvat samaan tunnisteavaruuteen.
   Tämä on syy käyttää juuri GTFS-static-aineistoa: SIRI ei anna pysäkkien
   koordinaatteja eikä luetteloa.

### Vastauksen rakenne ja käsittely

```
Siri/ServiceDelivery/StopMonitoringDelivery
 ├─ ResponseTimestamp / ValidUntil (~30 s)
 └─ MonitoredStopVisit[]
     ├─ RecordedAtTime, MonitoringRef, StopVisitNote (pysäkin nimi)
     └─ MonitoredVehicleJourney
         ├─ LineRef, DestinationName, OriginName, Monitored, Delay
         ├─ MonitoredCall → Aimed/Expected Arrival/DepartureTime, VehicleAtStop
         └─ OnwardCalls (leikataan pois ennen jäsennystä)
```

`<OnwardCalls>` on vastauksen suurin osa (vuoron kaikki seuraavat pysäkit) eikä
sisällä pysäkin lähtötietoja. Jos siivottu dokumentti ei tuota yhtään vuoroa,
jäsennetään koko dokumentti — lähdemuutos ei siis muutu hiljaiseksi tyhjäksi
monitoriksi (sama periaate kuin §27:ssä).

Lähtölistan muodostus (`apps/stops/src/departures.ts`):

1. lähtöaika = `ExpectedDepartureTime` → `AimedDepartureTime` →
   `ExpectedArrivalTime` → `AimedArrivalTime` (§20: aikaleimoja ei arvata)
2. menneet lähdöt pois **30 sekunnin armovälillä**; vuoro, jonka lähde kertoo
   olevan pysäkillä juuri nyt (`VehicleAtStop`), pidetään aina
3. järjestys lähtöajan mukaan, enintään 20 riviä
4. `delaySeconds` näytetään vain reaaliaikaisesta vuorosta (`Monitored = true`)

## Rajapinta

```
GET /v1/stops                    → GeoJSON FeatureCollection (3 423 pysäkkiä)
GET /v1/stops/0015/departures    → yhden pysäkin lähdöt
GET /v1/stops/<virheellinen>     → 400 {"error":"INVALID_STOP_ID"}
```

`/v1/stops` palauttaa **valmiin GeoJSONin** (kuten `/v1/vehicles`), jotta
kartalla on yksi lähde ja klusterointi tapahtuu selaimessa:

```json
{
  "type": "FeatureCollection",
  "source": "NYSSE_GTFS",
  "fetchedAt": "2026-09-27T10:05:00.000Z",
  "stale": false,
  "count": 3423,
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [23.76152, 61.49754] },
      "properties": { "id": "0015", "name": "Keskustori D" }
    }
  ]
}
```

Koordinaatit pyöristetään **viiteen desimaaliin** (~1 m), mikä pienentää
vastausta selvästi ilman käytännön tarkkuusmenetystä.

Lähtövastaus:

```json
{
  "stop": { "id": "0015", "name": "Keskustori D", "latitude": 61.49779, "longitude": 23.76058 },
  "departures": [
    {
      "routeShortName": "3",
      "destination": "Hervanta",
      "scheduledTime": "2026-09-27T10:02:00.000Z",
      "expectedTime": "2026-09-27T10:02:19.000Z",
      "delaySeconds": 59,
      "realtime": true
    }
  ],
  "generatedAt": "2026-09-27T10:05:19.171Z",
  "fetchedAt": "2026-09-27T10:05:20.100Z",
  "stale": false
}
```

**Tunniste validoidaan ennen SIRI-kutsua** (`^[A-Za-z0-9:_-]{1,24}$`) ja arvo
escapetaan pyyntöön: tunniste upotetaan XML:ään, joten polusta ei saa voida
syöttää XML-rakennetta. Virheellinen tunniste on `400`, ei "tyhjä pysäkki".

`stop` on `null` vain, jos pysäkkiä ei löydy muistissa olevasta rekisteristä
eikä SIRI-vastauksesta. Nimen takia **ei** ladata 17 Mt:n GTFS-pakettia: nimi
otetaan SIRI:n `StopVisitNote`-kentästä, jos rekisteri ei ole vielä muistissa.
Frontend tuntee pysäkin joka tapauksessa kartalta.

## Kustannusmalli

| Suoja | Arvo (`infra/lib/config.ts`) | Tehtävä |
|---|---|---|
| `STOP_CACHE_MS` | 15 000 | reaaliaikaiset lähdöt: N selainta → enintään yksi Waltti-kutsu / 15 s / lämmin kontti |
| `STOP_STALE_MAX_MS` | 60 000 | virhetilanteessa näytetään viimeisin vastaus, ei tyhjää listaa |
| `STOP_CACHE_MAX_ENTRIES` | 200 | muisti ei kasva rajatta, kun pysäkkejä klikataan paljon (vanhin avain poistuu) |
| `STOP_RESERVED_CONCURRENCY` | 2 | oma katto, erillään query-Lambdasta (5) ja ajoneuvoista (2) |
| `GTFS_STOPS_CACHE_MS` | 6 h | 17 Mt:n zip ladataan ja puretaan käytännössä kerran kontin elinaikana (~171 ms mitattu) |
| `GTFS_STOPS_STALE_MAX_MS` | 7 vrk | pysäkkirekisteri ei katoa, vaikka lähde olisi hetken alhaalla |
| `GTFS_STOPS_TIMEOUT_MS` | 15 s | selvästi Lambdan 25 s timeoutia lyhyempi |

Lähtölista palvellaan **vain valitulle pysäkille** — kaikkien pysäkkien
lähtötietoja ei haeta etukäteen. Mitatut vasteajat devissä 27.9.2026:
`/v1/stops` 3,0 s kylmänä (sisältää GTFS-latauksen) ja **0,28 s** lämpimänä;
`/v1/stops/0015/departures` 0,9 s kylmänä ja ~0,3 s lämpimänä.

## Frontend

| Osa | Ratkaisu |
|---|---|
| Kerros | yksi GeoJSON-lähde + 4 kerrosta: klusteriympyrä, klusterin lukumäärä, yksittäinen pysäkki, valitun pysäkin korostus |
| Klusterointi | MapLibren oma (`cluster: true`, radius 50, `clusterMaxZoom: 14`) → klusterit hajoavat zoomilla 15 |
| Klusterin lukumäärä | `text-field: ['get','point_count_abbreviated']` (esim. `1.2k`); **glyph-lähde** `tiles.openfreemap.org/fonts/...` on jo sallittu CSP:ssä karttatiilien takia, joten CSP:tä ei tarvinnut muuttaa |
| Visuaalinen ero | pysäkit valkoisia ympyröitä, klusterit kelta-oransseja (`#f59e0b`) — ajoneuvot ovat vihreitä/sinisiä ikoneita linjanumerolla |
| Klikkaus | klusteri → `getClusterExpansionZoom` + `easeTo` (ei avaa paneelia); yksittäinen pysäkki → sidepanel |
| Kerrosten järjestys | pysäkkikerrokset lisätään ajoneuvokerrosten **alle** (`beforeId`) |
| Tila | `showStops` (oletus false) ja `selectedStopId` (`null` = paneeli kiinni); valinnan sammuttaminen sulkee paneelin |
| Pollaus | lähdöt 15 s, vain kun pysäkki on valittu; taustavälilehti ei pollaa |

Sidepanel (`components/StopPanel.tsx`) näyttää pysäkin nimen ja tunnisteen,
lähtölistan (linja · määränpää · aika) sekä päivitysajan. Lataus-, virhe- ja
tyhjä tila ovat omia selkeitä tilojaan, ja paneelin voi sulkea sulkunapista tai
Esc-näppäimellä.

Aikatauluvuorot (ei reaaliaikaista seurantaa) merkitään `≈`-etuliitteellä, ja
selite näytetään vain jos listalla on sellaisia — muuten käyttäjä luulisi
aikataulun mukaista aikaa havaintoon perustuvaksi ennusteeksi (§20).

### Karttakontrollit vasemmalle (27.9.2026)

Pysäkin sidepanel avautuu kartan **oikeaan** reunaan, joten MapLibren kontrollit
siirrettiin vasempaan reunaan (`components/MapView.tsx`):

```ts
map.addControl(new NavigationControl({ showCompass: false }), 'top-left');
map.addControl(new AttributionControl({ compact: true }), 'bottom-left');
```

Syy löytyi selainverifioinnissa: MapLibren kontrollisäiliöllä
(`.maplibregl-ctrl-top-right`) on `z-index: 2`, joten oikeassa reunassa ollut
zoom-painike piirtyi **sidepanelin päälle** ja peitti sulkunapin. Klikkaus
kohdistui zoom-painikkeeseen, ei sulkunappiin — virhe oli täysin hiljainen eikä
konsolissa näkynyt mitään. Todennus:

```js
document.elementFromPoint(closeBtn.x, closeBtn.y).className
// ennen: "maplibregl-ctrl-group button"  (zoom-painike päällimmäisenä)
// nyt:   "stop-panel__close"            (sulkunappi päällimmäisenä)
```

Kontrollien siirto poisti päällekkäisyyden kokonaan: paneeli ei peitä enää
mitään kontrollia, ja zoomaus toimii myös paneelin ollessa auki. Kartan
attribuutiokontrolli olisi peitossa vain, jos paneeli venytettäisiin kartan
alareunaan asti — OSM-attribuutio on siksi myös sivun footerissa, joten
vaatimus täyttyy joka tapauksessa.

## Testit

```
apps/stops/src/gtfs.test.ts         CSV-jäsennys, koordinaattien uskottavuus, zip-purku
apps/stops/src/siri-sm.test.ts      pyynnön muoto (PreviewInterval!), jäsennys, OnwardCalls
apps/stops/src/departures.test.ts   järjestys, armoväli, VehicleAtStop, reaaliaikaisuus
apps/stops/src/cache.test.ts        TTL, in-flight de-dupe, stale, peek, muistin raja
apps/stops/src/params.test.ts       tunnisteen validointi (myös XML-injektio)
apps/stops/src/stop-points.test.ts  GeoJSON, pyöristys, hakemisto
apps/web/src/lib/stops.test.ts      lähtöajan muotoilu, sävyt, kellonaika (Suomen aika)
infra/test/config.test.ts           välimuistien erillisyys ja kustannuskatot
```

Aja: `npm test` (koko sarja 298 testiä 27.9.2026).

## Selainverifiointi (dev, 27.9.2026)

Headless Chrome (CDP), puhdas sivulataus osoitteessa
`https://d36ic5wsx4b9yl.cloudfront.net/nysse-kartta`. Karttaolio haettiin
React-fiberistä, jotta tarkistukset tehtiin MapLibren omilla API:lla
(`querySourceFeatures`, `queryRenderedFeatures`, `project`).

| Vaihe | Tulos |
|---|---|
| Pysäkit oletuksena | valintaruutu **ei** valittu, klustereita ruudulla 0 ✅ |
| "Näytä pysäkit" | `Näytä pysäkit (3423)`, `GET /v1/stops` **200** ✅ |
| Klusterointi zoomilla 11 | lähteessä 223 featurea joista **216 klusteria**, ruudulla 27 klusteriympyrää ✅ |
| Klusterin lukumäärä | glyph-pyyntö `tiles.openfreemap.org/fonts/Noto Sans Bold/0-255.pbf` → **200** ✅ |
| Klusterin klikkaus | zoom 11,00 → **12,20**, sidepanelia **ei** avattu ✅ |
| Zoom 16 | lähteessä 21 featurea, **0 klusteria**, 4 yksittäistä pysäkkiä renderöity ✅ |
| Pysäkin klikkaus | sidepanel: `🚏 Lielahden koulu`, `Pysäkki 1409`, lähdöt `21 Ryydynpohja 7 min` ja `≈ 36 min`, päivitysaika 13.49.58 ✅ |
| Reaaliaikakysely | `GET /v1/stops/1409/departures` **200** (vain valitulle pysäkille) ✅ |
| Valinnan korostus | `stops-selected`-kerros renderöi 1 renkaan ✅ |
| Sulkunappi | `elementFromPoint` = `stop-panel__close` → paneeli sulkeutui, korostus poistui ✅ |
| Esc-näppäin | avasi uudelleen ja sulki ✅ |
| Karttakontrollit | zoom **top-left**, attribuutio **bottom-left**, top-right tyhjä ✅ |
| Konsoli / CSP | **0 konsolivirhettä**, **0 CSP-rikkomusta** ✅ |
| Regressio `/kartta` | 3 tilannemarkerit, popup aukesi ("Itsenäisyydenkatu, Tampere. Liikennetiedote."), kontrollit vasemmalla, 0 virhettä ✅ |

Kuvat otettiin headless-Chromella (`Page.captureScreenshot`); ne eivät ole
versionhallinnassa. Kuvista tarkistettiin myös, että taustakuva on tasainen ja
että klusteriympyröissä on lukumäärä (glyphit) eikä pelkkiä ympyröitä.

## Walttin 500-virheet ja reaaliaikapeitto (27.9.2026)

**Oire:** osalla pysäkeistä pysäkkimonitori näytti virheen
`Lähtötietojen haku epäonnistui: API-virhe 502 (/v1/stops/6154/departures)`.

**Mittaus:** Walttin SIRI-yhdyskäytävä (`POST …/sirirealtime/v1.3/ws`) vastasi
**HTTP 500** ja rungoksi `Something went wrong`. Kaksi eri syytä:

| Havainto | Mittaus |
|---|---|
| **Tilapäinen lähdevirhe** | Pysäkit 6154, 6155 ja 1027 epäonnistuivat lokissa 27.9.2026 klo 11:21–11:24 (10 + 8 + 2 virhettä), mutta **saman päivän suora testi antoi 200** kolmella peräkkäisellä yrityksellä. Kyse ei siis ollut pysäkistä vaan hetkellisestä lähdevirheestä. |
| **Pysäkki puuttuu Walttin reaaliaikarekisteristä** | Satunnaisotannassa **2 / 60 pysäkkiä** (6833, 6837) vastasi 500 myös **24 tunnin `PreviewInterval`illa** — pysyvä ominaisuus. Samoin muotoon sopimattomat tunnisteet `9999` ja `HQ:1`. |

Rajattu pois: kuormitusrajausta ei ole (20 peräkkäistä + 10 rinnakkaista pyyntöä
→ kaikki 200), eikä SIRI-tason pysäkkirekisteriä ole käytettävissä
(`StopPointsDiscovery` samaan päätepisteeseen → 500). Waltti ei kerro syytä
rungossa, joten "tuntematon pysäkki" ja "hetkellinen vika" ovat vastauksesta
**täysin samannäköisiä**.

### Korjaus: kolme osaa

| Osa | Toteutus |
|---|---|
| **Uusintayritys** | `apps/stops/src/retry.ts`: yksi uusinta 250 ms viiveellä **vain 5xx- ja verkkovirheille** (4xx = oma pyyntö on väärä, ei uusita). Tilapäiset virheet eivät enää näy käyttäjälle. |
| **Peiton oppiminen** | `apps/stops/src/coverage.ts`: kun pysäkille saadaan `failureThreshold` (3) peräkkäistä virhettä 2 minuutin sisällä **ja jokin toinen pysäkki on vastannut samana aikana**, pysäkki merkitään 30 minuutiksi "ei reaaliaikapeittoa". Merkinnän ajan Walttiin ei soiteta: vastaus on rehellinen `200 { realtimeCoverage: false }`. Merkintä vanhenee itsestään, joten tilanne korjautuu ilman uudelleenkäynnistystä. |
| **Rehellisempi virhevastaus** | Ennen merkintää vastaus on **503 + `Retry-After: 15`** (aiemmin 502). 503 kertoo, että lähde ei vastannut, ja selain saa yrittää uudelleen. |
| **Jäähdytys epäonnistumisille** | `cache.ts`: epäonnistuneelle pysäkille ei soiteta uudelleen 30 sekuntiin (`STOP_FAILURE_COOLDOWN_MS`), jos tarjolla ei ole vanhaa arvoa. Ilman tätä jokainen selaimen 15 sekunnin pollaus olisi lähettänyt **kaksi uutta yritystä** Walttiin (`retry.ts`) loputtomiin. Vanha arvo ohittaa jäähdytyksen, koska tuoreus voittaa. |

**Miksi "jokin toinen pysäkki on vastannut" -ehto:** ilman sitä koko Walttin
katkos merkitsisi kaikki pysäkit ilman peittoa. Ehto rajaa merkinnän tilanteeseen,
jossa yhdyskäytävä vastaa muille pysäkeille mutta ei tälle → vika on
pysäkkikohtainen.

**Miksi 200 eikä virhe:** pysäkki on olemassa (se on GTFS-rekisterissä ja
kartalla), mutta sen reaaliaikaisia lähtöjä ei ole olemassa. Se on **tieto**,
jota ei pidä esittää virheenä eikä kehottaa yrittämään uudelleen — uusi yritys ei
muuta tilannetta.

### Frontend

| Osa | Muutos |
|---|---|
| `api/client.ts` | `ApiError` kuljettaa HTTP-tilakoodin oliona (`apiErrorStatus(error)` lukee sen; tekstivarmistus säilyy varalla) |
| `lib/stops.ts` | `stopDeparturesNotice(status)` → rauhallinen teksti; `NO_REALTIME_COVERAGE_TEXT` peitottomalle pysäkille |
| `components/StopPanel.tsx` | Virhe näytetään luettavana huomautuksena **ilman** teknistä `API-virhe 502` -tekstiä, mukana **"Yritä uudelleen"** -painike. `realtimeCoverage === false` → tiedoksi-tyylinen huomautus (ei virhe). |
| `components/StopPanel.tsx` (nykäisyn esto) | TanStack Query nollaa `error`in uuden yrityksen alkaessa, joten pelkkä `error`-tarkistus piilottaisi huomautuksen joka 15 sekunnin pollauksella (ja väläyttäisi virheellisesti "Ei lähtöjä seuraavan tunnin aikana"). Viimeisin huomautus pidetään `useRef`issä ja näytetään uusinnan ajan — painike lukee silloin **"Haetaan…"**. |
| `styles.css` | `.state--info`, `.state__retry`, `.stop-panel__notice` |

Käyttäjälle näkyvät tekstit:

- lähde ei vastannut: *"Lähtötietoja ei juuri nyt saada tälle pysäkille — lähde
  (Waltti) ei vastannut. Yritämme uudelleen automaattisesti."* + **Yritä uudelleen**
- peitoton pysäkki: *"Waltti ei tarjoa tälle pysäkille lähtötietoja, joten
  reaaliaikaista aikataulua ei ole näytettävissä."*

### Konfiguraatio (ympäristömuuttujat)

| Muuttuja | Oletus | Merkitys |
|---|---|---|
| `STOP_RETRY_ATTEMPTS` | 2 | yritysten kokonaismäärä |
| `STOP_RETRY_BACKOFF_MS` | 250 | tauko yritysten välissä |
| `STOP_FAILURE_COOLDOWN_MS` | 30000 | epäonnistuneen pysäkin uudelleenyrityksen jäähdytys |
| `STOP_COVERAGE_FAILURE_THRESHOLD` | 3 | peräkkäiset virheet ennen merkintää |
| `STOP_COVERAGE_WINDOW_MS` | 120000 | ikkuna, jonka sisällä virheet lasketaan |
| `STOP_COVERAGE_TTL_MS` | 1800000 | merkinnän voimassaolo (30 min) |
| `STOP_COVERAGE_MAX_ENTRIES` | 500 | muistissa pidettävät pysäkit |

### Testit

`retry.test.ts` (11: uusinta 5xx:llä, ei 4xx:llä, verkkovirhe, viimeisen virheen
heitto, `onRetry`), `coverage.test.ts` (11: kynnys, ikkuna, "toinen pysäkki
vastasi" -ehto, onnistumisen nollaus, TTL, muistin rajaus),
`cache.test.ts` (+5: jäähdytys, jäähdytyksen umpeutuminen, onnistumisen
nollaus, vanhan arvon etusija, jäähdytyksen poiskytkentä),
`apps/web/src/lib/stops.test.ts` (+5: ettei teknistä virhekoodia enää näytetä),
`apps/web/src/api/client.test.ts` (4: tilakoodin luku oliosta ja tekstistä).

### Verifiointi 27.9.2026

**1. API (curl, dev):**

| Tilanne | Tulos |
|---|---|
| Tavallinen pysäkki (1409, 1027, 6154, 6155) | `200`, `realtimeCoverage: true`, lähdöt mukana ✅ |
| Peitoton pysäkki (6833) ennen merkintää | `503 UPSTREAM_UNAVAILABLE`, vastausaika ~0,5 s = **2 yritystä + 250 ms tauko** ✅ |
| Sama pysäkki uudelleen 15 s kuluttua | `503`, mutta **0,07 s** (jäähdytys: upstream-kutsua ei tehdä) ✅ |
| Peitoton pysäkki merkinnän jälkeen | `200`, `realtimeCoverage: false`, `departures: []`, ~0,07 s ✅ |
| Virheellinen tunniste / tuntematon polku | `400 INVALID_STOP_ID` / `404` ✅ |
| Lokit | `Waltti SIRI SM uudelleenyritys` (10), `Pysäkki merkitty ilman reaaliaikapeittoa` (1), `…upstream-kutsu ohitetaan` (2) ✅ |

Peitottomien pysäkkien osuus mitattiin kahdella satunnaisotoksella (60 + 140
pysäkkiä): **6 / 200 ≈ 3 %** (6833, 6837, 6340, 6350, 6470, 9429, 9433).

**2. Selain (headless Chrome + CDP, pysäkki 9433):**

| Vaihe | Tulos |
|---|---|
| Ennen merkintää | `VIRHE: Lähtötietoja ei juuri nyt saada tälle pysäkille — lähde (Waltti) ei vastannut. Yritämme uudelleen automaattisesti.` + **Yritä uudelleen** ✅ |
| Tekninen virheteksti DOM:issa | **ei yhtään** `API-virhe`-osumaa ✅ (regressio korjattu) |
| "Yritä uudelleen" -klikkaus | nappi lukee **"Haetaan…"** ja huomautus pysyy näkyvissä (6/6 sekunnin näyte: `nakyy`) — ei enää välähdystä "Ei lähtöjä" ✅ |
| Merkinnän jälkeen (t+14 s … t+70 s) | `TIETO: Waltti ei tarjoa tälle pysäkille lähtötietoja, joten reaaliaikaista aikataulua ei ole näytettävissä.` — ei virhettä, ei uusintanappia ✅ |
| Verkkopyynnöt | `9433:503` ×4 → `9433:200` ×5 (merkinnän jälkeen upstream-kutsuja ei enää tehdä) ✅ |
| Tavallinen pysäkki (1409) samassa istunnossa | 2 lähtöriviä, ei huomautuksia ✅ |
| Konsoli | vain selaimen omat `Failed to load resource: 503` -rivit (odotettuja 5xx-vastauksia), **ei JS-virheitä** |
| CSP-rikkomukset | **0** ✅ |

## Käyttöönotto ja vianetsintä

```bash
API=https://<api-id>.execute-api.eu-north-1.amazonaws.com

# Pysäkkirekisteri (3 423 pysäkkiä, ~430 kt)
curl -s "$API/v1/stops" | jq '{count, stale}'

# Yhden pysäkin lähdöt
curl -s "$API/v1/stops/0015/departures" | jq '{stop, count: (.departures|length)}'

# Virheellinen tunniste → 400
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/stops/0015%3Cscript%3E/departures"

# Lambdan lokit
aws logs tail /aws/lambda/tampere360-dev-stops --follow --region eu-north-1
```

| Oire | Syy |
|---|---|
| `502 UPSTREAM_UNAVAILABLE` | SSM-avain puuttuu tai Waltti/ITS Factory ei vastaa |
| Lähtölista aina tyhjä mutta `200` | Waltti palauttaa vuorot vain liikennöintiaikana; tarkista `visits`-määrä lokista |
| `406` Walttilta lokissa | `PreviewInterval` puuttuu pyynnöstä |
| Klusterit näkyvät, lukumäärä ei | Glyph-lähde ei lataudu (CSP/origin) — ympyrät piirtyvät silti |
| Pysäkit eivät ilmesty lainkaan | "Näytä pysäkit" ei ole valittu, tai `/v1/stops` palautti virheen |
| Paneeli ei avautunut klikkauksesta | kerroskohtaiset kuuntelijat rekisteröitiin ennen kerrosta — sama ansa kuin §27.1.1:ssä |
| Paneelin sulkunappi ei toimi | karttakontrollit ovat oikeassa reunassa ja piirtyvät paneelin päälle (`z-index: 2`). Kontrollit kuuluvat vasemmalle (`top-left`/`bottom-left`) |
| Lähdöt eivät päivity | Selain pollaa 15 s; taustavälilehdellä pollaus on pois päältä |


