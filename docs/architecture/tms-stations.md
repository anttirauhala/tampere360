# Liikenteen mittausasemat (`/v1/tms/stations`)

> Tila: toteutettu 27.9.2026 (ks. `.clinerules/implementation_plan.md` §30).
> Deploy: `tampere360-dev-api`, `tampere360-dev-monitoring`,
> `tampere360-dev-frontend` (vain dev).

## Tehtävä

Näyttää Tampereen seudun **liikenteen mittausasemien** (TMS = Traffic
Measurement System / LAM) reaaliaikainen nopeus ja liikennemäärä sekä
asemakohtainen historia. Tavoite on vastata kysymykseen *"miltä liikenne näyttää
juuri nyt ja miten se on kehittynyt"* — ei siis tuottaa tilanteita tai
hälytyksiä.

Tämä on ensimmäinen **Fintraffic Road** -tason toteutus (arkkitehtuuri §9:
"Fintraffic Road — vaihe 2"). Toisin kuin aiemmat liikennetiedotteet, data ei
tule tapahtumamallin kautta eikä sitä tallenneta DynamoDB:hen: mittaukset ovat
hetkellistä dataa ja tilastot luetaan lähteestä tarvittaessa.

## Miksi tätä ei haettu kolmannen osapuolen API:sta

Selvityksen kohteena oli `anttirauhala/traffic-stations`
(Digitraffic LAM -kerääjä, CDK + SQS + DynamoDB + API Gateway + React).
Se todettiin toimivaksi mutta **ei sopivaksi tuotantoriippuvuudeksi**:

| Havainto 27.9.2026 | Seuraus |
|---|---|
| `GET /api/traffic/station/{id}/daily` palauttaa aina 0 riviä (GSI:n partition key on koko ISO-aikaleima, mutta kysely käyttää pelkkää päivää) | osa rajapinnasta on rikki |
| `hourly-average` toimii, mutta on heidän oma laskelmansa kuukauden jaksolta | sama tieto + enemmän saadaan virallisesta lähteestä |
| Kerääjä ajaa kerran tunnissa; dynamo-taulussa vain `timeWindowStart`-suodatetut arvot | data on osajoukko |
| Ei API-avainta eikä usage plania CDK-stackissa | ei tunnettua kiintiötä eikä SLA:ta |
| Sivun oma teksti: *"Kaikki oikeudet pidätetään"* | ristiriita oman CC BY -attribuutiomallin kanssa |

**Ratkaisu:** luetaan sama data suoraan Digitrafficilta, joka on sen alkuperäinen
lähde ja jonka kanssa meillä on jo käytössä oleva malli (kelikamerat §25).

## Tietolähteet

| Asia | Arvo |
|---|---|
| Asemaluettelo | `GET https://tie.digitraffic.fi/api/tms/v1/stations` (simplified) |
| Aseman metatiedot | `GET .../api/tms/v1/stations/{id}` (detailed: kunta, `names.fi`, suunnat, `freeFlowSpeed1/2`) |
| Reaaliaika | `GET .../api/tms/v1/stations/data` — **kaikki asemat yhdellä kutsulla** |
| Historia | `GET .../api/tms/v1/history` (CSV, sama rajapinta Digitrafficin oman tilastotyökalun takana) |
| Tunnistautuminen | `Digitraffic-User: Tampere247` (ei avainta) |
| Lisenssi | Fintraffic / Digitraffic, CC BY 4.0 |

### Mitatut koot ja viiveet (27.9.2026)

| Kutsu | Siirto (gzip) | Purettu | Aika |
|---|---|---|---|
| `/stations` (518 asemaa) | ~100 kt | — | 0,3 s |
| `/stations/data` (518 asemaa) | **144 kt** | 3,4 Mt | 0,25 s |
| `/stations/{id}/data` (yksi asema) | 859 t | ~9 kt | 0,25 s |
| `/history` (14 vrk, yksi asema) | ~1 kt | — | 0,3 s |

