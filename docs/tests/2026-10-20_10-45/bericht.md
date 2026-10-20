# Testbericht 20.10.2026, 10:45:34

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In AIdeation abgelegt: Projekt `dev-log`, Testlauf `6c8b4f38-fe20-48e1-a942-b5231f1dd9dd`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 2 s | 323 problems (0 errors, 323 warnings) |
| Formatierung | ✅ | 3 s | alles formatiert |
| Typprüfung | ✅ | 2 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 15 s | 349 bestanden, 0 fehlgeschlagen, 4 Build-Warnungen |
| E2E-Tests | ✅ | 50 s | 41 passed, 1 skipped |
| Oberflächentest | ❌ | 0 s | – |

## Befunde des Oberflächentests

Keine Befunde.

## Oberflächentest im Detail

Kein Ergebnis (Oberflächentest lief nicht).

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>Oberflächentest</summary>

```text
Error: http://127.0.0.1:3196/health is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.
```

</details>

