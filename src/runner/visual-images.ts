// Visuelle Prüfung: Pixel-Vergleich zweier Aufnahmen und Verkleinern zu grosser Bilder.
import pngjs from 'pngjs';

const { PNG } = pngjs;

export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Pixel-Vergleich

/** Signatur von pixelmatch: Zahl der geänderten Pixel, das Diff-Bild wird in `output` gemalt. */
export type Matcher = (
  before: Uint8Array,
  after: Uint8Array,
  output: Uint8Array | null,
  width: number,
  height: number,
  options: { threshold: number },
) => number;

/** Ersatz, solange pixelmatch nicht installiert ist: Farbabstand im YIQ-Raum wie bei pixelmatch (ohne Kantenglättung). */
export const basicMatcher: Matcher = (before, after, output, width, height, options) => {
  const maxDelta = 35215 * options.threshold * options.threshold;
  let changed = 0;
  // Gegen Weiss gemischt, damit Transparenz wie bei pixelmatch zählt.
  const blend = (channel: number, alpha: number): number => 255 + ((channel - 255) * alpha) / 255;
  for (let index = 0; index < width * height * 4; index += 4) {
    const r1 = blend(before[index] ?? 0, before[index + 3] ?? 0);
    const g1 = blend(before[index + 1] ?? 0, before[index + 3] ?? 0);
    const b1 = blend(before[index + 2] ?? 0, before[index + 3] ?? 0);
    const r2 = blend(after[index] ?? 0, after[index + 3] ?? 0);
    const g2 = blend(after[index + 1] ?? 0, after[index + 3] ?? 0);
    const b2 = blend(after[index + 2] ?? 0, after[index + 3] ?? 0);
    const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
    const i = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
    const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
    const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
    const different = delta > maxDelta;
    if (different) changed += 1;
    if (output) {
      // Geändert rot, sonst das Nachher blass in Grau.
      const gray = 255 + (r2 * 0.299 + g2 * 0.587 + b2 * 0.114 - 255) * 0.1;
      output[index] = different ? 255 : gray;
      output[index + 1] = different ? 0 : gray;
      output[index + 2] = different ? 0 : gray;
      output[index + 3] = 255;
    }
  }
  return changed;
};

/** pixelmatch, wenn installiert (optionale Laufzeit-Abhängigkeit), sonst der eingebaute Vergleich. */
export async function loadMatcher(): Promise<Matcher> {
  const name = 'pixelmatch';
  try {
    const module = (await import(name)) as { default?: unknown };
    return typeof module.default === 'function' ? (module.default as Matcher) : basicMatcher;
  } catch {
    return basicMatcher;
  }
}

function padded(image: InstanceType<typeof PNG>, width: number, height: number): InstanceType<typeof PNG> {
  if (image.width === width && image.height === height) return image;
  const canvas = new PNG({ width, height });
  for (let row = 0; row < image.height; row += 1) {
    image.data.copy(canvas.data, row * width * 4, row * image.width * 4, (row + 1) * image.width * 4);
  }
  return canvas;
}

/** Vergleicht zwei PNGs (verschiedene Grössen werden aufgefüllt) und liefert den geänderten Anteil und das Diff-Bild. */
export function compareImages(
  before: Buffer,
  after: Buffer,
  threshold: number,
  matcher: Matcher = basicMatcher,
): { percent: number; diff: Buffer } {
  const left = PNG.sync.read(before);
  const right = PNG.sync.read(after);
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  const output = new PNG({ width, height });
  const changed = matcher(
    padded(left, width, height).data,
    padded(right, width, height).data,
    output.data,
    width,
    height,
    { threshold },
  );
  const percent = width && height ? Math.round((changed / (width * height)) * 10_000) / 100 : 0;
  return { percent, diff: PNG.sync.write(output) };
}

function halve(image: InstanceType<typeof PNG>): InstanceType<typeof PNG> {
  const width = Math.max(1, Math.floor(image.width / 2));
  const height = Math.max(1, Math.floor(image.height / 2));
  const small = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0;
        let count = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const sx = Math.min(image.width - 1, x * 2 + dx);
          const sy = Math.min(image.height - 1, y * 2 + dy);
          sum += image.data[(sy * image.width + sx) * 4 + channel] ?? 0;
          count += 1;
        }
        small.data[(y * width + x) * 4 + channel] = Math.round(sum / count);
      }
    }
  }
  return small;
}

/** Bild über der Grenze: schrittweise auf halbe Grösse verkleinern; null, wenn es auch so nicht passt. */
export function fitSnapshot(png: Buffer, maxBytes = MAX_SNAPSHOT_BYTES): { data: Buffer; resized: boolean } | null {
  if (png.length <= maxBytes) return { data: png, resized: false };
  let image: InstanceType<typeof PNG>;
  try {
    image = PNG.sync.read(png);
  } catch {
    return null;
  }
  for (let step = 0; step < 4 && (image.width > 1 || image.height > 1); step += 1) {
    image = halve(image);
    const encoded = PNG.sync.write(image);
    if (encoded.length <= maxBytes) return { data: encoded, resized: true };
  }
  return null;
}
