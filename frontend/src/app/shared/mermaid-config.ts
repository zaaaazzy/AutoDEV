/**
 * Aussehen der Diagramme passend zur Oberfläche: Inter, Grüntöne der App, weiche Kanten. Einzelne Knoten lassen sich
 * im Markdown mit Rollen einfärben (classDef ok/bad/wait/person, siehe docs/laufzeit.md).
 *
 * Mermaid braucht feste Farbwerte (es rechnet daraus Abstufungen), darum stehen die Farben hier als Token-Namen aus
 * frontend/src/styles/01-base.css und werden beim Zeichnen aus den CSS-Variablen gelesen – so folgt ein Diagramm dem
 * hellen wie dem dunklen Thema. Ohne Browser (scripts/check-diagrams.ts) gelten die hellen Werte aus LIGHT_TOKENS;
 * frontend/src/app/shared/mermaid-config.spec.ts prüft, dass sie zu 01-base.css passen.
 */
export const MERMAID_THEME_TOKENS = {
  background: 'surface',
  primaryColor: 'green-soft',
  primaryBorderColor: 'green-light',
  primaryTextColor: 'ink',
  secondaryColor: 'warn-soft',
  secondaryBorderColor: 'accent-orange',
  secondaryTextColor: 'ink',
  tertiaryColor: 'surface-muted',
  tertiaryBorderColor: 'line-strong',
  tertiaryTextColor: 'ink',
  lineColor: 'muted',
  textColor: 'ink',
  mainBkg: 'green-soft',
  nodeBorder: 'green-light',
  clusterBkg: 'surface-muted',
  clusterBorder: 'line-strong',
  titleColor: 'ink',
  edgeLabelBackground: 'surface',
  noteBkgColor: 'warn-soft',
  noteBorderColor: 'accent-orange',
  noteTextColor: 'ink',
  actorBkg: 'green-soft',
  actorBorder: 'green-light',
  actorTextColor: 'ink',
  actorLineColor: 'line-strong',
  signalColor: 'text-body',
  signalTextColor: 'ink',
  labelBoxBkgColor: 'surface-muted',
  labelBoxBorderColor: 'line-strong',
  activationBkgColor: 'warn-soft',
  activationBorderColor: 'accent-orange',
  altSectionBkgColor: 'surface-muted',
  labelBackgroundColor: 'surface',
  compositeBackground: 'surface-muted',
  compositeTitleBackground: 'green-soft',
  stateBorder: 'green-light',
  specialStateColor: 'green-light',
  innerEndBackground: 'green-light',
} as const;

/** Helle Werte der genutzten Tokens (Spiegel von 01-base.css für Läufe ohne Browser). */
export const LIGHT_TOKENS: Record<(typeof MERMAID_THEME_TOKENS)[keyof typeof MERMAID_THEME_TOKENS], string> = {
  surface: '#fff',
  'green-soft': '#e8f1ec',
  'green-light': '#2f6f4f',
  ink: '#202824',
  'warn-soft': '#fdf1e0',
  'accent-orange': '#e08a1e',
  'surface-muted': '#f7f8f5',
  'line-strong': '#c9d1c6',
  muted: '#6d766f',
  'text-body': '#4a554d',
};

/** Liest ein Token; undefined bedeutet „heller Standardwert“. */
export type TokenReader = (token: string) => string | undefined;

export function mermaidThemeVariables(read: TokenReader, dark = false): Record<string, string | boolean> {
  const variables: Record<string, string | boolean> = {
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif",
    fontSize: '14px',
    darkMode: dark,
  };
  for (const [name, token] of Object.entries(MERMAID_THEME_TOKENS))
    variables[name] = read(token)?.trim() || LIGHT_TOKENS[token];
  return variables;
}

export function mermaidConfig(read: TokenReader, dark = false) {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif",
    themeVariables: mermaidThemeVariables(read, dark),
    flowchart: {
      curve: 'basis',
      padding: 14,
      nodeSpacing: 36,
      rankSpacing: 48,
      htmlLabels: true,
      useMaxWidth: true,
    },
    state: {
      useMaxWidth: true,
    },
    sequence: {
      useMaxWidth: true,
      mirrorActors: false,
      actorMargin: 40,
      messageFontSize: 13,
    },
  } as const;
}

/** Helle Standardkonfiguration (Skripte ohne Browser). */
export const MERMAID_CONFIG = mermaidConfig(() => undefined);