**Yksi kutsu kaikille asemille valittiin 20 asemakohtaisen kutsun sijaan:**
siirtoa on enemmän (144 kt vs. 17 kt), mutta pyyntöjä 20× vähemmän ja
vikatilanteita on yksi retry-polku. 20 rinnakkaista kutsua olisi 20 erillistä
timeouttia ja osittaisten epäonnistumisten kokoelma.

## Kytkentä: `piste` ei ole asematunnus

Historiarajapinta käyttää parametria `piste`, joka on aseman **`tmsNumber`**
(esim. 438) — ei TMS-rajapintojen `id` (esim. 23438). Kytkentä on virallinen
kenttä, ei arvaus:

```
TMS id 23438  →  tmsNumber 438  =  history piste 438
```

Testattu 27.9.2026 kaikilla 21 Tampereen seudun asemalla: **20/21 täsmäsi
nimen perusteella** (poikkeus oli käytöstä poistettu `DSL6L`).
Kutsuja rakennetaan `historyQuery()`-funktiossa, joka käyttää aina
`tmsNumber`ia.

Historia-rajapinnan parametrit, jotka toteutus lukitsee:

| Parametri | Arvo | Miksi |
|---|---|---|
| `api` | `liikennemaara` \| `keskinopeus` | määrät ja nopeudet ovat eri rajapintoja |
| `tyyppi` | `vrk` \| `h` \| `kk` | vuorokausi, tunti, kuukausi |
| `pvm` / `loppu` | `YYYY-MM-DD` / tyhjä | aikaväli (vrk) tai yksittäinen jakso |
| `lam_type` | `option1` | `option1` = yksi asema, `option2` = asemajoukko |
| `piste` | `tmsNumber` | ks. yllä |

## Aluesuodatus

`REGION_BOUNDS` (apps/tms-stations/src/region.ts): lat 61,3–61,7 / lon
23,5–24,0 → **Tampereen seutu** (mukana Tampere, Nokia, Pirkkala, Ylöjärvi,
Kangasala, Lempäälä). Rajaus osuu 21 asemaan, joista **19 on keruussa
(`GATHERING`)** ja vain ne näytetään.

**Miksi koordinaattirajaus eikä kunta:** simplified-listassa ei ole
`municipality`-kenttää, ja detailed-haku tehdään vain rajauksen läpäisseille
asemille (yksi pyyntö per asema). Koordinaatit ovat siis portti, kunnat ovat
näytettävää tietoa.

## Sujuvuusarvio (oma luokittelu)

```
suhde = nopeus / vapaa ajon nopeus (freeFlowSpeed)
  ≥ 0,75  → SUJUVAA
  ≥ 0,50  → HIDASTUNUT
  < 0,50  → RUUHKAUTUNUT
```

Kolme tarkoituksellista rajausta:

1. **Matalan liikennemäärän suoja:** jos liikennemäärä on alle 60 kpl/h
   (1 auto/min), luokka on `TUNTEMATON`. Muuten yöllinen yksittäinen hidas auto
   näyttäisi "ruuhkalta".
2. **Puuttuva tieto ei ole nolla:** jos nopeus, vapaa nopeus tai liikennemäärä
   puuttuu, luokka on `TUNTEMATON` (ei arvausta).
3. **Luokittelu kerrotaan käyttäjälle omana arvionamme** sekä kortilla
   (teksti + väri) että sivun alaviitteessä — sama periaate kuin tilanteiden
   vakavuusluokittelussa (§24).

Anturit valitaan suunnittain paremmuusjärjestyksessä:
`KESKINOPEUS_5MIN_LIUKUVA_SUUNTA{n}` → `…_KIINTEA_…`,
`OHITUKSET_5MIN_LIUKUVA_SUUNTA{n}` → `…_KIINTEA_…`.

## Lähteen latenssin vaihtelu ja uusintayritys (havaittu 27.9.2026)

Historia-rajapinta (`/api/tms/v1/history`) on **latenssiltaan epävakaa**: sama
kutsu mitattiin Noden fetchillä sekä **45 ms** että **7 597 ms**. Reaaliaika- ja
metatietorajapinnat eivät tätä tee (144 kt vastaus tuli 0,6 s:ssa joka kerta).

