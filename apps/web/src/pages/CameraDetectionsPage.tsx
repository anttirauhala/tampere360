import { useMemo, useState } from 'react';

import { DETECTION_MAX_LIMIT, DETECTION_PAGE_SIZE } from '../api/camera-detections';
import { useCameraDetections } from '../api/queries';
import { DetectionCard } from '../components/DetectionCard';
import { sortNewestFirst } from '../lib/camera-detections';
import { formatTime } from '../lib/format';

/**
 * Kamerahavainnot-välilehti (§43): lähdepalvelun automaattiset havainnot,
 * joissa kamerakuvassa on ihminen tai eläin.
 *
 * Kaksi tarkoituksellista rajausta:
 *
 *  1. **Aikaikkuna on kiinteä 60 vrk.** Lähdepalvelu arkistoi alkuperäiset kuvat
 *     noin 90 päivän jälkeen, joten ikkuna pidetään selvästi sen alla —
 *     alkuperäinen kuva on tämän näkymän pointti. Vanhempia havaintoja **ei
 *     näytetä eikä niitä voi pyytää** (API:ssa ei ole `days`-parametria eikä
 *     käyttöliittymässä ole "näytä vanhemmat" -valintaa).
 *  2. **Sivutus sivukoon kasvatuksella.** "Näytä enemmän" kasvattaa `limit`iä
 *     (12 → 30) sen sijaan että ketjuttaisi kursoreita: yksi pyyntö per
 *     päivitys eikä peräkkäisriippuvuuksia. API tukee myös kursoria
 *     (`nextCursor`), jos pidempää historiaa halutaan myöhemmin.
 */
export function CameraDetectionsPage() {
  const [limit, setLimit] = useState<number>(DETECTION_PAGE_SIZE);
  const { data, isLoading, isFetching, error, refetch } = useCameraDetections(limit);

  const items = useMemo(() => sortNewestFirst(data?.items ?? []), [data]);

  return (
    <section className="page">
      <h1 className="page__title">Kamerahavainnot</h1>
      <p className="page__lead">
        Tampereen alueen liikennekameroiden automaattiset analyysit, joissa on tunnistettu ihminen
        tai eläin.
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
          {isFetching ? 'Päivitetään…' : 'Päivitä'}
        </button>

        {data && (
          <span className="camera-toolbar__info">
            {data.count} havaintoa viimeisen {data.windowDays} vrk ajalta · haettu{' '}
            {formatTime(data.fetchedAt)}
            {data.imagesUnavailable > 0 ? ` · ${data.imagesUnavailable} ilman kuvaa` : ''}
            {data.stale ? ' · lähde ei vastannut, näytetään vanhempi haku' : ''}
          </span>
        )}
      </div>

      {isLoading && <p className="state state--loading">Ladataan kamerahavaintoja…</p>}

      {error && (
        <div className="state state--error">
          <p>Kamerahavaintojen haku epäonnistui.</p>
          <p className="state__detail">{error.message}</p>
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <p className="state">
          Ei havaintoja{data ? ` viimeisen ${data.windowDays} vrk ajalta` : ''}. Analyysi ajetaan
          tunneittain klo 9–16, joten uusin tulos voi olla edellisen tunnin ajalta.
        </p>
      )}

      {items.length > 0 && (
        <div className="detection-grid">
          {items.map((item) => (
            <DetectionCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {data?.hasMore && limit < DETECTION_MAX_LIMIT && (
        <p className="detection-more">
          <button
            type="button"
            className="button button--secondary"
            onClick={() =>
              setLimit((current) => Math.min(DETECTION_MAX_LIMIT, current + DETECTION_PAGE_SIZE))
            }
            disabled={isFetching}
          >
            Näytä enemmän havaintoja
          </button>
        </p>
      )}

      <p className="page__note">
        Analyysi: <strong>traffic-cam-analyzer</strong> (YOLO World XL, Replicate) — automaattinen
        konepäätelmä, ei vahvistettu havainto. Prosentti on mallin confidence, ja matalakin arvo
        näytetään: havainto voi olla virheellinen. Kamerakuvat: Fintraffic / Digitraffic (CC BY
        4.0). Kamerakuvia analysoidaan 5 km etäisyydellä Tampereen keskustasta. Analyysi ajetaan
        tunneittain klo 9–16 Suomen aikaa, joten havainnot eivät ole reaaliaikaisia.
      </p>
    </section>
  );
}
