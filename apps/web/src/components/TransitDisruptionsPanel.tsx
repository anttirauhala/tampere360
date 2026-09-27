import { Link } from 'react-router-dom';

import { useSituations } from '../api/queries';
import { CATEGORY_EMOJI, CATEGORY_LABELS } from '../api/types';
import { distinctDescription, formatCompactTime, sanitizeText } from '../lib/format';
import { SeverityDot } from './SeverityDot';

/**
 * Kuinka monta poikkeusta sivupaneelissa näytetään. Paneeli on tarkoituksella
 * pieni: koko lista on yhden napsautuksen päässä (`/joukkoliikenne`).
 */
export const TRANSIT_PANEL_LIMIT = 8;

/**
 * Joukkoliikenteen poikkeustilanteet Nysse-välilehden sivupaneelissa (§29).
 *
 * Välilehti poistettiin päänavigaatiosta 27.9.2026, koska tieto kuuluu Nyssen
 * yhteyteen (samat pysäkit ja ajoneuvot samassa näkymässä). Sisältö on sama
 * `PUBLIC_TRANSPORT`-kategoria kuin ennenkin — vain esitystapa on kompaktimpi:
 * vakavuusmerkki, otsikko, aika ja enintään kahden rivin infoteksti.
 *
 * Täysi lista (`CategoryPage`) on edelleen olemassa reitillä
 * `/joukkoliikenne`: sivupaneelin linkki ja Nyt-sivun koostekortti osoittavat
 * siihen. Siksi tätä sivupaneelia ei tarvitse venyttää koko listaksi.
 */
export function TransitDisruptionsPanel() {
  const { data, isLoading, error } = useSituations({
    category: 'PUBLIC_TRANSPORT',
    limit: TRANSIT_PANEL_LIMIT,
  });
  const items = data?.items ?? [];

  return (
    <aside className="transit-panel" aria-label={CATEGORY_LABELS.PUBLIC_TRANSPORT}>
      <header className="transit-panel__head">
        <h2 className="transit-panel__title">
          <span aria-hidden="true">{CATEGORY_EMOJI.PUBLIC_TRANSPORT}</span>{' '}
          {CATEGORY_LABELS.PUBLIC_TRANSPORT}
        </h2>
        {!isLoading && !error && <span className="transit-panel__count">{items.length}</span>}
      </header>

      {isLoading && <p className="transit-panel__state">Ladataan poikkeuksia…</p>}

      {error && (
        <p className="transit-panel__state transit-panel__state--error">
          Poikkeustietojen haku epäonnistui.
        </p>
      )}

      {!isLoading && !error && items.length === 0 && (
        <p className="transit-panel__state">Ei aktiivisia poikkeuksia juuri nyt.</p>
      )}

      {items.length > 0 && (
        <ul className="transit-panel__list">
          {items.slice(0, TRANSIT_PANEL_LIMIT).map((item) => {
            const time = formatCompactTime(item);
            const title = sanitizeText(item.title) || 'Tuntematon tapahtuma';
            const description = distinctDescription(title, sanitizeText(item.description));
            return (
              <li key={item.situationId} className="transit-panel__item">
                <span className="transit-panel__item-title">
                  <SeverityDot severity={item.severity} />
                  {title}
                </span>
                {time && <span className="transit-panel__item-time">{time}</span>}
                {description && <span className="transit-panel__item-desc">{description}</span>}
              </li>
            );
          })}
        </ul>
      )}

      <Link className="transit-panel__more" to="/joukkoliikenne">
        Kaikki poikkeukset →
      </Link>
    </aside>
  );
}
