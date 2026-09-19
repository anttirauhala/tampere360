import type { SituationSummary } from '../api/types';
import { SituationCard } from './SituationCard';

interface Props {
  items: SituationSummary[] | undefined;
  isLoading: boolean;
  error: Error | null;
  emptyText?: string;
}

/** Tilannelista: lataus-, virhe- ja tyhjätilat + kortit. */
export function SituationList({ items, isLoading, error, emptyText }: Props) {
  if (isLoading) {
    return <p className="state state--loading">Ladataan tilannetietoja…</p>;
  }

  if (error) {
    return (
      <div className="state state--error">
        <p>Tilannetietojen haku epäonnistui.</p>
        <p className="state__detail">{error.message}</p>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return <p className="state">{emptyText ?? 'Ei aktiivisia tilanteita juuri nyt.'}</p>;
  }

  return (
    <div className="cards">
      {items.map((item) => (
        <SituationCard key={item.situationId} item={item} />
      ))}
    </div>
  );
}
