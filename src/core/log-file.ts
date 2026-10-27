import { closeSync, fstatSync, openSync, statSync, writeSync } from 'node:fs';

type Writable = { write: NodeJS.WriteStream['write'] };

export interface LogFile {
  /** Datei neu öffnen, falls sie umbenannt oder gelöscht wurde (läuft sonst im Takt von `checkMs`). */
  check(): void;
  /** Ursprüngliche write-Funktionen zurück und Datei schliessen. */
  stop(): void;
}

/**
 * Schreibt die Ausgabe der Streams (Standard: stdout und stderr) selbst ans Ende von `path` und öffnet die Datei neu,
 * sobald newsyslog sie rotiert hat (umbenannt, neue leere Datei angelegt). Der Datei-Deskriptor von launchd
 * (StandardOutPath) zeigte sonst bis zum nächsten Neustart auf die umbenannte Datei: Das aktuelle Worker-Log stünde in
 * `…log.0`, unter dem bekannten Pfad nur eine leere Datei. Zwischen Rotation und Prüfung Geschriebenes landet in `.0`.
 */
export function followLogFile(
  path: string,
  streams: Writable[] = [process.stdout, process.stderr],
  checkMs = 10_000,
): LogFile {
  let fd = openSync(path, 'a', 0o600);
  const check = (): void => {
    let inode: number | null = null;
    try {
      inode = statSync(path).ino;
    } catch {
      // Datei weg (rotiert ohne Neuanlage): unten neu anlegen.
    }
    if (inode === fstatSync(fd).ino) return;
    const next = openSync(path, 'a', 0o600);
    closeSync(fd);
    fd = next;
  };
  const write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const done = typeof encoding === 'function' ? encoding : callback;
    const charset = typeof encoding === 'string' ? encoding : 'utf8';
    try {
      writeSync(fd, typeof chunk === 'string' ? Buffer.from(chunk, charset) : chunk);
    } catch {
      // Log nicht schreibbar (Platte voll): Zeile verwerfen, der Worker läuft weiter.
    }
    done?.();
    return true;
  }) as NodeJS.WriteStream['write'];
  const originals = streams.map((stream) => stream.write);
  for (const stream of streams) stream.write = write;
  const timer = setInterval(() => {
    try {
      check();
    } catch {
      // Ordner nicht erreichbar: beim nächsten Takt erneut.
    }
  }, checkMs);
  timer.unref();
  return {
    check,
    stop: () => {
      clearInterval(timer);
      streams.forEach((stream, index) => (stream.write = originals[index]));
      closeSync(fd);
    },
  };
}
