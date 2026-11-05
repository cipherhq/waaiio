/**
 * Serialise structured data (JSON-LD) for a `<script type="application/ld+json">` tag.
 *
 * JSON.stringify leaves `<`, `>` and `&` as-is, so a value containing `</script>`
 * would end the tag early. Escaping them (and the two JavaScript line separators)
 * as \uXXXX keeps the output valid JSON with the same parsed value.
 */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