Seuraus ja korjaus:

| Havainto | Korjaus |
|---|---|
| Lambda aikakatkaisi 10 s:ssa ja käyttäjä näki 503:n (`TimeoutError` lokissa, `loadSpeed`) | yrityskohtainen timeout **8 s** + **yksi uusintayritys** 400 ms tauolla (ks. `apps/tms-stations/src/retry.ts`) |
| Yksi hidas osa kaatoi koko historian (`Promise.all`) | `Promise.allSettled`: yhden osan epäonnistuminen → `partial: true` ja tyhjä sarja, muut kuvaajat näkyvät |
| Kolme rinnakkaista selainpyyntöä throttlautui kylmällä Lambdalla | selain tekee **yhden** pyynnön (`type=all`); Lambdan sisäinen rinnakkaisuus ei kuluta varattua concurrencya |

Uusintayritys osuu tyypillisesti lämmenneeseen lähteeseen (toinen yritys vastasi
93 ms), joten hidas vastaus korjautuu ilman että käyttäjä huomaa mitään.
Pahin mahdollinen kokonaisaika on `2 × 8 s + 0,4 s = 16,4 s`, mikä mahtuu
Lambdan 20 s timeoutiin — tämä on varmistettu testillä
(`infra/test/config.test.ts`).

**Miksi 4xx ei uusita:** se tarkoittaa, että *pyyntömme* on väärä, joten sama
pyyntö tuottaisi saman tuloksen.

## Kylmäkäynnistys ja throttlaus (havaittu 27.9.2026)

Ensimmäinen kutsu kylmällä kontilla kestää **2–4 s** (metatietojen kokoaminen:
518 aseman lista + ~20 detailed-hakua rinnakkain + 144 kt reaaliaikahaku),
minkä jälkeen vastaus tulee välimuistista **0,08–0,8 s**. Kahden rinnakkaisen
kylmän kutsun sarjassa mitattiin 4,1 s (tilannekuva) ja 5,3 s (historia).

Kuuden rinnakkaisen kutsun sarja tuotti **503 `{"message": "Service Unavailable"}`**
— vastaus tuli API Gatewayltä, ei meidän Lambdaltamme (oma 503 on
`{"error": "UPSTREAM_UNAVAILABLE"}`). Syy: Lambda-throttlaus, kun varattu
concurrency (2) loppui kesken kylmäkäynnistysten. Sama ilmiö on havaittu aiemmin
muillakin reiteillä (esim. `/v1/vehicles`) — se ei siis ole tämän reitin bugi.

Kaksi korjausta:

| Korjaus | Miksi |
|---|---|
| Selain tekee enää **kaksi** kutsua sivun avauksella (tilannekuva + `type=all`-historia) kolmen sijaan | kylmän kontin throttlaus syntyi rinnakkaisten kutsujen määrästä, ei yksittäisestä kutsusta — rinnakkaisuus siirrettiin Lambdan sisään, missä se ei kuluta varattua concurrencya |
| `TMS_RESERVED_CONCURRENCY` **3** (oli 2) | kaksi sivun omaa kutsua + yksi varalasku (toinen välilehti tai uudelleenlataus) |

**Diagnoosimenetelmä:** `{"message": ...}`-muotoinen runko + nopea vasteaika
(0,07 s) + lokissa onnistunut invokaatio ilman virheriviä = throttlaus, ei
sovellusvirhe. Katso myös edellä "Lähteen latenssin vaihtelu ja uusintayritys"
— sama 503 näkyi käyttäjälle myös silloin, kun *lähde* oli hidas, ja se
korjataan eri mekanismilla (uusinta + `partial`).

## Välimuistit (kolme eri nopeutta)

| Data | TTL | Vanhentumisen enimmäisikä | Perustelu |
|---|---|---|---|
| Reaaliaikasnapshot | **60 s** | 5 min | lähde päivittyy minuutin välein; 144 kt haku per TTL per lämmin kontti |
| Asemien metatiedot | **24 h** | 7 vrk | nimet/kunnat/vapaa nopeus muuttuvat harvoin, mutta kokoaminen vaatii ~20 pyyntöä |
| Historia (`tmsNumber:tyyppi:jakso`) | **6 h** | 7 vrk | tilastot päivittyvät tunneittain ja koskevat päättyneitä jaksoja |

