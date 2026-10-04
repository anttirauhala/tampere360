/**
 * Ajoneuvoikonit piirretään canvasilla ajonaikaisesti (§27).
 *
 * Miksi canvas eikä ulkoisia kuvatiedostoja tai kartan tekstikerrosta:
 *  - MapLibren `symbol`-tekstikerros (`text-field`) vaatii glyph-lähteen
 *    (fonttipaketit). Rasteritiilistylessämme ei ole `glyphs`-määrittelyä, ja
 *    ulkoinen fonttipalvelin olisi uusi riippuvuus sekä CSP-muutos.
 *  - Canvasilla myös **linjanumero saadaan osaksi ikonia**, jolloin kartalla ei
 *    tarvita tekstikerrosta lainkaan.
 *  - Ei uusia asset-tiedostoja eikä CSP-muutoksia (sama origin + blob).
 *
 * Tämä moduuli käyttää DOM:ia (`document.createElement`), joten sitä ei
 * testata Nodessa — logiikka on tahallaan mahdollisimman yksinkertaista.
 */

import type { VehicleMode } from '../api/types';

/** Ikoneiden värit. Erottuvat vakavuusväreistä (keltainen/oranssi/punainen). */
export const MODE_COLORS: Record<VehicleMode, string> = {
  TRAM: '#34d399',
  BUS: '#60a5fa',
};

/** Piirto tehdään 2×-tarkkuudella, jotta ikonit pysyvät terävinä. */
export const ICON_PIXEL_RATIO = 2;

/**
 * Ajoneuvon rungon mitat (CSS-pikseliä, pituus kulkusuunnassa):
 * ratikka on **ohut ja pitkä** suorakulmio, bussi **lyhyempi** ja hieman leveämpi.
 */
export const BODY_SHAPES: Record<VehicleMode, { length: number; width: number }> = {
  TRAM: { length: 20, width: 6 },
  BUS: { length: 13, width: 8 },
};

function createCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * ICON_PIXEL_RATIO);
  canvas.height = Math.ceil(height * ICON_PIXEL_RATIO);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D-piirtokontekstia ei saatu');
  ctx.scale(ICON_PIXEL_RATIO, ICON_PIXEL_RATIO);
  return { canvas, ctx };
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** Ikoni-id, jota kartan symbolikerros käyttää. */
export function bodyIconId(mode: VehicleMode): string {
  return `vehicle-body-${mode}`;
}

/** Linjanumerotunnisteen ikoni-id: yksi kuva per muoto ja linja. */
export function lineTagIconId(mode: VehicleMode, line: string): string {
  return `vehicle-tag-${mode}-${line}`;
}

/**
 * Ajoneuvon runko. Piirretään pystyasentoon (pituus Y-akselilla), koska
 * MapLibre kiertää ikonin `icon-rotate`-arvon (bearing, 0 = pohjoinen) mukaan:
 * pystyasento vastaa siis suoraan pohjoiseen kulkevaa ajoneuvoa.
 *
 * Keula merkitään vaaleammalla kärjellä, jotta suunta on luettavissa myös
 * silloin, kun ajoneuvo ei liiku (bearing 0).
 */
export function createBodyIcon(mode: VehicleMode): ImageData {
  const shape = BODY_SHAPES[mode];
  const padding = 3;
  const width = shape.width + padding * 2;
  const height = shape.length + padding * 2;
  const { canvas, ctx } = createCanvas(width, height);

  const x = padding;
  const y = padding;

  ctx.fillStyle = MODE_COLORS[mode];
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  roundedRect(ctx, x, y, shape.width, shape.length, Math.min(shape.width, shape.length) / 3);
  ctx.fill();
  ctx.stroke();

  // Keula: vaalea kärki kertoo kulkusuunnan.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  roundedRect(ctx, x + 1, y + 1, shape.width - 2, shape.length * 0.28, 1);
  ctx.fill();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Linjanumerotunniste (esim. `1`, `80`, `40A`): valkoinen pyöristetty laatta,
 * jonka reunus on muodon värinen. Teksti piirretään canvasilla, joten kartalla
 * ei tarvita glyph-lähdettä.
 */
export function createLineTagIcon(line: string, mode: VehicleMode): ImageData {
  const fontSize = 11;
  const paddingX = 5;
  const height = 15;
  const font = `bold ${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  // Mitataan tekstin leveys erillisellä canvasilla (sama fontti).
  const measure = document.createElement('canvas').getContext('2d');
  let textWidth = line.length * fontSize * 0.6;
  if (measure) {
    measure.font = font;
    textWidth = measure.measureText(line).width;
  }

  const width = Math.ceil(textWidth + paddingX * 2);
  const { canvas, ctx } = createCanvas(width, height);

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = MODE_COLORS[mode];
  ctx.lineWidth = 2;
  roundedRect(ctx, 1, 1, width - 2, height - 2, 5);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#0b1220';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(line, width / 2, height / 2 + 0.5);

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
