/**
 * Waaiio's QR code look (Owner request 2026-11-19): rounded modules that join
 * into smooth shapes, rounded finder "eyes", and thin corner brackets outside
 * the quiet zone.
 *
 * This file only turns an already-encoded QR matrix into drawing geometry, so
 * the encoded content is whatever the caller's encoder produced. It has no
 * imports, so the main app, the admin app and the server can all share it.
 *
 * Scannability rules kept here:
 *   - the quiet zone is never less than 4 modules;
 *   - the bracket frame sits entirely outside that quiet zone;
 *   - every dark module still covers its own cell, so module centres
 *     (where decoders sample) are unchanged.
 */

/** Anything that can answer "is this module dark?" — e.g. `qrcode`'s `create(...).modules`. */
export interface QrMatrix {
  size: number;
  get(row: number, col: number): number | boolean;
}

export interface StyledQrOptions {
  /** Quiet zone in modules. Values below 4 are raised to 4. */
  margin?: number;
  /** Draw the corner-bracket frame outside the quiet zone. Default true. */
  frame?: boolean;
}

export interface StyledQrGeometry {
  /** Width and height of the whole drawing, in module units (use as the SVG viewBox). */
  units: number;
  /** Data modules, filled with the nonzero rule. */
  modulesPath: string;
  /** Finder rings and centres, filled with the even-odd rule. */
  findersPath: string;
  /** Corner brackets, stroked with round caps; empty when the frame is off. */
  framePath: string;
  /** Stroke width of the brackets, in module units. */
  frameStroke: number;
}

export const MIN_QUIET_ZONE = 4;
/** Width of the band outside the quiet zone that holds the brackets. */
const FRAME_BAND = 2;
const FRAME_STROKE = 0.6;
const FINDER = 7;

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** A rectangle with an individual radius per corner, drawn clockwise. */
function roundedRect(x: number, y: number, w: number, h: number, tl: number, tr: number, br: number, bl: number): string {
  const arc = (r: number, ex: number, ey: number) => (r > 0 ? `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(ex)} ${fmt(ey)}` : `L${fmt(ex)} ${fmt(ey)}`);
  return (
    `M${fmt(x + tl)} ${fmt(y)}` +
    `H${fmt(x + w - tr)}` + arc(tr, x + w, y + tr) +
    `V${fmt(y + h - br)}` + arc(br, x + w - br, y + h) +
    `H${fmt(x + bl)}` + arc(bl, x, y + h - bl) +
    `V${fmt(y + tl)}` + arc(tl, x + tl, y) +
    'Z'
  );
}

function inFinder(row: number, col: number, size: number): boolean {
  const top = row < FINDER;
  const left = col < FINDER;
  const right = col >= size - FINDER;
  const bottom = row >= size - FINDER;
  return (top && left) || (top && right) || (bottom && left);
}

export function styledQrGeometry(matrix: QrMatrix, options: StyledQrOptions = {}): StyledQrGeometry {
  const size = matrix.size;
  const margin = Math.max(MIN_QUIET_ZONE, Math.floor(options.margin ?? MIN_QUIET_ZONE));
  const frame = options.frame !== false;
  const offset = margin + (frame ? FRAME_BAND : 0);
  const units = size + offset * 2;

  const dark = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < size && c < size && !inFinder(r, c, size) && Boolean(matrix.get(r, c));

  // A corner is rounded only when both of its side neighbours are light, so
  // touching modules merge into one smooth shape and lone modules become dots.
  const R = 0.5;
  let modulesPath = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!dark(r, c)) continue;
      const up = dark(r - 1, c);
      const down = dark(r + 1, c);
      const left = dark(r, c - 1);
      const right = dark(r, c + 1);
      modulesPath += roundedRect(
        c + offset, r + offset, 1, 1,
        !up && !left ? R : 0,
        !up && !right ? R : 0,
        !down && !right ? R : 0,
        !down && !left ? R : 0,
      );
    }
  }

  let findersPath = '';
  for (const [r, c] of [[0, 0], [0, size - FINDER], [size - FINDER, 0]]) {
    const x = c + offset;
    const y = r + offset;
    findersPath += roundedRect(x, y, 7, 7, 1.4, 1.4, 1.4, 1.4);
    findersPath += roundedRect(x + 1, y + 1, 5, 5, 1.25, 1.25, 1.25, 1.25);
    findersPath += roundedRect(x + 2, y + 2, 3, 3, 0.9, 0.9, 0.9, 0.9);
  }

  let framePath = '';
  if (frame) {
    // Bracket lines run through the middle of the frame band.
    const lo = FRAME_BAND / 2;
    const hi = units - FRAME_BAND / 2;
    const arm = Math.max(3, (hi - lo) * 0.16);
    const bend = 1.2;
    const corner = (cx: number, cy: number, dx: number, dy: number) =>
      `M${fmt(cx)} ${fmt(cy + dy * arm)}` +
      `V${fmt(cy + dy * bend)}` +
      `Q${fmt(cx)} ${fmt(cy)} ${fmt(cx + dx * bend)} ${fmt(cy)}` +
      `H${fmt(cx + dx * arm)}`;
    framePath = corner(lo, lo, 1, 1) + corner(hi, lo, -1, 1) + corner(lo, hi, 1, -1) + corner(hi, hi, -1, -1);
  }

  return { units, modulesPath, findersPath, framePath, frameStroke: FRAME_STROKE };
}

export interface StyledQrColors {
  fgColor?: string;
  bgColor?: string;
}

const DEFAULT_FG = '#000000';
const DEFAULT_BG = '#ffffff';

/** A standalone SVG document string, `pixels` wide and tall. */
export function styledQrSvg(
  matrix: QrMatrix,
  pixels: number,
  options: StyledQrOptions & StyledQrColors = {},
): string {
  const g = styledQrGeometry(matrix, options);
  const fg = options.fgColor || DEFAULT_FG;
  const bg = options.bgColor || DEFAULT_BG;
  const frame = g.framePath
    ? `<path d="${g.framePath}" fill="none" stroke="${fg}" stroke-width="${g.frameStroke}" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${g.units} ${g.units}" shape-rendering="geometricPrecision">` +
    `<rect width="${g.units}" height="${g.units}" fill="${bg}"/>` +
    `<path d="${g.modulesPath}" fill="${fg}"/>` +
    `<path d="${g.findersPath}" fill="${fg}" fill-rule="evenodd"/>` +
    frame +
    '</svg>'
  );
}

/** Draws the code onto a 2D canvas context, filling a `pixels`-square area at the origin. */
export function drawStyledQr(
  ctx: CanvasRenderingContext2D,
  matrix: QrMatrix,
  pixels: number,
  options: StyledQrOptions & StyledQrColors = {},
): void {
  const g = styledQrGeometry(matrix, options);
  const scale = pixels / g.units;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = options.bgColor || DEFAULT_BG;
  ctx.fillRect(0, 0, g.units, g.units);
  ctx.fillStyle = options.fgColor || DEFAULT_FG;
  ctx.fill(new Path2D(g.modulesPath));
  ctx.fill(new Path2D(g.findersPath), 'evenodd');
  if (g.framePath) {
    ctx.strokeStyle = options.fgColor || DEFAULT_FG;
    ctx.lineWidth = g.frameStroke;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(g.framePath));
  }
  ctx.restore();
}
