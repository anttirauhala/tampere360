import { useCurrentWeather } from '../api/queries';
import { formatAge } from '../lib/format';
import {
  describeCondition,
  formatTemperatureC,
  formatWindSpeed,
  windDirectionText,
} from '../lib/weather';

/**
 * Pieni sääkortti Nyt-sivun otsikkoriville (§31): Tampereen nykyinen sää.
 *
 * Kortti on täydentävä tieto, joten hakuvirhe ei näytä virhettä eikä rikko
 * sivua — se vain jää pois. Luvut tulevat suoraan havainnosta; ainoa oma
 * tulkintamme on lyhyt kuvaus (esim. "Puolipilvistä"), joka kerrotaan
 * avoimesti sekä kortin `title`-tekstissä että footterissa.
 */
const CONDITION_TITLE = 'Tampere 247:n tulkinta pilvisyydestä ja sateesta';

export function WeatherCard() {
  const { data, isLoading, error } = useCurrentWeather();

  // Sää on lisätietoa: virhe tai puuttuva data ei näy eikä riko otsikkoriviä.
  if (error) return null;

  if (isLoading || !data) {
    return (
      <aside className="weather-card weather-card--loading" aria-label="Tampereen nykyinen sää">
        Haetaan säätä…
      </aside>
    );
  }

  const temperature = formatTemperatureC(data.temperatureC);
  const condition = describeCondition(data);
  const wind = formatWindSpeed(data.windSpeedMs);
  const direction = windDirectionText(data.windDirectionDeg);
  const age = formatAge(data.observedAt);

  // Yksi rivi lisiätietoja: vain ne, jotka havainnossa on (§20).
  const meta: string[] = [];
  if (wind) meta.push(`Tuuli ${wind}${direction ? ` ${direction}` : ''}`);
  if (data.humidityPct !== null && Number.isFinite(data.humidityPct)) {
    meta.push(`Kosteus ${Math.round(data.humidityPct)} %`);
  }

  return (
    <aside className="weather-card" aria-label="Tampereen nykyinen sää">
      <div className="weather-card__main">
        {condition && (
          <span className="weather-card__icon" aria-hidden="true" title={CONDITION_TITLE}>
            {condition.emoji}
          </span>
        )}
        <span className="weather-card__temp">{temperature || '—'}</span>
      </div>

      {condition && (
        <p className="weather-card__condition" title={CONDITION_TITLE}>
          {condition.label}
        </p>
      )}

      {meta.length > 0 && <p className="weather-card__meta">{meta.join(' · ')}</p>}

      <p className="weather-card__source">
        {age ? `${age} · ` : ''}
        {data.station.name}
      </p>
    </aside>
  );
}
