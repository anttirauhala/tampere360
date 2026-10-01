# Saunat-välilehti (`/v1/saunas`, `/saunat`)

> Toteutettu 1.10.2026. Suunnitelma: `.clinerules/implementation_plan.md` §33.
> Deploy vain dev-ympäristöön (`tampere360-dev-*`).

Välilehti näyttää Tampereen seudun saunat listana. Jokaisesta saunasta näytetään
**nimi, osoite, lisätiedot, aukioloaika tänään sekä hinnat**.

## 1. Tietolähde: saunahaku.fi

Saunahaku.fi on Vite-SPA; sen rajapinta löytyi bundle-tiedostosta. Rajapinta on
julkinen AWS API Gateway (ei avainta, ei dokumentoitua skeemaa).

```
GET https://08aapg0u7e.execute-api.eu-west-1.amazonaws.com/prod/sauna-list
→ 200 application/json, access-control-allow-origin: *
→ [ { ...sauna }, ... ]   (~22 saunaa, ~55 kt; verifioitu 1.10.2026)
```

Kentät per sauna:

| Kenttä                                | Tyyppi  | Huom                                              |
| ------------------------------------- | ------- | ------------------------------------------------- |
| `id`                                  | string  | uuid                                              |
| `name`                                | string  |                                                   |
| `streetAddress`, `postalCode`, `city` | string  | kaupunkeja: Tampere ym.                           |
| `openingHours[]`                      | array   | `{ weekday, openingTime, closingTime, prices[] }` |
| `phone`                               | string  | voi olla tyhjä                                    |
| `webPage`                             | string  | URL                                               |
| `info`                                | string  | vapaa lisätietoteksti                             |
| `kiosk`, `restaurant`, `isNew`        | boolean | tunnisteet                                        |

`weekday` on enum `MONDAY`…`SUNDAY`, kellonajat `HH:MM:SS`, ja **hinnat ovat
aukilojakson sisällä**: `prices[] = { priceType, price }` (esim. `ADULT` 15).
Hintaluokat: `ADULT, CHILD, STUDENT, PENSIONER, UNEMPLOYED, CONSRIPT`
(`CONSRIPT` on lähteen kirjoitusasu — ks. `priceTypeLabel`).

## 2. Arkkitehtuuri

```
Selain → GET /v1/saunas (oma API) → apps/saunas-Lambda
          → muistivälimuisti (15 min) → saunahaku.fi → normalisoitu JSON
```

| Ratkaisu                                               | Perustelu                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oma Lambda `apps/saunas` (kuten §27–32)                | Saunat eivät tule DynamoDB:stä; oma varattu concurrency **2** erottaa reitin query- (5) ja muiden reittien katosta                                                 |
| Muistivälimuisti **15 min** + stale-fallback **7 vrk** | Aukioloajat ja hinnat muuttuvat harvoin; N selainta → 1 upstream-kutsu / TTL / lämmin kontti. Varafallback pitää sivun sisällöllään hetkellisen lähdekatkoksen yli |
| Yksi uusintayritys (5xx / verkko)                      | Sama malli kuin §28/§30. 4xx **ja** vastauksen muotovirhe (status 0) eivät uusi, koska sama vastaus toistuisi                                                      |
| Upstream-timeout **4 s**, Lambdan timeout **10 s**     | 2 × 4 s + 0,3 s < 10 s; regressiotesti (`infra/test/config.test.ts`) valvoo budjetin                                                                               |
| **Ei CSP-muutosta**                                    | Data tulee oman API:n kautta (sama origin), joten selain ei tarvitse uutta originia                                                                                |
| **Ei SSM/Secrets**                                     | Rajapinta on julkinen eikä vaadi avainta                                                                                                                           |

Normalisointi (`apps/saunas/src/sauna-list.ts`) on **puolustava**: tuntematon
kenttätyyppi ei kaada vastausta, kellonajan viikonpäivä normalisoidaan
isoiksi kirjaimiksi, ja tietue pudotetaan, jos `id` tai `name` puuttuu.

## 3. Frontend

