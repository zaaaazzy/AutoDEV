# Testbericht: Gegenprobe

## Gegenprobe

Neue Testfälle des Bugfixes, ausgeführt auf dem Stand vor dem Auftrag (`d95610b`). Erwartet ist „scheitert wie erwartet“.

| Testfall | Datei | Ergebnis auf dem alten Stand |
| --- | --- | --- |
| Sandbox: npm-Cache in /tmp, nicht im Home des Images (npx ohne EACCES) | `src/core/sandbox.test.ts` | **besteht (Fix nicht belegt)** |
| Sandbox: im Projektordner der Menschen (.git als Ordner) bleibt ein node_modules-Symlink | `src/core/sandbox.test.ts` | **scheitert wie erwartet** |
| Leerer node_modules-Ordner (Mountpunkt der Docker-Sandbox) wird im Host-Modus wieder verlinkt | `src/runner/agent-workspace.test.ts` | **besteht (Fix nicht belegt)** |

**Test belegt den Fix nicht:** Mindestens ein neuer Testfall besteht auch ohne den Fix. Bitte den Test so schreiben, dass er den Fehler auf dem alten Stand zeigt.
