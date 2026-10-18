/** Zeilenweiser Vergleich (LCS) für die Anzeige eingereichter Dokumentänderungen. */
export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Sehr lange Dokumente: Vergleich auf 4000 Zeilen begrenzen, damit der Browser flüssig bleibt.
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  }
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) lines.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) lines.push({ kind: 'added', text: b[j++]! });
  return lines;
}

/** Nur geänderte Zeilen mit je 2 Zeilen Umfeld; längere unveränderte Strecken werden zusammengefasst. */
export function compactDiff(lines: DiffLine[], context = 2): (DiffLine | { kind: 'gap'; count: number })[] {
  const keep = lines.map((line, index) =>
    lines.slice(Math.max(0, index - context), index + context + 1).some((other) => other.kind !== 'same'),
  );
  const result: (DiffLine | { kind: 'gap'; count: number })[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) result.push({ kind: 'gap', count: skipped });
      skipped = 0;
      result.push(line);
    } else skipped += 1;
  });
  if (skipped) result.push({ kind: 'gap', count: skipped });
  return result;
}
