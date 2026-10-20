export type Section =
  'dashboard' | 'development' | 'sprints' | 'ideation' | 'bugs' | 'docs' | 'agents' | 'runs' | 'stats' | 'settings';

export const NAVIGATION: { id: Section; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'docs', label: 'Dokumentation' },
  { id: 'ideation', label: 'Ideation' },
  { id: 'development', label: 'Auftrag' },
  { id: 'sprints', label: 'Sprints' },
  { id: 'bugs', label: 'Bugs' },
  { id: 'runs', label: 'Testläufe' },
  { id: 'agents', label: 'Agents' },
  { id: 'stats', label: 'Statistik' },
  { id: 'settings', label: 'Einstellungen' },
];

export function isSection(section: string): section is Section {
  return NAVIGATION.some((item) => item.id === section);
}

/** „#development/<id>“: Seite und optional der Eintrag, der geöffnet werden soll (z. B. aus Dokumenten verlinkt). */
export function sectionFromHash(): Section {
  const section = globalThis.location.hash.slice(1).split('/')[0] ?? '';
  return isSection(section) ? section : 'dashboard';
}

export function targetFromHash(): string | null {
  const target = globalThis.location.hash.slice(1).split('/')[1]?.split('?')[0] ?? '';
  return /^[0-9a-f-]{36}$/i.test(target) ? target : null;
}

/** Parameter hinter dem Ziel, z. B. „#development/<id>?project=demo&answer=1“ (Links aus Push-Nachrichten). */
export function hashParameter(name: string): string | null {
  const query = globalThis.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get(name);
}

/** Projekt aus dem Link, falls angegeben (nur gültige Kürzel). */
export function projectFromHash(): string | null {
  const project = hashParameter('project');
  return project && /^[a-z0-9][a-z0-9-]{0,62}$/.test(project) ? project : null;
}
