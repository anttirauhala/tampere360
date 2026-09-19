import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/', label: 'Nyt', end: true },
  { to: '/kartta', label: 'Kartta', end: false },
  { to: '/liikenne', label: 'Liikenne', end: false },
  { to: '/saa', label: 'Säävaroitukset', end: false },
  { to: '/poliisi', label: 'Poliisi', end: false },
  { to: '/joukkoliikenne', label: 'Joukkoliikenne', end: false },
  { to: '/lahteet', label: 'Lähteiden tila', end: false },
];

/** Sovelluksen runko: otsikko, navigaatio, sisältö, attribuutiot. */
export function Layout() {
  return (
    <div className="app">
      <header className="header">
        <div className="header__inner">
          <NavLink to="/" className="brand" end>
            <span className="brand__mark">T360</span>
            <span className="brand__text">
              <strong>Tampere360</strong>
              <small>Tampereen seudun tilannekuva</small>
            </span>
          </NavLink>
          <nav className="nav" aria-label="Päänavigaatio">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  isActive ? 'nav__link nav__link--active' : 'nav__link'
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="main">
        <Outlet />
      </main>

      <footer className="footer">
        <p>
          Tiedot ovat avoimesta datasta. Karttatiilet: ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors
          </a>
          . Säävaroitukset: Ilmatieteen laitos (CC BY 4.0). Liikennetiedotteet: Fintraffic /
          Digitraffic. Poliisitiedotteet: Sisä-Suomen poliisilaitos. Joukkoliikenne: Nysse / Waltti.
        </p>
        <p className="footer__note">
          Palvelu kokoaa julkiset tiedotteet yhteen näkymään. Tarkista virallinen tieto aina
          alkuperäisestä lähteestä.
        </p>
      </footer>
    </div>
  );
}
