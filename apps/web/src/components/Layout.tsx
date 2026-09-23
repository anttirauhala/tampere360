import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/', label: 'Nyt', end: true },
  { to: '/kartta', label: 'Kartta', end: false },
  { to: '/liikenne', label: 'Liikenne', end: false },
  { to: '/kamerat', label: 'Liikennekamerat', end: false },
  { to: '/saa', label: 'Säävaroitukset', end: false },
  { to: '/poliisi', label: 'Poliisi', end: false },
  { to: '/joukkoliikenne', label: 'Joukkoliikenne poikkeustilanteet', end: false },
  { to: '/lahteet', label: 'Lähteiden tila', end: false },
];

/** Sovelluksen runko: otsikko, navigaatio, sisältö, attribuutiot. */
export function Layout() {
  return (
    <div className="app">
      <header className="header">
        <div className="header__inner">
          <NavLink to="/" className="brand" end>
            <span className="brand__mark">T247</span>
            <span className="brand__text">
              <strong>Tampere 247</strong>
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
          . Säävaroitukset: Ilmatieteen laitos (CC BY 4.0). Liikennetiedotteet ja kelikamerat:
          Fintraffic / Digitraffic. Poliisitiedotteet: Sisä-Suomen poliisilaitos. Joukkoliikenne:
          Nysse / Waltti.
        </p>
        {/*
          Vakavuusluokittelu on oma arviomme (otsikon ja lähdetietojen
          perusteella), joten se kerrotaan käyttäjälle avoimesti — lähde- ja
          lisenssitietojen yhteydessä. Poikkeus: FMI:n CAP-säävaroituksen
          vakavuus tulee suoraan lähteen omasta severity-kentästä
          (extreme/severe/moderate), ei meidän päätelmästämme.
        */}
        <p className="footer__note">
          Vakavuusluokittelu (tiedote, vähäinen, merkittävä, kriittinen) on Tampere 247:n
          automaattisesti tekemä arvio otsikon ja lähdetietojen perusteella — ei viranomaisen antama
          luokitus. Poikkeus: säävaroitusten vakavuus tulee suoraan Ilmatieteen laitoksen
          varoitusluokasta.
        </p>
        <p className="footer__note">
          Palvelu kokoaa julkiset tiedotteet yhteen näkymään. Tarkista virallinen tieto aina
          alkuperäisestä lähteestä.
        </p>
      </footer>
    </div>
  );
}
