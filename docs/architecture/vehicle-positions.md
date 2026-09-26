# Joukkoliikenteen ajoneuvosijainnit (`/v1/vehicles`)

> Tila: toteutettu 26.9.2026 (Vaihe 4+, ks. `.clinerules/implementation_plan.md` §27).
> Deploy: `tampere360-dev-api`, `tampere360-dev-monitoring`,
> `tampere360-dev-frontend` (vain dev).

## Tehtävä

Tarjota kartalle Tampereen seudun joukkoliikenteen ajoneuvot reaaliajassa:
ratikat ja bussit, linjanumero ja määränpää näkyvissä, sijainti enintään
muutaman sekunnin viiveellä. Ajoneuvot ovat **hetkellistä dataa**: niitä ei
tallenneta DynamoDB:hen eikä niistä synny tilanteita.

## Tietolähde

| Asia | Arvo |
|---|---|
| Rajapinta | Waltti SIRI **VehicleMonitoring** v1.3 (`POST`, Basic-auth) |
| Päätepiste | `https://data.waltti.fi/tampere/api/sirirealtime/v1.3/ws` |
| Avain | SSM `/tampere360/{env}/sources/nysse/api-key` (`WithDecryption`) — sama kuin Nysse-adapterilla |
| Vastauksen koko | ~1,83 Mt XML (142 kt gzip), 177 ajoneuvoa |
| Pyyntö | kiinteä `VehicleMonitoringRequest` (`VEHICLEMONITORINGREF = VEHICLES_ALL`) |

**Miksi SIRI eikä GTFS-RT:** Nyssen GTFS-RT `VehiclePositions` antaa vain
dokumentoimattoman `routeId`-numeron (esim. `806990`) eikä määränpäätä, joten
linjanumero ja määränpää pitäisi ratkaista erikseen (staattinen GTFS + reittien
yhdistäminen). SIRI antaa suoraan `LineRef` ("80"), `DestinationName`
("Keskustori") ja `Delay`.

Siivous ennen jäsennystä: `<OnwardCalls>`-lohkot leikataan pois (`siri.ts`),
koska pysäkkikohtaiset tiedot eivät mahdu vastaukseen. Vaikutus:
**415 ms → 36 ms** per pyyntö. XML jäsennetään `fast-xml-parser`illa (sama
kirjasto kuin FMI CAP -adapterissa).

## Ratikan tunnistus

1. Ensisijainen: `OperatorRef === '56920'` (Waltti/Tammerfors = raitiotie).
   Verifioitu 26.9.2026: 19 ajoneuvoa, linjat 1 ja 3.
2. Varalla: `TRAM_LINES = ['1', '3']` (jos `OperatorRef` joskus puuttuu).

Bussi = kaikki muu. `mode.ts` sisältää logiikan ja sen testit.

## Rajapinta

```
GET /v1/vehicles            → kaikki ajoneuvot
GET /v1/vehicles?mode=TRAM   → vain ratikat
GET /v1/vehicles?mode=BUS    → vain bussit
GET /v1/vehicles?mode=X      → 400 {"error":"INVALID_MODE","allowed":["TRAM","BUS"]}
```

Virheellinen `mode` palauttaa **400**, jotta kirjoitusvirhe ei näy hiljaisena
tyhjänä karttana. Vastaus:

```json
{
  "type": "FeatureCollection",
  "source": "NYSSE_SIRI",
  "generatedAt": "2026-09-26T17:33:06.111Z",
  "fetchedAt": "2026-09-26T17:33:08.032Z",
  "stale": false,
  "counts": { "TRAM": 15, "BUS": 133 },
  "count": 15,
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [23.76, 61.498] },
      "properties": {
        "id": "…", "mode": "TRAM", "line": "1", "operator": "56920",
        "destination": "Hervantajärvi A", "bearing": 213.4,
        "delaySeconds": 120, "recordedAt": "2026-09-26T17:33:05Z"
      }
    }
  ]
}
```

`generatedAt` on lähteen oma aika, `fetchedAt` hakuhetki ja `stale` kertoo,
että vastaus tuli varafallbackista (ks. välimuisti). Vastauksessa on
`cache-control: public, max-age=5`.


## Kustannusmalli

Karttasivu pollaa 5 sekunnin välein, joten reitti on API:n vilkkain. Kolme
suojaa (`infra/lib/config.ts`):

| Suoja | Arvo | Tehtävä |
|---|---|---|
| `VEHICLE_CACHE_MS` | 5 000 | N selainta → enintään yksi Waltti-kutsu per TTL per lämmin kontti |
| `VEHICLE_RESERVED_CONCURRENCY` | 2 | kova katto yhtäaikaisille konttikerroksille; erottaa reitin query-Lambdan katosta (`QUERY_RESERVED_CONCURRENCY = 5`) |
| `VEHICLE_MAX_AGE_MINUTES` | 5 | liian vanhat havainnot pudotetaan → ei "haamuja" kartalle |

