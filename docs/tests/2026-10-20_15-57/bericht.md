# Testbericht 20.10.2026, 15:57:07

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In AIdeation abgelegt: Projekt `dev-log`, Testlauf `e79e2e67-691d-4fc3-b2c3-e433807d2891`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ❌ | 4 s | 396 problems (2 errors, 394 warnings) |
| Formatierung | ✅ | 4 s | alles formatiert |
| Typprüfung | ✅ | 4 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 21 s | 461 bestanden, 0 fehlgeschlagen, 5 Build-Warnungen |
| E2E-Tests | ✅ | 70 s | 46 passed, 2 skipped |
| Oberflächentest | ❌ | 1 s | – |

## Befunde des Oberflächentests

Keine Befunde.

## Oberflächentest im Detail

Kein Ergebnis (Oberflächentest lief nicht).

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>Lint</summary>

```text
  408:16  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
  426:16  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
  471:20  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
  472:16  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
  473:16  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
  526:16  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
  531:20  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
  546:16  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion

/Volumes/DroneShots/Coding/AIdeation/agent/src/runner/scheduler.ts
  329:42  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion

/Volumes/DroneShots/Coding/AIdeation/agent/src/runner/visual-check.test.ts
  190:52  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion

/Volumes/DroneShots/Coding/AIdeation/agent/src/runner/visual-check.ts
   185:16  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   221:12  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   278:7   warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   372:14  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   451:22  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   451:38  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   452:22  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   452:42  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   453:22  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   453:42  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   454:22  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   454:37  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   455:22  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   455:41  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   456:22  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   456:41  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
   536:18  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion
  1051:11  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion

/Volumes/DroneShots/Coding/AIdeation/agent/src/setup/setup-jobs.ts
  68:39  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion

✖ 396 problems (2 errors, 394 warnings)
  2 errors and 0 warnings potentially fixable with the `--fix` option.
```

</details>

<details><summary>Oberflächentest</summary>

```text
Error: http://127.0.0.1:3196/health is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.
```

</details>

