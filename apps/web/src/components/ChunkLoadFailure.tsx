import { hardReload } from '../lib/chunk-reload';

interface Props {
  /** Sivun osan nimi sellaisena kuin käyttäjä sen tuntee, esim. "Kartta". */
  label: string;
}

/**
 * Ilmoitus, kun lazy-ladattavaa sivun osaa (chunk) ei saatu ladattua edes
 * uudelleenlatauksen jälkeen (ks. lib/chunk-reload.ts).
 *
 * Tyypillisin syy: käyttäjällä on ollut sivu auki deployn yli ja selaimen
 * muistissa on vanha `index.html`, jonka chunk-nimiä ei enää ole olemassa.
 * Tällöin yksi uudelleenlataus riittää — tämä ilmoitus näytetään vasta, jos
 * sekään ei auttanut (esim. verkko on poikki).
 */
export function ChunkLoadFailure({ label }: Props) {
  return (
    <div className="state state--error" role="alert">
      <p>
        Sivun osaa “{label}” ei saatu ladattua. Sovellus on saatettu päivittää sillä välin — lataa
        sivu uudelleen.
      </p>
      <button type="button" className="state__retry" onClick={hardReload}>
        Lataa sivu uudelleen
      </button>
    </div>
  );
}
