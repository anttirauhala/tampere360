import { useState } from 'react';

import { formatTime } from '../lib/format';
import { cameraImageTime, formatDistance, type TrafficCamera } from '../lib/cameras';

interface Props {
  camera: TrafficCamera;
  /**
   * Kuvien cache-avain: vaihtuu aina, kun tiedot haetaan uudelleen, jolloin
   * selain hakee kuvat uudelleen sen sijaan että näyttäisi välimuistista.
   */
  version: number;
  /** Valittu kamera (preset) kyseisellä asemalla. */
  selectedPresetId: string | undefined;
  onSelectPreset: (stationId: string, presetId: string) => void;
}

/**
 * Yksi kelikamera: kuva, aseman nimi, etäisyys ja kameran valinta.
 *
 * Kuva on linkki täysikokoiseen kuvaan (avautuu uuteen välilehteen), ja
 * `loading="lazy"` pitää alkuperäisen latauksen kevyenä — kuvia on ~24 ja
 * yksi kuva on n. 150 kt.
 */
export function CameraCard({ camera, version, selectedPresetId, onSelectPreset }: Props) {
  // Asemalla on aina vähintään yksi kamera (ks. lib/cameras.ts suodatus).
  const [firstPreset] = camera.presets;
  const preset = camera.presets.find((item) => item.id === selectedPresetId) ?? firstPreset;
  if (!preset) return null;

  // Jos sama kuva ei lataudu, virhe ei jää "jumiin" seuraavaan päivitykseen.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = `${preset.imageUrl}?v=${version}`;
  const failed = failedSrc === src;

  // Kuvan todellinen kuvausaika (ei asemaluettelon metatietoa, ks. lib/cameras.ts).
  const imageTime = cameraImageTime(camera, preset);

  return (
    <article className="camera-card">
      {failed ? (
        <p className="camera-card__error">Kuvan lataus epäonnistui.</p>
      ) : (
        <a
          className="camera-card__link"
          href={preset.imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Avaa kuva isompana"
        >
          <img
            className="camera-card__img"
            src={src}
            alt={`Kelikamera ${camera.label}`}
            loading="lazy"
            decoding="async"
            onError={() => setFailedSrc(src)}
          />
        </a>
      )}

      <div className="camera-card__body">
        <h2 className="camera-card__title">{camera.label}</h2>
        <p className="camera-card__meta">
          {formatDistance(camera.distanceKm)} keskustasta
          {imageTime ? ` · kuva ${formatTime(imageTime)}` : ''}
        </p>

        {/* Useampi kamera samalla asemalla = käyttäjä voi vaihtaa kuvaa. */}
        {camera.presets.length > 1 && (
          <div className="camera-card__presets" role="group" aria-label="Aseman kamerat">
            <span className="camera-card__presets-label">Kamerat:</span>
            {camera.presets.map((item, index) => {
              const active = item.id === preset.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={active ? 'camera-chip camera-chip--active' : 'camera-chip'}
                  title={item.id}
                  aria-label={`Kamera ${index + 1} / ${camera.presets.length}`}
                  aria-pressed={active}
                  onClick={() => onSelectPreset(camera.stationId, item.id)}
                >
                  {index + 1}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}
