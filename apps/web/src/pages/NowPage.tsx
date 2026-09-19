import { Link } from 'react-router-dom';

import { useSituations } from '../api/queries';
import { CATEGORY_LABELS, type Category } from '../api/types';
import { SituationList } from '../components/SituationList';

const ORDER: Category[] = ['TRAFFIC', 'WEATHER', 'POLICE', 'PUBLIC_TRANSPORT', 'EVENT', 'RAIL'];

const ROUTES: Partial<Record<Category, string>> = {
  TRAFFIC: '/liikenne',
  WEATHER: '/saa',
  POLICE: '/poliisi',
  PUBLIC_TRANSPORT: '/joukkoliikenne',
};

/** "Nyt"-näkymä: aktiiviset tilanteet kategorioittain (§11). */
export function NowPage() {
  const { data, isLoading, error } = useSituations({ limit: 200 });
  const items = data?.items ?? [];

  const counts = new Map<Category, number>();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }

  return (
    <section className="page">
      <h1 className="page__title">Nyt</h1>
      <p className="page__lead">
        Aktiiviset häiriöt ja varoitukset Tampereen seudulla. Tiedot päivittyvät automaattisesti 30
        sekunnin välein.
      </p>

      <div className="tiles">
        <div className="tile tile--total">
          <span className="tile__value">{isLoading ? '–' : items.length}</span>
          <span className="tile__label">aktiivista tilannetta</span>
        </div>
        {ORDER.filter((category) => counts.has(category)).map((category) => {
          const route = ROUTES[category];
          const content = (
            <>
              <span className="tile__value">{counts.get(category)}</span>
              <span className="tile__label">{CATEGORY_LABELS[category]}</span>
            </>
          );
          return route ? (
            <Link key={category} to={route} className="tile">
              {content}
            </Link>
          ) : (
            <div key={category} className="tile">
              {content}
            </div>
          );
        })}
      </div>

      <SituationList items={items} isLoading={isLoading} error={error} />
    </section>
  );
}