Lisäksi `VEHICLE_STALE_MAX_MS` = 60 000: jos Waltti epäonnistuu, palvellaan
viimeisin onnistunut snapshot ja merkitään `stale: true`; ilman sitä kartta
tyhjenisi hetkellisen virheen takia.

Välimuisti (`cache.ts`) sisältää myös **in-flight de-dupen**: samanaikaiset
pyynnöt odottavat samaa latausta eivätkä käynnistä uutta Waltti-kutsua.
API-avain haetaan SSM:stä ja pidetään muistissa 10 minuuttia (`API_KEY_TTL_MS`),
joten avain ei aiheuta SSM-kutsua joka pyynnöllä.

## Sijaintitieto

Ajoneuvot eivät kulje tapahtumamallin (`Tampere360Event`) eikä aluesuodatuksen
läpi — Waltti palauttaa vain Tampereen seudun ajoneuvot, ja kartta rajaa
näkyvän alueen. Näin `/v1/vehicles` pysyy kevyenä: ei point-in-polygon-
tarkistusta eikä geokoodausta.

## Frontend

| Osa | Tiedosto |
|---|---|
| Karttasivu | `apps/web/src/pages/NysseMapPage.tsx` |
| Karttakerrokset | `apps/web/src/components/MapView.tsx` (yksi GeoJSON-lähde, kaksi symbolikerrosta) |
| Ikonit | `apps/web/src/lib/vehicle-icons.ts` (canvas, 2× pikselitiheys) |
| Haku + pollaus | `apps/web/src/api/vehicles.ts`, `api/queries.ts` (`useVehicles`) |
| Esityslogiikka | `apps/web/src/lib/vehicles.ts` (puhtaat funktiot + testit) |

Ikonit piirretään ajonaikaisesti `canvas`ille, joten **linjanumero on poltettu
ikoniin** — MapLibren glyph-lähdettä (fonttitiedostoja) ei tarvita eikä CSP:tä
tarvinnut muuttaa.

### MapLibren työntekijä (tärkeä yksityiskohta)

MapLibre v6 laskee työntekijän URL:in ajonaikaisesti `import.meta.url`:sta
(`new URL('./maplibre-gl-worker.mjs', import.meta.url)`). Vite **ei tunnista**
tällaista dynaamista polkua, joten tiedosto ei päädy buildiin ja CloudFrontin
SPA-uudelleenohjaus palauttaa pyyntöön `index.html`:n → työntekijä ei käynnisty.
Seuraus on **hiljainen**: rasteritiilet näkyvät, mutta GeoJSON-lähde jää jumiin
eikä symboleja piirretä.

Siksi `apps/web/src/lib/maplibre-worker.ts` bundlaa työntekijän Viten
`?worker&url`-kyselyllä ja kutsuu `setWorkerUrl()`ia ennen kartan luontia.
Tarkempi kuvaus ja diagnoosi: `.clinerules/implementation_plan.md` §27.1.

## Testit

```
apps/vehicle-positions/src/siri.test.ts       jäsennys, puuttuvat kentät, OnwardCalls-poisto, viive
apps/vehicle-positions/src/geojson.test.ts    GeoJSON-muunnos, koordinaattien validointi, ikäraja
apps/vehicle-positions/src/cache.test.ts      TTL, in-flight de-dupe, stale-fallback, virhe
apps/vehicle-positions/src/params.test.ts     mode-parametri
apps/vehicle-positions/src/mode.test.ts       ratikan tunnistus
```

Aja: `npm test` (koko sarja 211 testiä).

## Käyttöönotto ja vianetsintä

```bash
# Savutesti
curl -s "$API/v1/vehicles?mode=TRAM" | jq '{count, counts, stale}'

# Lambda-lokit (hakee Walttin vain kun välimuisti on vanhentunut)
aws logs tail /aws/lambda/tampere360-dev-vehicles --follow --region eu-north-1
```

Tyypilliset syyt tyhjään karttaan:

| Oire | Syy |
|---|---|
| `count: 0`, `stale: false` | Waltti palauttaa ajoneuvot vain liikennöintiaikana (yö) |
| `stale: true` toistuvasti | Waltti-virhe tai avain vanhentunut |
| `502 UPSTREAM_UNAVAILABLE` | SSM-avain puuttuu tai Waltti ei vastaa |
| Kartta näkyy, ikonit eivät | MapLibren työntekijä ei lataudu → ks. §27.1 |
| Ikonit näkyvät, klikkaus ei avaa popupia | kerroskohtaiset kuuntelijat rekisteröitiin ennen kerroksen luontia (korjattu 26.9.2026, ks. §27.1.1) |
| Ikonit eivät päivity | Selain pollaa 5 s; taustavälilehdellä `refetchIntervalInBackground: false` |

Huom: Waltti-avain on vietävä **erikseen jokaiseen ympäristöön**
(`/tampere360/{dev,prod}/sources/nysse/api-key`) — CDK ei luo salaisuuksia.
