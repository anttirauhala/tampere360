import { useMapFeatures } from '../api/queries';
import { MapView } from '../components/MapView';

/** Karttanäkymä: tilanteet pisteinä (§11). */
export function MapPage() {
  const { data, isLoading, error } = useMapFeatures();
  const features = data?.features ?? [];

  return (
    <section className="page page--map">
      <h1 className="page__title">Kartta</h1>
      <p className="page__lead">
        {isLoading
          ? 'Ladataan karttatietoja…'
          : `${features.length} tilannetta, joilla on koordinaatit.`}{' '}
      </p>
      <p>
        Värilliset pisteet kertovat vakavuuden (keltainen = vähäinen, oranssi = merkittävä, punainen
        = kriittinen).
      </p>

      {error && (
        <p className="state state--error">Karttatietojen haku epäonnistui: {error.message}</p>
      )}

      <MapView features={features} />

      {!isLoading && features.length === 0 && !error && (
        <p className="state">
          Yhdelläkään aktiivisella tilanteella ei ole vielä koordinaatteja. Koordinaatit lisätään
          geokoodauksen myötä (esim. poliisitiedotteille).
        </p>
      )}
    </section>
  );
}
