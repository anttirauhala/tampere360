import type { StationSnapshot } from '../api/tms';
import {
  describeDirection,
  flowLevelClass,
  flowLevelLabel,
  formatFreeFlow,
  formatSpeed,
  formatVolume,
  measuredAgeText,
  stationLocationText,
} from '../lib/tms';

/**
 * Mittausaseman kortti (§30).
 *
 * Kortti on painike: napsautus valitsee aseman, jolloin sivun alaosassa
 * näytetään sen historia (vuorokausivolyymit, tuntijakauma ja keskinopeudet).
 * Sujuvuus kerrotaan sekä värinä että tekstinä — pelkkä väri ei riitä, koska
 * luokittelu on oma arviomme (ks. lib/tms.ts).
 */
export function TmsStationCard({
  station,
  selected,
  onSelect,
}: {
  station: StationSnapshot;
  selected: boolean;
  onSelect: (tmsNumber: number) => void;
}) {
  return (
    <button
      type="button"
      className={`tms-card${selected ? ' tms-card--selected' : ''}`}
      aria-expanded={selected}
      onClick={() => {
        onSelect(station.tmsNumber);
      }}
    >
      <span className="tms-card__head">
        <span className="tms-card__title">{station.title}</span>
        {station.road && <span className="tms-card__road">{station.road}</span>}
      </span>

      <span className="tms-card__meta">
        {stationLocationText(station)} · {measuredAgeText(station.ageMinutes)}
      </span>

      <span className="tms-card__directions">
        {station.directions.map((direction) => (
          <span key={direction.direction} className="tms-direction">
            <span className="tms-direction__head">
              <span className={`tms-level ${flowLevelClass(direction.level)}`}>
                {flowLevelLabel(direction.level)}
              </span>
              <span className="tms-direction__name">{describeDirection(direction)}</span>
            </span>
            <span className="tms-direction__values">
              <strong>{formatSpeed(direction.speed)}</strong>
              <span className="tms-direction__sub">
                vapaa nopeus {formatFreeFlow(direction.freeFlowSpeed)} ·{' '}
                {formatVolume(direction.volume)}
              </span>
            </span>
          </span>
        ))}
      </span>

      <span className="tms-card__hint">
        {selected ? 'Historia näkyvissä alla' : 'Napsauta nähdäksesi historian'}
      </span>
    </button>
  );
}
