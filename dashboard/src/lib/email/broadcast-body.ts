// Turns a newsletter / product-update body written in a small Markdown subset
// into email HTML and plain text. Used by scripts/create-announcement-broadcast.ts.
//
// Supported, one block per blank-line-separated chunk:
//   # Heading / ## Heading      -> a heading
//   - item (every line)         -> a bullet list
//   anything else               -> a paragraph (single newlines become <br>)
// Inline, anywhere: [text](https://link) and **bold**.
// No imports with the "@/" alias: the script loads this with plain ts-node.

const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
const BOLD_PATTERN = /\*\*([^*\n]+)\*\*/g;

const FONT = "Arial,Helvetica,sans-serif";
const INK = "#111111";
const MUTED = "#666666";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInline(value: string) {
  // Escape first, then add the tags we allow. Link URLs only ever come from the
  // escaped text, and the pattern refuses quotes and spaces, so no attribute
  // can be broken out of.
  return escapeHtml(value)
    .replace(
      LINK_PATTERN,
      (_m, text: string, href: string) =>
        `<a href="${href}" style="color:${INK};text-decoration:underline;">${text}</a>`,
    )
    .replace(BOLD_PATTERN, (_m, text: string) => `<strong>${text}</strong>`);
}

function blocksOf(body: string) {
  return body
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function isList(block: string) {
  return block.split("\n").every((line) => /^\s*[-*]\s+/.test(line));
}

function listItems(block: string) {
  return block.split("\n").map((line) => line.replace(/^\s*[-*]\s+/, ""));
}

export function renderBroadcastHtmlBlocks(body: string) {
  return blocksOf(body)
    .map((block) => {
      const heading = /^(#{1,2})\s+(.+)$/.exec(block);
      if (heading && !block.includes("\n")) {
        const size = heading[1].length === 1 ? 22 : 18;
        return `<h${heading[1].length + 1} style="margin:28px 0 8px;font-size:${size}px;line-height:1.3;">${renderInline(heading[2])}</h${heading[1].length + 1}>`;
      }
      if (isList(block)) {
        const items = listItems(block)
          .map((item) => `<li style="margin:0 0 6px;">${renderInline(item)}</li>`)
          .join("");
        return `<ul style="margin:0 0 16px;padding-left:22px;">${items}</ul>`;
      }
      return `<p style="margin:0 0 16px;">${renderInline(block).replaceAll("\n", "<br>")}</p>`;
    })
    .join("\n");
}

export const BROADCAST_FOOTER_TEXT =
  "You're getting this because you signed up for Hivra or its newsletter.";

export function renderBroadcastHtml(body: string) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;color:${INK};font-family:${FONT};font-size:16px;line-height:1.55;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      ${renderBroadcastHtmlBlocks(body)}
      <p style="margin-top:32px;color:${MUTED};font-size:13px;line-height:1.5;">
        ${escapeHtml(BROADCAST_FOOTER_TEXT)}
        <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:${INK};text-decoration:underline;">Unsubscribe from product updates</a>.
      </p>
    </div>
  </body>
</html>`;
}

export function renderBroadcastText(body: string) {
  const text = body
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(LINK_PATTERN, (_m, label: string, href: string) => `${label} (${href})`)
    .replace(BOLD_PATTERN, (_m, label: string) => label)
    .replace(/^#{1,2}\s+/gm, "");

  return `${text}

--
${BROADCAST_FOOTER_TEXT}
Unsubscribe from product updates: {{{RESEND_UNSUBSCRIBE_URL}}}`;
}
