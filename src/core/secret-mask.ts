/**
 * Muster für Zugangsdaten. Der Git-Sync hält Dateien mit solchen Inhalten aus Commits heraus, der Betriebs-Rückkanal
 * maskiert sie in Fehlerbeispielen, bevor sie gespeichert werden. Beide nutzen dieselbe Liste.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

export const MASK = '[MASKIERT]';

/** Zusätzlich zu den Secret-Mustern: Werte, die in Logs typischerweise Personen- oder Zugangsdaten sind. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_LIKE_BEARER = /\b(Bearer|Basic|Token)\s+(?=[A-Za-z._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s/@]+@/gi;
const KEY_VALUE =
  /(["']?\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|session|cookie|credential)[\w.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}]+)/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
// Volle Form (8 Gruppen) oder verkürzt mit „::“; Uhrzeiten wie 10:30:45 passen bewusst nicht.
const IPV6 =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){0,6}:(?::?[0-9a-f]{1,4}){1,7}|(?:[0-9a-f]{1,4}:){1,7}:)(?![\w:])/gi;

function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

/**
 * Nur eindeutige Zugangsdaten: Token-Formate, PEM-Schlüssel, JWT, Bearer-/Basic-Werte und Passwörter in URLs. Ohne
 * E-Mail, IP und „schlüssel=wert“: Agent- und Testausgaben (Pfade wie session.ts:12, „input_tokens“: 42) bleiben lesbar.
 * Bearer zählt hier nur mit einem Wert, der nach Token aussieht (Ziffer, mindestens 16 Zeichen) – „Bearer authentication“
 * bleibt stehen.
 */
export function maskTokens(text: string, mask: string = MASK): string {
  let masked = text.replace(PRIVATE_KEY_BLOCK, mask);
  for (const pattern of SECRET_PATTERNS) masked = masked.replace(globalPattern(pattern), mask);
  return masked
    .replace(JWT, mask)
    .replace(TOKEN_LIKE_BEARER, (_match, scheme: string) => `${scheme} ${mask}`)
    .replace(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}${mask}@`);
}

/** Ersetzt Tokens, Passwörter, E-Mail-Adressen und IP-Adressen durch einen Platzhalter. */
export function maskSecrets(text: string): string {
  return maskTokens(text)
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${MASK}`)
    .replace(KEY_VALUE, (match, key: string, value: string) => (value.includes(MASK) ? match : `${key}${MASK}`))
    .replace(EMAIL, MASK)
    .replace(IPV4, MASK)
    .replace(IPV6, MASK);
}
