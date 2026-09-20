import { CATEGORY_LABELS, SEVERITY_LABELS, type SituationSummary } from '../api/types';
import { describeSituationTime, sanitizeText } from '../lib/format';

interface Props {
  item: SituationSummary;
}

/**
 * Näytetäänkö paikkakunta kortissa?
 *
 * Joukkoliikenteen (Nysse) häiriötiedotteet koskevat koko seudun liikennettä,
 * eikä lähde kerro niille kuntaa — normalisoija asettaa kaikille 'Tampere'.
 * Seurakseen paikkakunta olisi kortissa turhaa toistoa, joten sitä ei näytetä
 * joukkoliikenteen korteilla. Muilla kategorioilla paikkakunta tulee lähteestä
 * ja tuo lisätietoa (esim. liikennetiedotteen kunta).
 */
export function shouldShowMunicipality(
  item: Pick<SituationSummary, 'category' | 'municipality'>,
): boolean {
  if (!item.municipality) return false;
  return item.category !== 'PUBLIC_TRANSPORT';
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
        {shouldShowMunicipality(item) && <span>{item.municipality}</span>}
        {/* Alkuaika näytetään vain jos lähde kertoi sen — muuten ei mitään. */}
        {time.primary && (
          <span className="card__time" title="Tapahtuman alkuaika lähteen mukaan">
            {time.primary}
          </span>
        )}
        {time.detail && <span className="card__time-detail">{time.detail}</span>}
      </div>
    </article>
  );
}
