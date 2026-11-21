// Einstellungen des Review-Containers je Projekt (projects.review_*) und die Ableitungen daraus, die Worker und API
// gemeinsam brauchen: Port und Adresse je Container, Befehlszeilen, Health-Pfad und das projekteigene Dockerfile.

/** Erster Host-Port; Container n lauscht auf 127.0.0.1:(4200 + n). */
export const REVIEW_PORT_BASE = 4200;
/** Port im Container, wenn das Projekt keinen eigenen eingestellt hat (review_port NULL). */
export const REVIEW_DEFAULT_PORT = 4200;
/** Pfad der Bereitschaftsprüfung, wenn das Projekt keinen eigenen eingestellt hat (review_health_path NULL). */
export const REVIEW_DEFAULT_HEALTH_PATH = '/';
/** Höchstzahl der Review-Befehle (Zeilen) und Länge je Zeile. */
export const REVIEW_COMMAND_MAX_LINES = 20;
export const REVIEW_COMMAND_MAX_LENGTH = 500;

export const reviewPort = (slot: number): number => REVIEW_PORT_BASE + slot;
export const reviewUrl = (slot: number): string => `http://localhost:${reviewPort(slot)}`;

/** Adresse der Bereitschaftsprüfung: Container-Adresse plus Health-Pfad des Projekts (NULL = „/“). */
export function reviewHealthUrl(slot: number, healthPath: string | null | undefined): string {
  return `${reviewUrl(slot)}${healthPath?.trim() || REVIEW_DEFAULT_HEALTH_PATH}`;
}

/**
 * Review-Befehle aus der Spalte review_command (JSONB): ein Array von Zeilen. Vor Migration 31 war es das Wort-Array
 * eines einzigen Befehls; die Migration wandelt es um, Unbekanntes zählt als „kein Befehl“.
 */
export function reviewCommandLines(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return [];
  return (value as string[]).map((line) => line.trim()).filter(Boolean);
}

/**
 * Skript für `sh -e`: eine Zeile je Befehl, die Zeilen laufen nacheinander und die erste gescheiterte beendet den
 * Container. Der Stand liegt unter /work; ältere Befehle verweisen noch auf /source.
 */
export function reviewScript(lines: readonly string[]): string {
  return lines.map((line) => line.replaceAll('/source/', '/work/')).join('\n');
}

/** Port der App im Container aus der Eingabe: null = Standard, undefined = ungültig. */
export function parseReviewPort(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const port = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/** Fehlertext für den Health-Pfad oder null; leer ist erlaubt (Standard „/“). */
export function reviewHealthPathError(path: string): string | null {
  if (!path) return null;
  if (!path.startsWith('/') || path.length > 200 || /\s/.test(path)) {
    return 'Health-Pfad: beginnt mit „/“, ohne Leerzeichen, höchstens 200 Zeichen (z. B. /health).';
  }
  return null;
}

const DOCKERFILE_PATH = /^[\w.][\w./-]*$/;

/**
 * Fehlertext für den Pfad des projekteigenen Dockerfiles oder null; leer = Standard-Image. Erlaubt ist nur ein
 * relativer Pfad innerhalb des Projekts: kein führendes „/“, kein „..“, keine Leer- oder Sonderzeichen.
 */
export function reviewDockerfileError(path: string): string | null {
  if (!path) return null;
  const segments = path.split('/');
  if (
    path.length > 200 ||
    !DOCKERFILE_PATH.test(path) ||
    path.endsWith('/') ||
    segments.some((segment) => segment === '..' || segment === '')
  ) {
    return 'Review-Dockerfile: Pfad relativ zum Projekt ohne „..“, z. B. deploy/review/Dockerfile.';
  }
  return null;
}

/** Name des projekteigenen Review-Images; der Slug wird auf Zeichen reduziert, die Docker erlaubt. */
export const reviewProjectImage = (projectSlug: string): string =>
  `aideation-review-${projectSlug.toLowerCase().replace(/[^a-z0-9_.-]/g, '_')}`;
