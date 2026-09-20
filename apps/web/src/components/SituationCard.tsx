import { CATEGORY_LABELS, SEVERITY_LABELS, type SituationSummary } from '../api/types';
import { describeSituationTime, sanitizeText } from '../lib/format';

interface Props {
  item: SituationSummary;
}

/** Yhden tilanteen kortti listanäkymässä. */
export function SituationCard({ item }: Props) {
  const title = sanitizeText(item.title);
  const severityClass = `severity severity--${item.severity.toLowerCase()}`;
  const time = describeSituationTime(item);

  return (
    <article className={`card ${severityClass}`}>
      <div className="card__head">
        <span className="card__category">{CATEGORY_LABELS[item.category] ?? item.category}</span>
        <span className={severityClass}>{SEVERITY_LABELS[item.severity] ?? item.severity}</span>
      </div>

      <h3 className="card__title">{title || 'Tuntematon tapahtuma'}</h3>

      <div className="card__meta">
        {item.municipality && <span>{item.municipality}</span>}
        <span
          className={time.isStartKnown ? 'card__time' : 'card__time card__time--unknown'}
          title={time.isStartKnown ? 'Tapahtuman alkuaika lähteen mukaan' : undefined}
        >
          {time.primary}
        </span>
        {time.detail && <span className="card__time-detail">{time.detail}</span>}
      </div>
    </article>
  );
}
