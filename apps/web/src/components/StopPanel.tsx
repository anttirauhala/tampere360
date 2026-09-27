import { useEffect, useRef } from 'react';

import { apiErrorStatus } from '../api/client';
import { useStopDepartures } from '../api/queries';
import { departureKey } from '../api/stops';
import type { Stop } from '../api/types';
import { sanitizeText } from '../lib/format';
import {
  type DeparturesNotice,
  NO_REALTIME_COVERAGE_TEXT,
  departureTone,
  formatClockTime,
  formatDepartureIn,
  hasEstimates,
  stopDeparturesNotice,
} from '../lib/stops';

interface Props {
  /** Valittu pysäkki (kartalta: tunniste ja nimi). */
  stop: Stop;
  onClose: () => void;
}

/**
 * Pysäkin sidepanel (§28).
 *
 * Näyttää **vain** valitun pysäkin reaaliaikaiset lähdöt: linja, määränpää ja
 * aika minuutteina. Tässä vaiheessa ei ole ajoneuvon seurantaa, suosikkeja eikä
 * aikatauluhistoriaa — ominaisuus on tarkoituksella pieni.
 *
 * Lähtötiedot haetaan vasta kun paneeli avataan (`useStopDepartures`) ja niitä
 * päivitetään 15 sekunnin välein. Latauksen aikana näytetään selkeä tila, ja
 * virhe näytetään käyttäjälle luettavana tekstinä.
 *
 * Sulkeminen onnistuu sulkunapista ja Escape-näppäimestä (näppäimistökäyttö).
 */
export function StopPanel({ stop, onClose }: Props) {
  const { data, error, isLoading, isFetching, refetch } = useStopDepartures(stop.id);
  const departures = data?.departures ?? [];
  const name = sanitizeText(data?.stop?.name ?? stop.name);
  /** Waltti ei palauta tälle pysäkille aikatauluja lainkaan (§28). */
  const noCoverage = data?.realtimeCoverage === false;
  /** Hakuvirhe käännettynä käyttäjälle luettavaksi huomautukseksi. */
  const liveNotice = error ? stopDeparturesNotice(apiErrorStatus(error)) : null;

  // TanStack Query nollaa `error`in uuden yrityksen alkaessa, joten pelkkä
  // `error`-tarkistus piilottaisi huomautuksen joka 15. sekunnin pollauksella.
  // Viimeisin huomautus pidetään siksi muistissa ja näytetään uusinnan ajan.
  const lastNoticeRef = useRef<DeparturesNotice | null>(null);
  useEffect(() => {
    if (liveNotice) lastNoticeRef.current = liveNotice;
  }, [liveNotice]);

  const notice = liveNotice ?? (isFetching && !data ? lastNoticeRef.current : null);
  const loading = (isLoading || isFetching) && !data && !notice;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const updatedAt = data?.generatedAt ?? data?.fetchedAt ?? null;

  return (
    <aside className="stop-panel" aria-label={`Pysäkin ${name} lähdöt`}>
      <header className="stop-panel__head">
        <div>
          <h2 className="stop-panel__title">
            <span aria-hidden="true">🚏</span> {name}
          </h2>
          <p className="stop-panel__id">Pysäkki {sanitizeText(stop.id)}</p>
        </div>
        <button
          type="button"
          className="stop-panel__close"
          onClick={onClose}
          aria-label="Sulje pysäkin tiedot"
        >
          ×
        </button>
      </header>

      <div className="stop-panel__body">
        {loading && <p className="state state--loading">Ladataan lähtöjä…</p>}

        {notice && !data && (
          <div className={`state state--${notice.tone}`} role="status">
            <p>{notice.text}</p>
            <button
              type="button"
              className="state__retry"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching ? 'Haetaan…' : 'Yritä uudelleen'}
            </button>
          </div>
        )}

        {error && data && (
          <p className="stop-panel__warn">Päivitys epäonnistui — näytetään viimeisin vastaus.</p>
        )}

        {noCoverage && <p className="stop-panel__notice">{NO_REALTIME_COVERAGE_TEXT}</p>}

        {!loading && !notice && !noCoverage && departures.length === 0 && (
          <p className="state">Ei lähtöjä seuraavan tunnin aikana.</p>
        )}

        {departures.length > 0 && (
          <ul className="departures">
            {departures.map((departure, index) => (
              <li
                key={departureKey(departure, index)}
                className={`departures__row departures__row--${departureTone(departure)}`}
              >
                <span className="departures__line">{sanitizeText(departure.routeShortName)}</span>
                <span className="departures__destination">
                  {sanitizeText(departure.destination) || 'Määränpää ei tiedossa'}
                </span>
                <span className="departures__time">{formatDepartureIn(departure)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="stop-panel__foot">
        <p>
          {updatedAt ? `Päivitetty ${formatClockTime(updatedAt)}` : 'Ladataan…'}
          {data?.stale ? ' · tiedot voivat olla hetken vanhentuneita' : ''}
        </p>
        {hasEstimates(departures) && (
          <p className="stop-panel__note">
            ≈ = aikataulun mukainen aika (ei reaaliaikaista tietoa)
          </p>
        )}
        <p className="stop-panel__note">Lähde: Nysse / Waltti (SIRI)</p>
      </footer>
    </aside>
  );
}
