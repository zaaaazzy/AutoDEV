/* global localStorage, document */
// Setzt das gespeicherte Farbschema, bevor die Oberfläche rendert, damit die Seite nicht kurz hell aufblitzt.
// Eigene Datei statt Inline-Skript, weil die Content-Security-Policy nur script-src 'self' erlaubt.
// Schlüssel und Werte passen zu frontend/src/app/core/theme.ts; ohne Eintrag entscheidet prefers-color-scheme.
try {
  const theme = localStorage.getItem('devlog.theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
} catch {
  // Kein Speicher (privater Modus): Systemeinstellung gilt.
}
