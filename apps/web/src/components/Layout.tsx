import type { ChangeEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { SAUNA_SOURCE_URL } from '../lib/saunas';

/**
 * Päänavigaation järjestys ja nimet.
 *
 * Historia: §29 lyhensi nimet ja siirsi joukkoliikenteen poikkeustilanteet
 * Nysse-välilehden sivupaneeliin; commit 808d50e tarkensi nimiä edelleen
 * ("Etusivu", "Tapahtumat kartalla", "Nysse kartalla"). §30 lisäsi
 * Liikennemäärät-välilehden (mittausasemat) Kameroiden jälkeen.
 */
export const NAV = [
  { to: '/', label: 'Etusivu', end: true },
  { to: '/kartta', label: 'Tapahtumat kartalla', end: false },
  { to: '/nysse-kartta', label: 'Nysse kartalla', end: false },
  { to: '/kamerat', label: 'Kamerat', end: false },
  { to: '/liikennemaarat', label: 'Liikennemäärät', end: false },
  { to: '/saunat', label: 'Saunat', end: false },
  { to: '/lahteet', label: 'Lähteiden tila', end: false },
];

/** Kapean näytön valinta: arvo, kun polku ei vastaa mitään NAV-kohtaa. */
export const NAV_SELECT_PLACEHOLDER = '';

/**
 * Mikä päänavigaation kohde "omistaa" annetun polun. Kapean näytön
 * valintaelementti näyttää tämän; tyhjä merkkijono tarkoittaa, ettei mikään
 * kohta täsmää (esim. /liikenne, /saa, /poliisi ja /joukkoliikenne eivät ole
 * päänavigaatiossa — ne avautuvat Nyt-sivun koostekorteista).
 */
export function activeNavPath(pathname: string): string {
  const match = NAV.find((item) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  return match?.to ?? NAV_SELECT_PLACEHOLDER;
}

/** Sovelluksen runko: otsikko, navigaatio, sisältö, attribuutiot. */
export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentNav = activeNavPath(location.pathname);

  const handleNavSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    const to = event.target.value;
    if (to) navigate(to);
  };

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

            {/*
              Alle 480px:n näytöllä välilehtipainikkeet korvataan
              valintaelementillä, jotta sisällölle jää enemmän tilaa — ks.
              styles.css @media. Vain toinen on kerrallaan näkyvissä, joten
              ruudunlukija ei lue kohteita kahteen kertaan.
            */}
            <label className="nav__select">
              <span className="nav__select-text">Osio</span>
              <select
                className="nav__select-input"
                aria-label="Valitse osio"
                value={currentNav}
                onChange={handleNavSelect}
              >
                {currentNav === NAV_SELECT_PLACEHOLDER && (
                  <option value={NAV_SELECT_PLACEHOLDER} disabled>
                    Valitse osio…
                  </option>
                )}
                {NAV.map((item) => (
                  <option key={item.to} value={item.to}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
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
          . Säävaroitukset ja -havainnot: Ilmatieteen laitos (CC BY 4.0). Liikennetiedotteet,
          kelikamerat ja liikennemittaukset: Fintraffic / Digitraffic. Poliisitiedotteet:
          Sisä-Suomen poliisilaitos. Joukkoliikenteen häiriötiedotteet ja ajoneuvosijainnit: Nysse /
          Waltti (CC BY 4.0). Saunatiedot:{' '}
          <a href={SAUNA_SOURCE_URL} target="_blank" rel="noopener noreferrer">
            saunahaku.fi
          </a>
          . Veden lämpötila: SYKE (CC BY 4.0).
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
          varoitusluokasta. Myös sääkortin lyhyt kuvaus (esim. "Puolipilvistä") on oma tulkintamme
          Ilmatieteen laitoksen havainnosta.
        </p>
        <p className="footer__note">
          Palvelu kokoaa julkiset tiedotteet yhteen näkymään. Tarkista virallinen tieto aina
          alkuperäisestä lähteestä.
        </p>
      </footer>
    </div>
  );
}
