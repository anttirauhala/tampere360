import { useSourceHealth } from '../api/queries';
import { SOURCE_LABELS } from '../api/types';
import { formatAge, formatTime } from '../lib/format';

const STATUS_LABELS: Record<string, string> = {
  OK: 'Kunnossa',
  ERROR: 'Virhe',
  STALE: 'Vanhentunut',
  DISABLED: 'Pois käytöstä',
  UNKNOWN: 'Tuntematon',
};

/** Lähteiden tila -näkymä: viimeisin haku, tietuemäärät, virheet (§10, §13). */
export function SourcesPage() {
  const { data, isLoading, error } = useSourceHealth();
  const sources = data?.sources ?? [];

  return (
    <section className="page">
      <h1 className="page__title">Lähteiden tila</h1>
      <p className="page__lead">
        Jokainen lähde päivittää oman tilatietonsa jokaisen haun jälkeen. "Vanhentunut" tarkoittaa,
        että viimeisimmästä onnistuneesta hausta on yli 30 minuuttia.
      </p>

      {isLoading && <p className="state state--loading">Ladataan lähdetietoja…</p>}
      {error && (
        <p className="state state--error">Lähdetietojen haku epäonnistui: {error.message}</p>
      )}

      {!isLoading && !error && sources.length === 0 && (
        <p className="state">
          Ei lähdetietoja. Adapterit kirjoittavat tilan ensimmäisen ajon jälkeen.
        </p>
      )}

      {sources.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Lähde</th>
              <th>Tila</th>
              <th>Viimeisin haku</th>
              <th>Tietueita</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.source}>
                <td>{SOURCE_LABELS[source.source] ?? source.source}</td>
                <td>
                  <span className={`badge badge--${source.status.toLowerCase()}`}>
                    {STATUS_LABELS[source.status] ?? source.status}
                  </span>
                  {source.error && <div className="table__error">{source.error.slice(0, 160)}</div>}
                </td>
                <td>
                  {formatTime(source.lastSuccessfulFetch)}
                  {source.lastSuccessfulFetch && (
                    <div className="table__muted">{formatAge(source.lastSuccessfulFetch)}</div>
                  )}
                </td>
                <td>{source.itemsReceived ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="page__note">
        Lähdeluettelo määräytyy infrasta (infra/lib/config.ts). Visit Tampere -tapahtumalähde on
        toistaiseksi pois käytöstä, koska sen rajapinta ei ole enää saatavilla.
      </p>
    </section>
  );
}
