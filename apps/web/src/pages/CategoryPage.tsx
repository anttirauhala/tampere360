import { useSituations } from '../api/queries';
import { CATEGORY_LABELS, type Category } from '../api/types';
import { SituationList } from '../components/SituationList';

interface Props {
  category: Category;
}

/** Yhden kategorian näkymä (Liikenne, Säävaroitukset, Poliisi, Joukkoliikenne). */
export function CategoryPage({ category }: Props) {
  const { data, isLoading, error } = useSituations({ category, limit: 200 });
  const items = data?.items ?? [];

  return (
    <section className="page">
      <h1 className="page__title">{CATEGORY_LABELS[category]}</h1>
      <p className="page__lead">
        {items.length} aktiivista tilannetta kategoriassa {CATEGORY_LABELS[category]}.
      </p>
      <SituationList
        items={items}
        isLoading={isLoading}
        error={error}
        emptyText={`Ei aktiivisia tilanteita kategoriassa ${CATEGORY_LABELS[category]}.`}
      />
    </section>
  );
}
