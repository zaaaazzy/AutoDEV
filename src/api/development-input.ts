// Eingabeprüfung der Auftrags-Routen: je Body eine Funktion, die geprüfte Werte oder die Fehlermeldung liefert.
import { DEVELOPMENT_STATUS, DEVELOPMENT_STATUSES } from '../core/status.js';
import {
  CATEGORIES,
  INVALID,
  invalidInput,
  isRecord,
  isUuid,
  parseNullableUuid,
  parseOption,
  PRIORITIES,
  TITLE_MAX,
  validStatus,
  validText,
  type InvalidInput,
  type Parser,
} from '../core/validation.js';
import type { NewOrder } from '../db/development-repository.js';
import { IDEA_FIELDS } from './ideation.js';

const DESCRIPTION_MAX = 10_000;

export const DEV_FIELDS = {
  ...IDEA_FIELDS,
  status: { column: 'status', parse: parseOption(DEVELOPMENT_STATUSES) },
  sprintId: { column: 'sprint_id', parse: parseNullableUuid },
  agentId: { column: 'agent_id', parse: parseNullableUuid },
};

const parseUuid: Parser = (value) => (isUuid(value) ? value : INVALID);
/** Neue Aufträge nur in Backlog oder Geplant; alle weiteren Status entstehen über PATCH bzw. den Worker. */
const NEW_ORDER_STATUSES = new Set<string>([DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.planned]);
const NEW_ORDER_FIELDS = {
  ...DEV_FIELDS,
  status: { column: 'status', parse: parseOption(NEW_ORDER_STATUSES) },
  ideationId: { column: 'ideation_id', parse: parseUuid },
  testRunId: { column: 'test_run_id', parse: parseUuid },
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: InvalidInput };

const optionalDescription = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && value.length <= DESCRIPTION_MAX);
const trimmedDescription = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Erklärt, warum ein neuer Auftrag abgelehnt wurde, samt Feld für die Anzeige im Formular. */
function invalidNewOrder(body: unknown): InvalidInput {
  if (isRecord(body) && typeof body.title === 'string' && body.title.trim().length > TITLE_MAX) {
    return {
      field: 'title',
      message: `Titel bitte kurz halten (max. ${TITLE_MAX} Zeichen); Details in die Beschreibung.`,
    };
  }
  return invalidInput(body, NEW_ORDER_FIELDS, ['title']);
}

/** Body von POST /projects/:slug/development. */
export function parseNewOrder(body: unknown): Parsed<NewOrder> {
  if (
    !isRecord(body) ||
    !validText(body.title, TITLE_MAX) ||
    !optionalDescription(body.description) ||
    (body.status !== undefined && !validStatus(body.status, NEW_ORDER_STATUSES)) ||
    (body.priority !== undefined && !validStatus(body.priority, PRIORITIES)) ||
    (body.ideationId !== undefined && !isUuid(body.ideationId)) ||
    (body.testRunId !== undefined && !isUuid(body.testRunId)) ||
    (body.category !== undefined &&
      body.category !== null &&
      body.category !== '' &&
      !validStatus(body.category, CATEGORIES))
  ) {
    return { ok: false, error: invalidNewOrder(body) };
  }
  return {
    ok: true,
    value: {
      ideationId: (body.ideationId as string | undefined) ?? null,
      testRunId: (body.testRunId as string | undefined) ?? null,
      title: body.title.trim(),
      description: trimmedDescription(body.description),
      status: (body.status as string | undefined) ?? null,
      priority: (body.priority as string | undefined) ?? null,
      category: (body.category as string | null | undefined) || null,
    },
  };
}

export const INVALID_FOLLOW_UP: InvalidInput = {
  message: `Titel (max. ${TITLE_MAX} Zeichen) und Beschreibung prüfen.`,
};

export interface FollowUpInput {
  title: string;
  description: string;
  priority: string | null;
  sprintId: string | null;
}

/** Body von POST /development/:id/follow-up. */
export function parseFollowUp(body: unknown): Parsed<FollowUpInput> {
  if (
    !isRecord(body) ||
    !validText(body.title, TITLE_MAX) ||
    !optionalDescription(body.description) ||
    (body.priority !== undefined && !validStatus(body.priority, PRIORITIES)) ||
    (body.sprintId !== undefined && body.sprintId !== null && !isUuid(body.sprintId))
  ) {
    return { ok: false, error: INVALID_FOLLOW_UP };
  }
  return {
    ok: true,
    value: {
      title: body.title.trim(),
      description: trimmedDescription(body.description),
      priority: (body.priority as string | undefined) ?? null,
      sprintId: typeof body.sprintId === 'string' ? body.sprintId : null,
    },
  };
}

/** Optionaler Ziel-Sprint im Body; undefined = ungültige Angabe. */
export function parseOptionalSprintId(body: unknown): string | null | undefined {
  const chosen = isRecord(body) ? body.sprintId : undefined;
  if (chosen === undefined || chosen === null) return null;
  return isUuid(chosen) ? chosen : undefined;
}

/** Kommentar beim erneuten Versuch: geht als Hinweis an die Agents (wird an die Beschreibung angehängt). */
export function retryComment(body: unknown): string | null {
  const raw = isRecord(body) && typeof body.comment === 'string' ? body.comment.trim() : '';
  return raw ? raw.slice(0, 2000) : null;
}
