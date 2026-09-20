import { useSituations } from '../api/queries';
import { CATEGORY_LABELS, type Category } from '../api/types';
import { SeverityDot } from '../components/SeverityDot';
import { formatCompactTime, sanitizeText } from '../lib/format';

interface Props {
  category: Category;
}

/**
 * Yhden kategorian näkymä (Liikenne, Säävaroitukset, Poliisi, Joukkoliikenne).
 *
 * Jokainen tilanne on oma, koko leveyden levyinen elementti — ei yhtä
 * koostekorttia. Taustaväri tulee tapahtumatyypistä (sama kuin Nyt-sivun
 * koostekortilla) ja infoteksti näytetään kokonaisuudessaan.
 */
export function CategoryPage({ category }: Props) {
  const { data, isLoading, error } = useSituations({ category, limit: 200 });
  const items = data?.items ?? [];
  const label = CATEGORY_LABELS[category] ?? category;
  const modifier = category.toLowerCase().replace(/_/g, '-');

  return (
    <section className="page">
      {/* Sama himmennetty taustakuva kuin Nyt-sivulla (samat asetukset CSS:ssä). */}
      <div className="now-backdrop" aria-hidden="true" />

      <h1 className="page__title">{label}</h1>

      {isLoading && <p className="state state--loading">Ladataan tilannetietoja…</p>}

      {error && (
        <div className="state state--error">
          <p>Tilannetietojen haku epäonnistui.</p>
          <p className="state__detail">{error.message}</p>
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <p className="state">Ei aktiivisia tilanteita kategoriassa {label}.</p>
      )}

      {!isLoading && !error && items.length > 0 && (
        <p className="page__lead">Aktiivisia tapahtumia {items.length} kappaletta</p>
      )}

      {items.length > 0 && (
        <div className="situation-list">
          {items.map((item) => {
            const time = formatCompactTime(item);
            const description = sanitizeText(item.description);
            return (
              <article
                key={item.situationId}
                className={`situation-row situation-row--${modifier}`}
              >
                <div className="situation-row__head">
                  <h2 className="situation-row__title">
                    <SeverityDot severity={item.severity} />
                    {sanitizeText(item.title) || 'Tuntematon tapahtuma'}
                  </h2>
                  {time && <p className="situation-row__time">{time}</p>}
                </div>
                {description && <p className="situation-row__desc">{description}</p>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
