import { useSituations } from '../api/queries';
import { CATEGORY_EMOJI, CATEGORY_LABELS, type Category } from '../api/types';
import { SeverityDot } from '../components/SeverityDot';
import { distinctDescription, formatCompactTime, sanitizeText, sourceLink } from '../lib/format';

interface Props {
  category: Category;
}

/**
 * Yhden kategorian näkymä (Liikenne, Säävaroitukset, Poliisi, Joukkoliikenne).
 *
 * Jokainen tilanne on oma, koko leveyden levyinen elementti — ei yhtä
 * koostekorttia. Taustaväri tulee tapahtumatyypistä (sama kuin Nyt-sivun
 * koostekortilla) ja infoteksti näytetään kokonaisuudessaan.
 *
 * Taustana on muiden sivujen tapaan tasainen `--bg` (Lähteiden tila,
 * Liikennekamerat) — Nyt-sivun taustakuvaa (`now-backdrop`) ei käytetä täällä,
 * jotta tilannelista pysyy rauhallisena luettavana.
 */
export function CategoryPage({ category }: Props) {
  const { data, isLoading, error } = useSituations({ category, limit: 200 });
  const items = data?.items ?? [];
  const label = CATEGORY_LABELS[category] ?? category;
  const modifier = category.toLowerCase().replace(/_/g, '-');

  return (
    <section className="page">
      <h1 className="page__title">
        <span aria-hidden="true">{CATEGORY_EMOJI[category]}</span> {label}
      </h1>

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
            const title = sanitizeText(item.title) || 'Tuntematon tapahtuma';
            const description = distinctDescription(title, sanitizeText(item.description));
            const link = sourceLink(item.url);
            return (
              <article
                key={item.situationId}
                className={`situation-row situation-row--${modifier}`}
              >
                <div className="situation-row__head">
                  <h2 className="situation-row__title">
                    <SeverityDot severity={item.severity} />
                    {title}
                  </h2>
                  {time && <p className="situation-row__time">{time}</p>}
                </div>
                {description && <p className="situation-row__desc">{description}</p>}
                {/* Lähteen oma lisätietolinkki (esim. poliisin tiedote). */}
                {link && (
                  <a
                    className="situation-row__link"
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Lue koko tiedote: {link.label} ↗
                  </a>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
