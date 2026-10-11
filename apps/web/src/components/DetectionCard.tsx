import { useState } from 'react';

import type { CameraDetection } from '../api/camera-detections';
import {
  IMAGE_UNAVAILABLE_TEXT,
  bboxBoxStyle,
  cameraSubtitle,
  cameraTitle,
  classifyDetection,
  detectionHeadline,
  formatBbox,
  formatScore,
  formatScoreExact,
  imageNotice,
} from '../lib/camera-detections';
import { formatAge, formatTime } from '../lib/format';

interface Props {
  item: CameraDetection;
}

/**
 * Yksi kamerahavainto: alkuperäinen kuva, bounding boxit ja tarkat tiedot.
 *
 * Kolme ratkaisua, jotka on syytä tuntea:
 *
 *  1. **Bounding boxit piirretään itse.** Lähdepalvelun `processedImageKey` on
 *     `null` myös osumilla, joten merkittyä kuvaa ei ole saatavilla — mutta
 *     bbox-koordinaatit ja confidence tulevat detaljivastauksessa. Laatikot
 *     sijoitetaan prosentteina kuvan luonnollisesta koosta (`onLoad` →
 *     `naturalWidth`), joten ne skaalautuvat mihin tahansa kuvakokoon.
 *  2. **Puuttuva kuva ei ole virhe.** Lähdepalvelu arkistoi raw-kuvat 90 päivän
 *     jälkeen, jolloin presigned-GET palautuu 403:na; silloin kortti kertoo
 *     syyn. Sama `onError`-malli kuin `CameraCard`issa (§25).
 *  3. **Confidence on aina näkyvissä** prosentteina — mallin arvio on usein
 *     matala, eikä sitä saa piilottaa (§20: epävarmaa ei esitetä varmana).
 */
export function DetectionCard({ item }: Props) {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);

  const detections = item.detections ?? [];
  // Kuva jää näyttämättä, jos osoite puuttuu tai lataus epäonnistui
  // (`onError`). Molemmissa tapauksissa kerrotaan sama asia lyhyesti.
  const notice = failed ? IMAGE_UNAVAILABLE_TEXT : imageNotice(item);

  return (
    <article className="detection-card">
      <div className="detection-card__frame">
        {notice ? (
          <p className="detection-card__image-missing">{notice}</p>
        ) : (
          <>
            <a
              className="detection-card__link"
              href={item.imageUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              title="Avaa alkuperäinen kuva uuteen välilehteen"
            >
              <img
                className="detection-card__img"
                src={item.imageUrl ?? undefined}
                alt={`Kamerakuva: ${cameraTitle(item.camera)}`}
                loading="lazy"
                decoding="async"
                onLoad={(event) =>
                  setImageSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setFailed(true)}
              />
            </a>
            {/* Laatikot ovat koristeita: klikkaus menee läpi kuvalinkille. */}
            {detections.map((detection, index) => {
              const style = bboxBoxStyle(
                detection.bbox,
                imageSize?.width ?? null,
                imageSize?.height ?? null,
              );
              if (!style) return null;
              const info = classifyDetection(detection.label);
              const score = formatScore(detection.score);
              return (
                <span
                  key={`${detection.label}-${index}`}
                  className={`detection-box detection-box--${info.kind}`}
                  style={style}
                  title={`${info.label}${score ? ` ${score}` : ''}`}
                />
              );
            })}
          </>
        )}
      </div>

      <div className="detection-card__body">
        <h2 className="detection-card__title">{cameraTitle(item.camera)}</h2>
        <p className="detection-card__camera">
          {cameraSubtitle(item.camera) || item.camera.cameraId}
        </p>

        <div className="detection-card__classes">
          {detections.length > 0 ? (
            detections.map((detection, index) => {
              const info = classifyDetection(detection.label);
              const score = formatScore(detection.score);
              return (
                <span
                  key={`${detection.label}-badge-${index}`}
                  className={`detection-badge detection-badge--${info.kind}`}
                >
                  {info.label}
                  {score ? ` · ${score}` : ''}
                </span>
              );
            })
          ) : (
            <span className="detection-badge detection-badge--unknown">
              {detectionHeadline(item)}
            </span>
          )}
        </div>

        <p className="detection-card__time">
          Kuva {formatTime(item.capturedAt)}
          {item.capturedAt ? ` · ${formatAge(item.capturedAt)}` : ''}
        </p>

        {/* "Tarkat tiedot": lähteen kentät sellaisinaan, jotta havainto on
            jäljitettävissä ja tarkistettavissa. */}
        <dl className="detection-card__details">
          <dt>Kamera</dt>
          <dd>{item.camera.cameraId}</dd>

          <dt>Kuvausaika</dt>
          <dd>{item.capturedAt || '—'}</dd>

          <dt>Analyysiaika</dt>
          <dd>{item.processedAt ? formatTime(item.processedAt) : '—'}</dd>

          <dt>Havaintoja</dt>
          <dd>{item.detectionCount}</dd>

          <dt>Luokat</dt>
          <dd>{item.detectedClasses.length > 0 ? item.detectedClasses.join(', ') : '—'}</dd>

          <dt>Analyysin tila</dt>
          <dd>{item.processingStatus || '—'}</dd>

          {detections.length > 0 && (
            <>
              <dt>Confidencet</dt>
              <dd>
                {detections
                  .map((detection) => {
                    const info = classifyDetection(detection.label);
                    const exact = formatScoreExact(detection.score);
                    const bbox = formatBbox(detection.bbox);
                    return `${info.label} ${exact}${bbox ? ` (${bbox})` : ''}`;
                  })
                  .join('; ')}
              </dd>
            </>
          )}

          <dt>Kuva-avain</dt>
          <dd>{item.imageKey}</dd>
        </dl>
      </div>
    </article>
  );
}
