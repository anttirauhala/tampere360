import { useMemo, useState } from 'react';

import { useCameraData } from '../api/queries';
import { CameraCard } from '../components/CameraCard';
import { CAMERA_RADIUS_KM, toTrafficCameras } from '../lib/cameras';
import { formatTime } from '../lib/format';

/**
 * Liikennekamerat-välilehti: Tampereen alueen kelikamerat.
 *
 * Kuvat tulevat suoraan Digitrafficilta (ks. api/cameras.ts) — ne eivät kulje
 * oman API:n kautta. Lista suodatetaan `lib/cameras.ts`:ssä: vain alle 10 km
 * päässä Tampereen keskustasta olevat asemat, joilla on kuvauskierrossa oleva
 * kamera.
 */
export function CamerasPage() {
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useCameraData();

  /** Valittu kamera (preset) asemittain; oletus on aseman ensimmäinen kamera. */
  const [selected, setSelected] = useState<Record<string, string>>({});

  const cameras = useMemo(() => toTrafficCameras(data?.stations, data?.data), [data]);

  // Cache-avain kuville: sama arvo niin kauan kuin dataa ei ole haettu uudelleen.
  const version = dataUpdatedAt || 1;

  const handleSelectPreset = (stationId: string, presetId: string) => {
    setSelected((previous) => ({ ...previous, [stationId]: presetId }));
  };

  return (
    <section className="page">
      <h1 className="page__title">Liikennekamerat</h1>
      <p className="page__lead">
        Tampereen alueen kelikamerat — alle {CAMERA_RADIUS_KM} km päässä keskustasta.
      </p>

      <div className="camera-toolbar">
        <button
          type="button"
          className="button"
          onClick={() => {
            void refetch();
          }}
          disabled={isFetching}
        >
          {isFetching ? 'Päivitetään…' : 'Päivitä kuvat'}
        </button>
        {dataUpdatedAt > 0 && (
          <span className="camera-toolbar__info">
            {cameras.length} kameraa · tiedot haettu{' '}
            {formatTime(new Date(dataUpdatedAt).toISOString())}
          </span>
        )}
      </div>

      {isLoading && <p className="state state--loading">Ladataan kameratietoja…</p>}

      {error && (
        <div className="state state--error">
          <p>Kameratietojen haku epäonnistui.</p>
          <p className="state__detail">{error.message}</p>
        </div>
      )}

      {!isLoading && !error && cameras.length === 0 && (
        <p className="state">Ei kameroita {CAMERA_RADIUS_KM} km säteellä Tampereen keskustasta.</p>
      )}

      {cameras.length > 0 && (
        <div className="camera-grid">
          {cameras.map((camera) => (
            <CameraCard
              key={camera.stationId}
              camera={camera}
              version={version}
              selectedPresetId={selected[camera.stationId]}
              onSelectPreset={handleSelectPreset}
            />
          ))}
        </div>
      )}

      <p className="page__note">
        Kuvat: Fintraffic / Digitraffic (CC BY 4.0). Kamerat päivittyvät noin 10 minuutin välein,
        joten kuva voi olla hetken vanha. Kuvan yhteydessä näkyvä aika on kuvan kuvausaika Suomen
        ajassa. Kuvan napsauttaminen avaa täysikokoisen kuvan uuteen välilehteen.
      </p>
    </section>
  );
}