| Osa                                     | Tehtävä                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/api/saunas.ts`            | tyypit + `fetchSaunas()` + `SAUNAS_STALE_TIME_MS` (30 min)                                                                                                                                               |
| `apps/web/src/api/queries.ts`           | `useSaunas()` — ei automaattipollausta, `refetchOnWindowFocus: false`, "Päivitä tiedot" -painike                                                                                                         |
| `apps/web/src/lib/saunas.ts`            | Puhtaat funktiot (yksikkötestattu): `todayWeekday`, `todaysSessions`, `saunaTodayStatus`, `isOpenToday`, `saunaTodayTone`, `saunaPrices`, `priceTypeLabel`, `formatPrice`, `formatAddress`, `sortSaunas` |
| `apps/web/src/pages/SaunasPage.tsx`     | Otsikko, työkalurivi, korttiruudukko, tila- ja virheviestit                                                                                                                                              |
| `apps/web/src/components/SaunaCard.tsx` | Yhden saunan kortti                                                                                                                                                                                      |

### Järjestys ja värit

- Lista järjestetään niin, että **tänään auki olevat ovat ensin** ja vasta
  niiden jälkeen tänään suljetut. Kummankin ryhmän sisällä järjestys on
  **aakkosissa nimen mukaan** (`localeCompare(…, 'fi')` → Å/Ä/Ö aakkostuvat
  oikein). Lajittelu tehdään `sortSaunas(saunas, weekday)`illa.
- **Auki tänään** → aukioloajat näytetään **vihreällä** (`--ok`).
- **Ei auki tänään** → `Ei aukioloa tänään` (tai `Ei aukioloaikoja`, jos lähde ei
  anna yhtään) näytetään **punaisella** (`--critical`). Väri tulee samasta
  `saunaTodayTone`-funktiosta kuin teksti, joten ne eivät voi eriytyä.

### Aukiolo tänään ja hinnat

- **Tänään** lasketaan **Suomen ajassa** (`Intl.DateTimeFormat` +
  `HELSINKI_TIME_ZONE`) eikä `Date.getDay()`illa — muuten UTC-selain (tai
  ulkomailla oleva käyttäjä) valitsisi väärän päivän aukiolon.
- Päivällä voi olla **useita jaksoja** (esim. aamu ja ilta):
  `08.00–12.00, 16.00–22.00`.
- Kolme tilaa: päivän aukiolo (`12.00–21.45`), `Ei aukioloa tänään` (muita
  päiviä on) ja `Ei aukioloaikoja` (lähde ei anna yhtään, esim. remontti).
- **Hinnat:** päivän jaksojen hinnat deduplikoituna. Jos tänään ei ole aukioloa,
  näytetään koko viikon hinnat, jotta hinta ei katoa.
- Puuttuvaa ei arvata (§20): tuntematon hintaluokka näytetään siistittynä
  sellaisenaan, ei nollana.

`info` sanitoidaan (`sanitizeText`) ennen renderöintiä, ja verkkolinkki
renderöidään vain http(s)-osoitteesta (`sourceLink`).

## 4. Konfiguraatio

`infra/lib/config.ts`:

| Vakio                                  | Arvo                   | Merkitys                                                |
| -------------------------------------- | ---------------------- | ------------------------------------------------------- |
| `SAUNA_LIST_URL`                       | saunahaku.fi-rajapinta | Upstream-osoite (viedään Lambdalle ympäristömuuttujana) |
| `SAUNA_CACHE_MS`                       | 15 min                 | Välimuistin TTL                                         |
| `SAUNA_STALE_MAX_MS`                   | 7 vrk                  | Kuinka vanha lista kelpaa virhetilanteessa              |
| `SAUNA_RESERVED_CONCURRENCY`           | 2                      | Varattu concurrency (kustannuskatto)                    |
| `SAUNA_UPSTREAM_TIMEOUT_MS`            | 4 s                    | Upstream-kutsun aikakatkaisu                            |
| `SAUNA_RETRY_ATTEMPTS` / `_BACKOFF_MS` | 2 / 300 ms             | Uusintayritys                                           |

## 5. Verifiointi (toistettavat komennot)

```bash
# API (dev)
curl "https://vllod80b6i.execute-api.eu-north-1.amazonaws.com/v1/saunas"

# Testit, lintti ja buildi
npx vitest run apps/saunas apps/web/src/lib/saunas.test.ts infra/test/config.test.ts
npm run lint
npm run build:web

# CDK: reitti ja hälytys syntyvät
cd infra && npx cdk synth tampere360-dev-api | grep -i 'v1/saunas'
cd infra && npx cdk synth tampere360-dev-monitoring | grep -i 'errors-saunas'
```

## Veden lämpötila

Saunat-sivun leadin alla näytetään **Näsijärven pintaveden lämpötila**
(implementation plan §34). Data tulee omalta Lambda-reitiltä
`GET /v1/water/temperature` (`apps/water-temperature`).

| Asia       | Arvo                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| Lähde      | **SYKE Hydrologiarajapinta** (OData 3.0), CC BY 4.0                                 |
| Suure      | `LampoPintavesi` = "Pintaveden lämpötila" (T, °C)                                   |
| Asema      | **Näsijärvi, Kyrönlahti** (`Paikka_Id` 1694, Ylöjärvi)                              |
| Kysely     | `LampoPintavesi?$filter=Paikka_Id eq 1694&$orderby=Aika desc&$top=1&$expand=Paikka` |
| Otsikot    | `Accept: application/json` (rajapinta hylkää `$format`-parametrin)                  |
| Välimuisti | **5 min** Lambdassa (vaatimus) + stale-fallback 7 vrk                               |

- **Miksi Näsijärvi/Kyrönlahti:** Tampereen kunnan alueella ei ole yhtään
  säännöllisesti raportoivaa pintaveden lämpötila-asemaa — Näsijärvi on
  Tampereen järvi ja Kyrönlahti sen pohjoispää. Havainto on päivittäinen.
- **Ei CSP-muutosta:** OData-kysely tehdään palvelimella; selain saa pienen JSONin.
- **Puuttuva arvo = rivi jää pois:** jos havaintoja ei ole, `temperatureC` on
  `null` eikä sitä arvata (§20).

## 6. Rajaukset ja tunnetut puutteet

- Ei karttakerrosta (omat muutoksensa §27/§28 tapaan).
- Ei tallennusta DynamoDB:hen: saunat ovat staattinen hakemisto, kuten pysäkit
  ja kamerat — ei omaa aikasarjaa.
- Ei kaupunkikohtaista suodatinta. Lista järjestetään **tänään auki olevat
  ensin**, kummankin ryhmän sisällä aakkosissa nimen mukaan.
- Saunahaku.fi:n lisenssiä ei ole vahvistettu → footteri kertoo vain lähteen
  nimen ("Saunatiedot: saunahaku.fi"), ei lisenssiä.