Virhetilanteessa palautetaan viimeisin onnistunut arvo `stale: true`na niin kauan
kuin se ei ole vanhentumisen enimmäisikää vanhempi → sivu ei tyhjene yhden
epäonnistuneen haun takia. Ilman mitään dataa vastaus on **503 +
`Retry-After`** (ei 502), koska kyse on lähteen tilapäisestä viasta.

Varattu concurrency **3**, erillään query-Lambdasta (5), ajoneuvoista (2) ja
pysäkeistä (2). Sovellusajastus: reaaliaika 60 s, historia `staleTime` 30 min
eikä taustapollausta.

## API

### `GET /v1/tms/stations`

```json
{
  "stations": [
    {
      "id": 23438,
      "tmsNumber": 438,
      "name": "vt12_Tre_Paasikiventie",
      "title": "Tie 12 Tampere Uittotunneli",
      "road": "vt12",
      "municipality": "Tampere",
      "province": "Pirkanmaa",
      "latitude": 61.508408,
      "longitude": 23.697679,
      "bearing": 100,
      "directions": [
        {
          "direction": 1,
          "municipality": "Lahti",
          "freeFlowSpeed": 55,
          "speed": 67,
          "volume": 1380,
          "speedRatio": 1.22,
          "level": "SUJUVAA"
        }
      ],
      "measuredAt": "2026-09-27T15:01:57Z",
      "ageMinutes": 1
    }
  ],
  "counts": { "stations": 19, "congested": 0, "unknown": 0 },
  "generatedAt": "2026-09-27T15:01:57Z",
  "fetchedAt": "2026-09-27T15:02:00Z",
  "stale": false
}
```

`measuredAt` on **lähteen** aikaleima (reaaliaikadatan `dataUpdatedTime`), ei
metatietojen — metatietojen `dataUpdatedTime` on dokumentaatiopäivityksen aika
ja voi olla vuosia vanha. `ageMinutes` lasketaan siitä, joten kartalla ei näy
"tuoretta" dataa vanhasta mittauksesta.

### `GET /v1/tms/stations/{tmsNumber}/history`

| Parametri | Arvot | Oletus |
|---|---|---|
| `type` | `daily`, `hourly`, `speed`, `all` | `daily` |
| `days` | 1–31 (`daily`, `all`) | 14 |
| `date` | `YYYY-MM-DD` (`hourly`, `all`) | eilinen |
| `month` | `YYYY-MM` (`speed`, `all`) | kuluva kuukausi |

`type=all` on **sivun käyttämä tyyppi**: se palauttaa kaikki kolme jaksoa yhdellä
vastauksella (`{ daily, hourly, speed, partial }`). Syy on concurrency-katossa:
kolme rinnakaista selainpyyntöä ehtisi throttlautua kylmällä Lambdalla.

Virheellinen `type`, päivämäärä, kuukausi tai `days` → **400** selkeällä
koodilla (`INVALID_TYPE`, `INVALID_DATE`, `INVALID_MONTH`, `INVALID_DAYS`,
`INVALID_TMS_NUMBER`) — ei hiljaista tyhjää vastausta, koska muuten
kirjoitusvirhe näyttäisi käyttäjälle "ei tietoja" -tilana.

**Oletukset ovat päättyneitä jaksoja:** `hourly` palauttaa eilisen (keskeneräistä
vuorokautta ei näytetä täytenä) ja `daily` viimeiset 14 täyttä vuorokautta
(§20: aikaleimoja ei arvata).

### CSV:n jäsennys

