/**
 * Agent-Schritte, die nur unterbrochen wurden (Worker-Neustart, Nutzungslimit des Agent-Kontos), stehen technisch auf
 * „failed“, damit der nächste Lauf dort fortsetzt. Für Statistik und Qualität sind sie kein Fehlschlag des Agents.
 * Beide Wege hängen eine Zeile „Unterbrochen: …“ an die Ausgabe an.
 */
export function realFailureSql(alias: string): string {
  return `(${alias}.status = 'failed' AND ${alias}.output NOT LIKE E'%\\nUnterbrochen: %')`;
}
