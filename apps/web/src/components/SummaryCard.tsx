import { Link } from 'react-router-dom';

import {
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  type Category,
  type SituationSummary,
} from '../api/types';
import { formatCompactTime, sanitizeText } from '../lib/format';
import { SeverityDot } from './SeverityDot';

interface Props {
  category: Category;
  /** Enintään näytettävät tapahtumat (uusimmat ensin). */
  items: SituationSummary[];
  /** Kategorian tapahtumien kokonaismäärä. */
  total: number;
  /** Tyyppikohtainen välilehti; jos puuttuu, "Näytä lisää…" -linkkiä ei näytetä. */
  to?: string | undefined;
}

/**
 * Koostekortti (Nyt-sivu): yhden tapahtumatyypin viisi viimeisintä tapahtumaa.
 *
 * Kortin otsikko on tapahtumatyyppi, joten tyyppiä ei toisteta riveillä.
 * Kustakin tapahtumasta näytetään otsikko, aika (alku- tai julkaisuaika) ja
 * yhden rivin infoteksti ajankohdan alla. Rivit erotetaan toisistaan viivalla,
 * joten kortin sisältö on enemmän lista kuin kortti. Taustaväri ja otsikon
 * emoji tulevat tapahtumatyypistä.
 */
export function SummaryCard({ category, items, total, to }: Props) {
  // Tyyppikohtainen taustaväri: summary-card--police, --traffic, ...
  const modifier = category.toLowerCase().replace(/_/g, '-');

  return (
    <section className={`summary-card summary-card--${modifier}`}>
      <header className="summary-card__head">
        <h2 className="summary-card__title">
          <span aria-hidden="true">{CATEGORY_EMOJI[category]}</span>{' '}
          {CATEGORY_LABELS[category] ?? category}
        </h2>
        <span className="summary-card__count">{total}</span>
      </header>

      <ul className="summary-card__list">
        {items.map((item) => {
          const time = formatCompactTime(item);
          const description = sanitizeText(item.description);
          return (
            <li key={item.situationId} className="summary-card__item">
              <span className="summary-card__item-title">
                <SeverityDot severity={item.severity} />
                {sanitizeText(item.title) || 'Tuntematon tapahtuma'}
              </span>
              {time && <span className="summary-card__item-time">{time}</span>}
              {description && <span className="summary-card__item-desc">{description}</span>}
            </li>
          );
        })}
      </ul>

      {to && (
        <Link className="summary-card__more" to={to}>
          Näytä lisää…
        </Link>
      )}
    </section>
  );
}
