export const PRIORITIES = new Set(['low', 'medium', 'high']);
export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const INVALID = Symbol('invalid');
export type Parser = (value: unknown) => unknown;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

export function validStatus(value: unknown, options: Set<string>): value is string {
  return typeof value === 'string' && options.has(value);
}

export function parseProjectSlug(value: string): string | null {
  return PROJECT_SLUG.test(value) ? value : null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export const parseTitle = (max: number): Parser => (value) => validText(value, max) ? value.trim() : INVALID;
export const parseLongText: Parser = (value) =>
  typeof value === 'string' && value.length <= 10_000 ? value.trim() : INVALID;
export const parseOption = (options: Set<string>): Parser => (value) =>
  validStatus(value, options) ? value : INVALID;
export const parseNullableUuid: Parser = (value) => value === null || isUuid(value) ? value : INVALID;
export const parseNullableDate: Parser = (value) => {
  if (value === null || value === '') {
    return null;
  }
  return typeof value === 'string' && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) ? value : INVALID;
};
export const parseCommand: Parser = (value) => {
  if (value === null) {
    return null;
  }
  return Array.isArray(value) && value.length >= 1 && value.length <= 40
    && value.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 500)
    ? value : INVALID;
};
export const parseBoolean: Parser = (value) => typeof value === 'boolean' ? value : INVALID;
const nullableNumber = (min: number, max: number, integer: boolean): Parser => (value) => {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isInteger(value)) ? value : INVALID;
};

export const ESTIMATE_FIELDS: Record<string, { column: string; parse: Parser }> = {
  effortHours: { column: 'effort_hours', parse: nullableNumber(0, 100_000, false) },
  tokenEstimate: { column: 'token_estimate', parse: nullableNumber(0, 1_000_000_000, true) },
  benefit: { column: 'benefit', parse: nullableNumber(0, 10, true) },
  cost: { column: 'cost', parse: nullableNumber(0, 10, true) },
};

export type FieldSpec = Record<string, { column: string; parse: Parser }>;

/** Parses the provided body keys against a whitelist; returns null if empty or invalid. */
export function parseFields(body: unknown, spec: FieldSpec): { column: string; value: unknown }[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const fields: { column: string; value: unknown }[] = [];
  for (const [key, entry] of Object.entries(spec)) {
    if (body[key] === undefined) {
      continue;
    }
    const value = entry.parse(body[key]);
    if (value === INVALID) {
      return null;
    }
    fields.push({ column: entry.column, value });
  }
  return fields.length ? fields : null;
}

/** Builds a parameterised UPDATE. Table and columns come from code constants, never from input. */
export function buildUpdate(
  table: string,
  id: string,
  fields: { column: string; value: unknown }[],
  returning: string,
): { sql: string; values: unknown[] } {
  const assignments = fields.map((field, index) => `${field.column} = $${index + 2}`);
  return {
    sql: `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING ${returning}`,
    values: [id, ...fields.map((field) => field.value)],
  };
}
