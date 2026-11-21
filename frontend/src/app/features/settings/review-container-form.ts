import type { Project } from '../../core/models.js';

/** Felder des Review-Containers im Einstellungsformular (Text, wie in den Eingabefeldern). */
export interface ReviewContainerForm {
  /** Eine Zeile je Befehl. */
  reviewCommand: string;
  /** Leer = Standard 4200. */
  reviewPort: string;
  /** Leer = Standard „/“. */
  reviewHealthPath: string;
  /** Leer = Standard-Image. */
  reviewDockerfile: string;
}

/** Formularwerte aus dem Projekt; Standardwerte bleiben leer, damit das Feld den Platzhalter zeigt. */
export function reviewContainerForm(project: Project | null | undefined): ReviewContainerForm {
  return {
    reviewCommand: (project?.reviewCommand ?? []).join('\n'),
    reviewPort: project?.reviewPort ? String(project.reviewPort) : '',
    reviewHealthPath: project?.reviewHealthPath ?? '',
    reviewDockerfile: project?.reviewDockerfile ?? '',
  };
}

/** Body für PATCH /api/projects/:slug: leere Felder setzen den Standard (null) zurück. */
export function reviewContainerPatch(form: ReviewContainerForm): {
  reviewCommand: string;
  reviewPort: number | null;
  reviewHealthPath: string;
  reviewDockerfile: string;
} {
  const port = String(form.reviewPort ?? '').trim();
  return {
    reviewCommand: form.reviewCommand.trim(),
    reviewPort: port ? Number(port) : null,
    reviewHealthPath: form.reviewHealthPath.trim(),
    reviewDockerfile: form.reviewDockerfile.trim(),
  };
}
