import { useCallback, useMemo, useState } from 'react';

import { useStops, useVehicles } from '../api/queries';
import type { Stop, VehicleMode } from '../api/types';
import { MapView } from '../components/MapView';
import { StopPanel } from '../components/StopPanel';
import { TransitDisruptionsPanel } from '../components/TransitDisruptionsPanel';
import { buildStopIndex } from '../lib/stops';
import { MODE_LABELS_PLURAL, formatVehicleAge, vehicleSummary } from '../lib/vehicles';

const MODES: VehicleMode[] = ['TRAM', 'BUS'];

/**
 * Nysse-välilehti (§27, §28, §29): joukkoliikenteen ajoneuvot reaaliajassa,
 * valinnaisesti pysäkit (klikkaamalla lähtöaikataulu) ja **joukkoliikenteen
 * poikkeustilanteet sivupaneelissa**.
 *
 * Oletuksena ratikat (noin 20 ajoneuvoa) — bussit saa yhdellä napsautuksella.
 * **Pysäkit ovat oletuksena piilossa**: niitä on 3 423, joten ne ladataan ja
 * piirretään vasta kun käyttäjä valitsee "Näytä pysäkit".
 *
 * Sivupaneeli korvaa entisen "Joukkoliikenne poikkeustilanteet" -välilehden
 * (poistettu päänavigaatiosta 27.9.2026): poikkeukset kuuluvat samaan
 * näkymään liikkuvan kaluston kanssa. Täysi lista on edelleen reitillä
 * `/joukkoliikenne`.
 *
 * Pollaus on 5 sekuntia (`useVehicles`) ja Lambda pitää yllä 5 sekunnin
 * välimuistia, joten useampi avoin selain ei lisää Waltti-kutsuja. Pysäkin
 * lähtölistaa päivitetään 15 sekunnin välein vain valitulle pysäkille.
 */
export function NysseMapPage() {
  const [mode, setMode] = useState<VehicleMode>('TRAM');
  const [showStops, setShowStops] = useState(false);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);

  const { data, isLoading, error } = useVehicles(mode);
  const stops = useStops(showStops);

  // Pysäkkihakemisto: kartan klikkaus antaa vain tunnisteen, joten nimi
  // haetaan tästä eikä erillisellä API-kutsulla.
  const stopIndex = useMemo(
    () => buildStopIndex(showStops ? stops.data : null),
    [showStops, stops.data],
  );

  const selectedStop: Stop | null = useMemo(() => {
    if (!selectedStopId) return null;
    // Jos pysäkkiä ei löydy rekisteristä (esim. aineisto vaihtui), näytetään
    // tunniste — sidepanel täydentää nimen API-vastauksesta.
    return (
      stopIndex.get(selectedStopId) ?? {
        id: selectedStopId,
        name: selectedStopId,
        latitude: null,
        longitude: null,
      }
    );
  }, [selectedStopId, stopIndex]);

  const handleSelectStop = useCallback((stopId: string): void => {
    setSelectedStopId(stopId);
  }, []);

  const handleClosePanel = useCallback((): void => setSelectedStopId(null), []);

  const count = data?.count ?? 0;
  const updatedAt = data?.generatedAt ?? data?.fetchedAt ?? null;
  const age = formatVehicleAge(updatedAt);

  return (
    <section className="page page--map">
      <h1 className="page__title">Nysse</h1>
      <p className="page__lead">Tampereen joukkoliikenteen ajoneuvot reaaliajassa.</p>

      <div className="vehicle-toolbar">
        <div className="vehicle-toolbar__modes" role="group" aria-label="Ajoneuvotyyppi">
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              className={option === mode ? 'chip chip--active' : 'chip'}
              aria-pressed={option === mode}
              onClick={() => setMode(option)}
            >
              {MODE_LABELS_PLURAL[option]}
              {data ? ` (${option === mode ? data.count : data.counts[option]})` : ''}
            </button>
          ))}
        </div>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={showStops}
            onChange={(event) => {
              const checked = event.target.checked;
              setShowStops(checked);
              // Kerroksen sammuttaminen sulkee sidepanelin: muuten paneeli
              // jäisi näkyviin pysäkille, jota ei enää näy kartalla.
              if (!checked) setSelectedStopId(null);
            }}
          />
          Näytä pysäkit
          {showStops && stops.isLoading ? ' (ladataan…)' : ''}
          {showStops && stops.data ? ` (${stops.data.count})` : ''}
        </label>

        <span className="vehicle-toolbar__info">
          {isLoading ? 'Ladataan…' : vehicleSummary(mode, count, updatedAt)}
          {data?.stale ? ' · tiedot voivat olla hetken vanhentuneita' : ''}
        </span>
      </div>

      {error && (
        <p className="state state--error">Ajoneuvotietojen haku epäonnistui: {error.message}</p>
      )}

      {showStops && stops.error && (
        <p className="state state--error">Pysäkkien haku epäonnistui: {stops.error.message}</p>
      )}

      <div className="nysse-layout">
        <div className="map-shell">
          <MapView
            vehicles={data}
            stops={showStops ? (stops.data ?? null) : null}
            selectedStopId={selectedStopId}
            onSelectStop={handleSelectStop}
          />
          {selectedStop && <StopPanel stop={selectedStop} onClose={handleClosePanel} />}
        </div>

        {/* Poikkeustilanteet samassa näkymässä kaluston kanssa (§29). */}
        <TransitDisruptionsPanel />
      </div>

      {!isLoading && !error && count === 0 && (
        <p className="state">Ei ajoneuvoja liikenteessä juuri nyt.</p>
      )}

      <p className="page__note">
        Ajoneuvot, lähdöt ja poikkeustilanteet: Nysse / Waltti (CC BY 4.0). Pysäkit: Nysse /
        GTFS-static. Näytetty sijainti on ajoneuvon itsensä lähettämä viimeisin havainto
        {age ? ` (${age})` : ''} — se ei ole ennuste. Napsauta ajoneuvoa, niin näet määränpään ja
        aikataulupoikkeaman. Napsauta pysäkkiä, niin näet pysäkkiaikataulun.
      </p>
    </section>
  );
}
