import { Link } from 'react-router-dom';

import { CATEGORY_LABELS, type Category, type SituationSummary } from '../api/types';
import { formatCompactTime, sanitizeText } from '../lib/format';

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
 * Kustakin tapahtumasta näytetään vain otsikko ja aika (alku- tai julkaisuaika).
 * Fontti on kortin sisällössä pienempi kuin yksittäisissä tilannekorteissa.
 */
export function SummaryCard({ category, items, total, to }: Props) {
  return (
    <section className="summary-card">
      <header className="summary-card__head">
        <h2 className="summary-card__title">{CATEGORY_LABELS[category] ?? category}</h2>
        <span className="summary-card__count">{total}</span>
      </header>

      <ul className="summary-card__list">
        {items.map((item) => {
          const time = formatCompactTime(item);
          return (
            <li key={item.situationId} className="summary-card__item">
              <span className="summary-card__item-title">
                {sanitizeText(item.title) || 'Tuntematon tapahtuma'}
              </span>
              {time && <span className="summary-card__item-time">{time}</span>}
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
