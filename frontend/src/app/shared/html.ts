const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text für HTML (Inhalt und Attributwerte in Anführungszeichen) – die eine Escape-Funktion der Oberfläche. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

/**
 * Wendet `replace` nur auf den Text zwischen Tags an, nie auf Tags selbst (Attribute) und nie innerhalb von <a>.
 * Für Nachbearbeitung von bereits erzeugtem, escaptem HTML (z. B. Erwähnungen hervorheben).
 */
export function replaceInText(html: string, replace: (text: string) => string): string {
  let insideLink = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<a\b/i.test(part)) insideLink += 1;
        else if (/^<\/a>/i.test(part)) insideLink = Math.max(0, insideLink - 1);
        return part;
      }
      return insideLink ? part : replace(part);
    })
    .join('');
}
