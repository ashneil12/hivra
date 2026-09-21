/**
 * Escape HTML-significant characters for safe interpolation into email HTML.
 * Extracted from four byte-identical local copies.
 *
 * NOTE: email/lifecycle.ts has a SEPARATE escapeHtml that additionally escapes
 * single quotes (' -> &#39;); it is intentionally NOT consolidated here because
 * that would change its output. Do not point lifecycle.ts at this helper.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
