/**
 * Minimal Code 128 (code set B) encoder for printed ticket barcodes.
 *
 * Ticket codes are printable ASCII (`TK-` + upper-case hex), which code set B
 * covers in full. The output is the list of module widths, alternating
 * bar, space, bar, … and starting with a bar, ready to draw.
 *
 * The pattern table is the standard ISO/IEC 15417 table. Tests decode the
 * output with the same zxing build the dashboard scanner (html5-qrcode) uses.
 */

// Module widths (bar, space, bar, space, bar, space) for symbol values 0–105; 106 is STOP.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
] as const;

const START_B = 104;
const STOP = 106;

/** Encode `text` as Code 128 set B. Throws if a character is outside printable ASCII. */
export function encodeCode128B(text: string): number[] {
  if (!text) throw new Error('code128_empty_input');
  const values: number[] = [START_B];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) throw new Error('code128_unsupported_character');
    values.push(code - 32);
  }
  let checksum = START_B;
  for (let i = 1; i < values.length; i++) checksum += values[i] * i;
  values.push(checksum % 103, STOP);
  return values.flatMap(v => PATTERNS[v].split('').map(Number));
}