| Erityispiirre | Käsittely |
|---|---|
| UTF-8 BOM vastauksen alussa | poistetaan (`\uFEFF`) |
| erotin `;` | sarakeindeksit luetaan **otsikkoriviltä**, ei kovakoodattuja indeksejä |
| tyhjä solu (`;;`) | `null`, **ei nolla** |
| `pvm` muodossa `20260926` | → `2026-09-26` |
| tuntisarakkeet `00_01 … 23_24` | tunnistetaan regexillä `^\d{2}_\d{2}$` |
| monta ajoneuvoluokkaa | valitaan `Kaikki`/`kaikki`-summarivi |
| `suunta=1/2`-rivit | suodatetaan pois vuorokausisarjasta (vain `*`) |
| tuntematon muoto | tyhjä sarja, ei poikkeusta |

## Frontend

`/liikennemaarat` (Liikennemäärät-välilehti). Kortti per asema: otsikko
(`names.fi`), tienumero, kunta, mittauksen ikä, suunnat (`Suunta 1 · Lahti`),
nopeus, vapaa nopeus, liikennemäärä ja sujuvuusmerkki. Kortin napsautus avaa
aseman historian: vuorokausivolyymit (14 palkkia), tuntijakauma (24 palkkia,
viimeisin täysi vuorokausi) ja kuukauden keskinopeudet suunnittain.

Kaikki käyttäjälle näkyvä muotoilu on `lib/tms.ts`:ssä ja testattu ilman DOMia
(mm. `MISSING_VALUE` = `—` puuttuvalle tiedolle, `barHeights` ei koskaan keksi
palkkia puuttuvalle arvolle).

**CSP ei muutu:** data tulee oman API:n kautta samasta originista.

## Testit

| Kohde | Testejä |
|---|---|
| `apps/tms-stations/src/history.test.ts` | 15 (CSV: BOM, tyhjät solut, summarivi, tyhjät sarjat, suunnat) |
| `apps/tms-stations/src/snapshot.test.ts` | 13 (anturivalinta, iän laskenta, luokittelu, tunnusluvut, järjestys) |
| `apps/tms-stations/src/cache.test.ts` | 8 (TTL, in-flight, stale, muistin raja) |
| `apps/tms-stations/src/flow.test.ts` | 10 (kynnykset, matalan volyymin suoja, rajat) |
| `apps/tms-stations/src/region.test.ts` | 8 (rajaus, tienumero nimestä, otsikko) |
| `apps/tms-stations/src/params.test.ts` | 22 (tmsNumber, tyypit, päivät, päivä, kuukausi, oletusjaksot, `resolveHistoryQuery` + `type=all`) |
| `apps/tms-stations/src/metadata.test.ts` | 5 (valinta, yhdistäminen, puuttuva tieto) |
| `apps/tms-stations/src/retry.test.ts` | 7 (uusinta aikakatkaisun ja 5xx:n jälkeen, ei 4xx:lle) |
| `apps/web/src/lib/tms.test.ts` | 17 (muotoilu, palkit, sujuvuusluokat, tyhjät arvot) |
| `infra/test/config.test.ts` | 9 uutta (TTL:ien suhteet, concurrency, timeoutit, uusinnan aikabudjetti) |

Yhteensä **88 testiä** `apps/tms-stations`-paketissa ja 17 frontendin
muotoilulogiikassa; koko repositorion sarja on **452 testiä**.

## Tunnetut rajaukset

- **Ei karttakerrosta.** Asemat näkyvät kortteina; kartalle vieminen olisi oma
  muutoksensa (vertaa §27/§28, joissa kartta oli keskiössä).
- **Ei tallennusta.** Mittauksia ei tallenneta DynamoDB:hen eikä S3:een, joten
  omaa aikasarjaa ei synny. Jos historiatrendejä halutaan myöhemmin omista
  havainnoista, se on uusi päätös (ja uusi kustannus).
- **Vain keruussa olevat asemat.** `REMOVED_TEMPORARILY`-asemat (esim.
  kt65_Tre_Lielahti 27.9.2026) jätetään pois, koska niiltä ei tule tuoreita
  mittauksia.
- **Kaksi suuntaa.** Asemilla on suunnat 1 ja 2; kaistakohtaista dataa
  (esim. `LIUKUVA_NOPEUS_KAISTA_4`) ei näytetä, vaikka lähde antaa sen.
- **Liikennevalodata ja kaupungin oma data** eivät ole mukana (§9: ei MVP:ssä).
