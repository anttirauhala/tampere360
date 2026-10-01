import { useTmsHistoryBundle } from '../api/queries';
import type { DailyHistory, HourlyHistory, SpeedHistory } from '../api/tms';
import type { ReactNode } from 'react';
import { barHeights, dayLabel, formatNumber, formatSpeed, hourLabel, monthLabel } from '../lib/tms';

/**
 * Valitun mittausaseman historia (§30).
 *
 * Kolme eri näkymää samasta asemasta, koska niillä on eri käyttötarkoitus:
 *
 *  1. **Vuorokausivolyymit** (14 vrk): onko liikenne kasvussa vai laskussa.
 *  2. **Tuntijakauma** (viimeisin täysi vuorokausi): aamun ja iltapäivän piikit.
 *  3. **Kuukauden keskinopeudet suunnittain**: suunnan nimi (esim. "Lahti"),
 *     nopeusrajoitus ja toteutunut keskinopeus.
 *
 * Kaikki kolme haetaan vain valitulle asemalle. Lambdan välimuisti on 6 tuntia,
 * joten näkymän avaaminen uudelleen ei aiheuta uusia Digitraffic-kutsuja.
 */
export function TmsHistoryPanel({ tmsNumber }: { tmsNumber: number }) {
  const { data, isLoading, error } = useTmsHistoryBundle(tmsNumber);

  return (
    <section className="tms-history" aria-label="Aseman historia">
      <h2 className="tms-history__title">Historia{data?.name ? `: ${data.name}` : ''}</h2>

      <ChartSection
        title="Vuorokausivolyymit"
        subtitle={data ? rangeText(data.daily) : undefined}
        isLoading={isLoading}
        error={error}
      >
        {data && <DailyChart history={data.daily} />}
      </ChartSection>

      <ChartSection
        title="Tuntijakauma"
        subtitle={data ? `${dayLabel(data.hourly.date)} kokonainen vuorokausi` : undefined}
        isLoading={isLoading}
        error={error}
      >
        {data && <HourlyChart history={data.hourly} />}
      </ChartSection>

      <ChartSection
        title="Keskinopeudet suunnittain"
        subtitle={data ? monthLabel(data.speed.month) : undefined}
        isLoading={isLoading}
        error={error}
      >
        {data && <SpeedTable history={data.speed} />}
      </ChartSection>

      <p className="tms-history__note">
        Historia: Fintraffic / Digitraffic (CC BY 4.0). Vuorokaudet ja kuukaudet ovat lähteen omia
        jaksoja; keskeneräistä vuorokautta ei näytetä. Sujuvuusluokittelu on oma arviomme nopeuden
        ja vapaan ajon nopeuden suhteesta.
        {data?.partial
          ? ' Osa kuvaajista ei juuri nyt saatu lähteestä — ne täydentyvät, kun tiedot haetaan uudelleen.'
          : ''}
      </p>
    </section>
  );
}

/** Otsikoitu lohko, jossa on lataus- ja virhetila. */
function ChartSection({
  title,
  subtitle,
  isLoading,
  error,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  isLoading: boolean;
  error: unknown;
  children: ReactNode;
}) {
  return (
    <div className="tms-chart">
      <div className="tms-chart__head">
        <h3 className="tms-chart__title">{title}</h3>
        {subtitle && <span className="tms-chart__subtitle">{subtitle}</span>}
      </div>
      {isLoading && <p className="state state--loading">Ladataan…</p>}
      {Boolean(error) && <p className="state state--info">Historiaa ei juuri nyt saada.</p>}
      {!isLoading && !error && children}
    </div>
  );
}

/** Jakson kuvaus: `13.9. – 26.9.2026`. */
function rangeText(history: DailyHistory): string {
  return `${dayLabel(history.range.from)} – ${dayLabel(history.range.to)}${history.range.to.slice(0, 4)}`;
}

/** Vuorokausivolyymien palkit (yksi palkki per päivä). */
function DailyChart({ history }: { history: DailyHistory }) {
  const heights = barHeights(history.days.map((day) => day.total));
  const totals = history.days
    .map((day) => day.total)
    .filter((value): value is number => typeof value === 'number');
  const average =
    totals.length > 0 ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null;

  if (history.days.length === 0) {
    return <p className="state">Tälle asemalle ei ole vuorokausitilastoja.</p>;
  }

  return (
    <>
      <p className="tms-chart__summary">
        Keskimäärin {formatNumber(average)} ajoneuvoa vuorokaudessa ·{' '}
        {formatNumber(history.days.length)} päivää
      </p>
      <div className="tms-bars">
        {history.days.map((day, index) => (
          <span
            key={day.date}
            className="tms-bars__item"
            title={`${day.date}: ${formatNumber(day.total)}`}
          >
            <span className="tms-bars__bar" style={{ height: `${heights[index] ?? 0}%` }} />
            <span className="tms-bars__label">{dayLabel(day.date)}</span>
          </span>
        ))}
      </div>
    </>
  );
}

/** Tuntijakauman palkit (24 tuntia, viimeisin täysi vuorokausi). */
function HourlyChart({ history }: { history: HourlyHistory }) {
  const heights = barHeights(history.hours.map((point) => point.value));
  const hasValues = history.hours.some((point) => point.value !== null);

  if (!hasValues) {
    return <p className="state">Tältä vuorokaudelta ei ole tuntikohtaista dataa.</p>;
  }

  return (
    <>
      <p className="tms-chart__summary">
        Yhteensä {formatNumber(history.total)} ajoneuvoa vuorokaudessa
      </p>
      <div className="tms-bars tms-bars--hours">
        {history.hours.map((point, index) => (
          <span
            key={point.hour}
            className="tms-bars__item"
            title={`${hourLabel(point.hour)}: ${formatNumber(point.value)}`}
          >
            <span className="tms-bars__bar" style={{ height: `${heights[index] ?? 0}%` }} />
            <span className="tms-bars__label">
              {point.hour % 3 === 0 ? String(point.hour).padStart(2, '0') : ''}
            </span>
          </span>
        ))}
      </div>
    </>
  );
}

/** Kuukauden keskinopeudet suunnittain. */
function SpeedTable({ history }: { history: SpeedHistory }) {
  if (history.directions.length === 0) {
    return <p className="state">Tälle kuukaudelle ei ole nopeustilastoja.</p>;
  }

  return (
    <ul className="tms-speed-list">
      {history.directions.map((direction) => (
        <li key={direction.direction} className="tms-speed-list__row">
          <span className="tms-speed-list__name">
            {direction.municipality ?? `Suunta ${direction.direction}`}
            {direction.speedLimit ? ` (rajoitus ${direction.speedLimit} km/h)` : ''}
          </span>
          <span className="tms-speed-list__values">
            <strong>{formatSpeed(direction.avgSpeed)}</strong>
            <span className="tms-speed-list__sub">
              kevyet {formatSpeed(direction.avgSpeedLight)} · raskaat{' '}
              {formatSpeed(direction.avgSpeedHeavy)} · {formatNumber(direction.total)} ajoneuvoa
              kuukaudessa
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
