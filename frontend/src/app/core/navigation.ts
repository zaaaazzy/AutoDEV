export type Section =
  'dashboard' | 'development' | 'sprints' | 'ideation' | 'bugs' | 'docs' | 'agents' | 'runs' | 'settings';

export const NAVIGATION: { id: Section; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'docs', label: 'Dokumentation' },
  { id: 'ideation', label: 'Ideation' },
  { id: 'development', label: 'Auftrag' },
  { id: 'sprints', label: 'Sprints' },
  { id: 'bugs', label: 'Bugs' },
  { id: 'runs', label: 'Testläufe' },
  { id: 'agents', label: 'Agents' },
  { id: 'settings', label: 'Einstellungen' },
];

export function isSection(section: string): section is Section {
  return NAVIGATION.some((item) => item.id === section);
}

export function sectionFromHash(): Section {
  const section = globalThis.location.hash.slice(1);
  return isSection(section) ? section : 'dashboard';
}
