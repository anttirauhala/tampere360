import { useSituations } from '../api/queries';
import { SummaryCard } from '../components/SummaryCard';
import { CATEGORY_ROUTES, groupByCategory } from '../lib/situations';

/** Kuinka monta tapahtumaa koostekortilla näytetään. */
const PREVIEW_COUNT = 5;

/**
 * "Nyt"-näkymä: aktiiviset tilanteet tapahtumatyypeittäin koostekortteina.
 *
 * Kaikkia tapahtumia ei listata sekaisin — jokainen tyyppi saa oman korttinsa,
 * jossa on viisi viimeisintä tapahtumaa ja linkki tyyppikohtaiselle sivulle.
 */
export function NowPage() {
  const { data, isLoading, error } = useSituations({ limit: 200 });
  const grouped = groupByCategory(data?.items ?? []);

  return (
    <section className="page">
      <h1 className="page__title">Nyt</h1>
      <p className="page__lead">
        Aktiiviset häiriöt ja varoitukset Tampereen seudulla tyypeittäin. Tiedot päivittyvät
        automaattisesti 30 sekunnin välein.
      </p>

      {isLoading && <p className="state state--loading">Ladataan tilannetietoja…</p>}

      {error && (
        <div className="state state--error">
          <p>Tilannetietojen haku epäonnistui.</p>
          <p className="state__detail">{error.message}</p>
        </div>
      )}

      {!isLoading && !error && grouped.size === 0 && (
        <p className="state">Ei aktiivisia tilanteita juuri nyt.</p>
      )}

      {grouped.size > 0 && (
        <div className="cards">
          {[...grouped].map(([category, items]) => (
            <SummaryCard
              key={category}
              category={category}
              items={items.slice(0, PREVIEW_COUNT)}
              total={items.length}
              to={CATEGORY_ROUTES[category]}
            />
          ))}
        </div>
      )}
    </section>
  );
}
