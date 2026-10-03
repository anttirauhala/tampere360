import { useMemo } from 'react';

import { useSaunas, useWaterTemperature } from '../api/queries';
import { SaunaCard } from '../components/SaunaCard';
import { formatTime, sourceLink } from '../lib/format';
import { SAUNA_SOURCE_URL, sortSaunas, todayWeekday } from '../lib/saunas';
import { formatMeasurementDate, formatWaterTemperature } from '../lib/water';

/**
 * Saunat-välilehti (§33): Tampereen seudun saunat listana.
 *
 * Jokaisesta saunasta näytetään nimi, osoite, **aukiolo tänään**, hinnat ja
 * lisätiedot. Data tulee oman API:n kautta (`/v1/saunas`), joka hakee sen
 * saunahaku.fi-rajapinnasta (ks. apps/saunas).
 *
 * Leadin alle lisättiin **Näsijärven pintaveden lämpötila** (§34) oman API:n
 * reitiltä `/v1/water/temperature` (SYKE Hydrologiarajapinta, 5 min välimuisti).
 * Jos lämpötilaa ei saada, rivi jää pois eikä riko sivua.
 *
 * Luettelo ei ole reaaliaikainen: aukioloajat ja hinnat muuttuvat harvoin, joten
 * tieto haetaan kerran istunnossa ja päivitetään "Päivitä tiedot" -painikkeella
 * (ei automaattipollausta).
 */
export function SaunasPage() {
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useSaunas();
  const { data: water } = useWaterTemperature();

  // Suomen ajassa laskettu viikonpäivä määrää "aukiolo tänään" -rivin.
  const weekday = todayWeekday();
  const saunas = useMemo(() => sortSaunas(data?.saunas ?? [], weekday), [data, weekday]);
  const measured = water ? formatMeasurementDate(water.measuredAt) : '';
  // Lähdelinkki rakennetaan `sourceLink`-apurilla: se hyväksyy vain http(s)-osoitteet.
  const source = sourceLink(SAUNA_SOURCE_URL);

  return (
    <section className="page">
      <h1 className="page__title">Saunat</h1>
      <p className="page__lead">
        Tampereen seudun saunat — aukiolo tänään, hinnat ja lisätiedot (
        {source && (
          <a
            className="page__lead-link"
            href={source.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {source.label} ↗
          </a>
        )}
        ).
      </p>

      {water && water.temperatureC !== null && (
        <p className="sauna-water">
          <span className="sauna-water__label">Veden lämpötila</span>
          <span className="sauna-water__value">{formatWaterTemperature(water.temperatureC)}</span>
          <span className="sauna-water__meta">
            {[water.station.name, measured ? `mitattu ${measured}` : '']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </p>
      )}

      <div className="camera-toolbar">
        <button
          type="button"
          className="button"
          onClick={() => {
            void refetch();
          }}
          disabled={isFetching}
        >
          {isFetching ? 'Päivitetään…' : 'Päivitä tiedot'}
        </button>
        {dataUpdatedAt > 0 && (
          <span className="camera-toolbar__info">
            {`${saunas.length} saunaa · tiedot haettu ${formatTime(
              new Date(dataUpdatedAt).toISOString(),
            )}`}
          </span>
        )}
      </div>

      {isLoading && <p className="state state--loading">Ladataan saunoja…</p>}

      {error && (
        <div className="state state--error">
          <p>Saunatietojen haku epäonnistui.</p>
          <p className="state__detail">
            Lähde ei vastannut juuri nyt — kokeile “Päivitä tiedot” -painiketta hetken kuluttua.
          </p>
        </div>
      )}

      {!isLoading && !error && saunas.length === 0 && (
        <p className="state">Ei saunoja saatavilla juuri nyt.</p>
      )}

      {saunas.length > 0 && (
        <div className="sauna-grid">
          {saunas.map((sauna) => (
            <SaunaCard key={sauna.id} sauna={sauna} weekday={weekday} />
          ))}
        </div>
      )}

      <p className="page__note">
        Tiedot:{' '}
        {source && (
          <a href={source.href} target="_blank" rel="noopener noreferrer">
            {source.label}
          </a>
        )}
        . Aukioloajat ja hinnat ovat lähteen ilmoittamia — tarkista poikkeukset saunan omilta
        sivuilta.
        {data?.stale
          ? ' Lista on viimeisin onnistunut haku, lähde ei vastannut viimeisimpään.'
          : ''}
      </p>
    </section>
  );
}
