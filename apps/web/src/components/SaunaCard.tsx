import type { Sauna } from '../api/saunas';
import { sanitizeText, sourceLink } from '../lib/format';
import {
  formatAddress,
  formatPrice,
  saunaPrices,
  saunaTodayStatus,
  saunaTodayTone,
  type SaunaWeekday,
  weekdayLabel,
} from '../lib/saunas';

interface Props {
  sauna: Sauna;
  /** Suomen ajassa laskettu viikonpäivä (lasketaan sivulla kerran). */
  weekday: SaunaWeekday;
}

/**
 * Yksi sauna: nimi, osoite, tänään-aukiolo, hinnat ja lisätiedot.
 *
 * Lisätieto (`info`) sanitoidaan ennen renderöintiä — lähteestä tulevaa HTML:ää
 * ei koskaan viedä Reactiin sellaisenaan (§14). Verkkolinkki renderöidään vain
 * http(s)-osoitteesta (`sourceLink`), ja se avataan uuteen välilehteen.
 */
export function SaunaCard({ sauna, weekday }: Props) {
  const info = sanitizeText(sauna.info);
  const link = sourceLink(sauna.webPage);
  const phone = sanitizeText(sauna.phone);
  const prices = saunaPrices(sauna, weekday);
  const today = saunaTodayStatus(sauna, weekday);
  const tone = saunaTodayTone(sauna, weekday);

  return (
    <article className="sauna-card">
      <div className="sauna-card__head">
        <h2 className="sauna-card__title">{sanitizeText(sauna.name)}</h2>
        {sauna.isNew && <span className="sauna-badge sauna-badge--new">Uusi</span>}
      </div>

      <p className="sauna-card__address">{formatAddress(sauna)}</p>

      <dl className="sauna-card__rows">
        <div className="sauna-card__row">
          <dt className="sauna-card__label">Aukiolo tänään ({weekdayLabel(weekday)})</dt>
          <dd className={`sauna-card__value sauna-card__value--${tone}`}>{today}</dd>
        </div>
        <div className="sauna-card__row">
          <dt className="sauna-card__label">Hinnat</dt>
          <dd className="sauna-card__value">
            {prices.length > 0
              ? prices.map((price) => `${price.label} ${formatPrice(price.price)}`).join(' · ')
              : 'Ei hintatietoja'}
          </dd>
        </div>
      </dl>

      {info && <p className="sauna-card__info">{info}</p>}

      <div className="sauna-card__meta">
        {(sauna.kiosk || sauna.restaurant) && (
          <span className="sauna-card__badges">
            {sauna.kiosk && <span className="sauna-badge">Kioski</span>}
            {sauna.restaurant && <span className="sauna-badge">Ravintola</span>}
          </span>
        )}
        {phone && (
          <a className="sauna-card__link" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
            {phone}
          </a>
        )}
        {link && (
          <a
            className="sauna-card__link"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {link.label} ↗
          </a>
        )}
      </div>
    </article>
  );
}
