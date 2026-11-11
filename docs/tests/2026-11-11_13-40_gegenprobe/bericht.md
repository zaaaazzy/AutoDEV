# Testbericht: Gegenprobe

## Gegenprobe

Neue Testfälle des Bugfixes, ausgeführt auf dem Stand vor dem Auftrag (`d95610b`). Erwartet ist „scheitert wie erwartet“.

| Testfall | Datei | Ergebnis auf dem alten Stand |
| --- | --- | --- |
| Sandbox: im Projektordner der Menschen (.git als Ordner) bleibt ein node_modules-Symlink | `src/core/sandbox.test.ts` | **scheitert wie erwartet** |

**Fix belegt:** Alle neuen Testfälle scheitern ohne den Fix.
