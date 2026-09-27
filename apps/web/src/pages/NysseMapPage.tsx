import { useState } from 'react';

import { useVehicles } from '../api/queries';
import type { VehicleMode } from '../api/types';
import { MapView } from '../components/MapView';
import { MODE_LABELS_PLURAL, formatVehicleAge, vehicleSummary } from '../lib/vehicles';

const MODES: VehicleMode[] = ['TRAM', 'BUS'];

/**
 * Nysse kartalla -välilehti (§27): joukkoliikenteen ajoneuvot reaaliajassa.
 *
 * Oletuksena ratikat (noin 20 ajoneuvoa) — bussit saa yhdellä napsautuksella.
 *
 * Pollaus on 5 sekuntia (`useVehicles`) ja Lambda pitää yllä 5 sekunnin
 * välimuistia, joten useampi avoin selain ei lisää Waltti-kutsuja.
 */
export function NysseMapPage() {
  const [mode, setMode] = useState<VehicleMode>('TRAM');
  const { data, isLoading, error } = useVehicles(mode);

  const count = data?.count ?? 0;
  const updatedAt = data?.generatedAt ?? data?.fetchedAt ?? null;
  const age = formatVehicleAge(updatedAt);

  return (
    <section className="page page--map">
      <h1 className="page__title">Nysse kartalla</h1>
      <p className="page__lead">
        Tampereen joukkoliikenteen ajoneuvot reaaliajassa. Ikoni kertoo linjan numeron ja kiertyy
        kulkusuuntaan; sijainti päivittyy 5 sekunnin välein.
      </p>

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
        <span className="vehicle-toolbar__info">
          {isLoading ? 'Ladataan…' : vehicleSummary(mode, count, updatedAt)}
          {data?.stale ? ' · tiedot voivat olla hetken vanhentuneita' : ''}
        </span>
      </div>

      {error && (
        <p className="state state--error">
          Ajoneuvotietojen haku epäonnistui: {error.message}
        </p>
      )}

      <MapView vehicles={data} />

      {!isLoading && !error && count === 0 && (
        <p className="state">Ei ajoneuvoja liikenteessä juuri nyt.</p>
      )}

      <p className="page__note">
        Ajoneuvot: Nysse / Waltti (CC BY 4.0). Näytetty sijainti on ajoneuvon itsensä lähettämä
        viimeisin havainto{age ? ` (${age})` : ''} — se ei ole ennuste. Napsauta ajoneuvoa, niin näet määränpään ja
        aikataulupoikkeaman.
      </p>
    </section>
  );
}
