import { CATEGORY_LABELS, SEVERITY_LABELS, type SituationSummary } from '../api/types';
import { formatAge, formatTime, sanitizeText } from '../lib/format';

interface Props {
  item: SituationSummary;
}

/** Yhden tilanteen kortti listanäkymässä. */
export function SituationCard({ item }: Props) {
  const title = sanitizeText(item.title);
  const severityClass = `severity severity--${item.severity.toLowerCase()}`;

  return (
    <article className={`card ${severityClass}`}>
      <div className="card__head">
        <span className="card__category">{CATEGORY_LABELS[item.category] ?? item.category}</span>
        <span className={severityClass}>{SEVERITY_LABELS[item.severity] ?? item.severity}</span>
      </div>

      <h3 className="card__title">{title || 'Tuntematon tapahtuma'}</h3>

      <div className="card__meta">
        {item.municipality && <span>{item.municipality}</span>}
        {item.startsAt && (
          <span title={formatTime(item.startsAt)}>
            {formatTime(item.startsAt)} · {formatAge(item.startsAt)}
          </span>
        )}
      </div>
    </article>
  );
}
