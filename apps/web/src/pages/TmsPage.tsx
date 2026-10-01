import { useState } from 'react';

import { useTmsStations } from '../api/queries';
import { TmsHistoryPanel } from '../components/TmsHistoryPanel';
import { TmsStationCard } from '../components/TmsStationCard';
import { formatTime } from '../lib/format';
import { TMS_POLL_MS } from '../api/tms';

/**
 * Liikennemäärät-välilehti (§30): Tampereen seudun liikenteen mittausasemat.
 *
 * Näkymä on kaksiosainen:
 *
 *  1. **Asemakortit** (19 kpl): reaaliaikainen nopeus ja liikennemäärä
 *     suunnittain sekä sujuvuusarvio (nopeus / vapaan ajon nopeus).
 *  2. **Historia** valitulle asemalle: vuorokausivolyymit (14 vrk),
 *     tuntijakauma (viimeisin täysi vuorokausi) ja kuukauden keskinopeudet.
 *
 * Reaaliaika pollataan minuutin välein (ks. TMS_POLL_MS); historia haetaan
 * vain kerran per asema, koska se muuttuu tunneittain.
 */
export function TmsPage() {
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useTmsStations();
  const [selectedTmsNumber, setSelectedTmsNumber] = useState<number | null>(null);

  const stations = data?.stations ?? [];
  const selectedStation = stations.find((station) => station.tmsNumber === selectedTmsNumber);

  return (
    <section className="page">
      <h1 className="page__title">Liikennemäärät</h1>
      <p className="page__lead">
        Tampereen seudun liikenteen mittausasemat — nopeudet, liikennemäärät ja historia (Fintraffic
        / Digitraffic).
      </p>

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
            {`${stations.length} asemaa` +
              (data ? ` · ${data.counts.congested} ruuhkautunutta` : '') +
              (data && data.counts.unknown > 0 ? ` · ${data.counts.unknown} ilman arviota` : '') +
              ` · päivitetty ${formatTime(new Date(dataUpdatedAt).toISOString())} · päivittyy ${Math.round(
                TMS_POLL_MS / 1000,
              )} s välein`}
          </span>
        )}
      </div>

      {isLoading && <p className="state state--loading">Ladataan mittaustietoja…</p>}

      {error && (
        <div className="state state--error">
          <p>Mittaustietojen haku epäonnistui.</p>
          <p className="state__detail">
            Lähde ei vastannut juuri nyt — tiedot päivittyvät automaattisesti uudelleen.
          </p>
        </div>
      )}

      {!isLoading && !error && stations.length === 0 && (
        <p className="state">Yhtään mittausasemaa ei ole juuri nyt saatavilla.</p>
      )}

      {stations.length > 0 && (
        <div className="tms-grid">
          {stations.map((station) => (
            <TmsStationCard
              key={station.id}
              station={station}
              selected={station.tmsNumber === selectedTmsNumber}
              onSelect={(tmsNumber) => {
                setSelectedTmsNumber((previous) => (previous === tmsNumber ? null : tmsNumber));
              }}
            />
          ))}
        </div>
      )}

      {selectedStation && <TmsHistoryPanel tmsNumber={selectedStation.tmsNumber} />}

      <p className="page__note">
        Mittaukset: Fintraffic / Digitraffic (CC BY 4.0). Nopeudet ovat liukuvan 5 minuutin
        keskiarvoja ja liikennemäärät tunniksi muunnettuja ohitusmääriä; mukana ovat vain keruussa
        olevat asemat Tampereen seudulla.
        {data?.stale
          ? ' Tiedot ovat viimeisin onnistunut havainto — lähde ei vastannut viimeisimpään kyselyyn.'
          : ''}{' '}
        Sujuvuusluokittelu (Sujuvaa / Hidastunutta / Ruuhkautunut) on oma arviomme nopeuden ja
        vapaan ajon nopeuden suhteesta, ei Fintrafficin virallinen luokitus.
        {data?.generatedAt ? ` Mittausten aikaleima: ${formatTime(data.generatedAt)}.` : ''}
      </p>
    </section>
  );
}
