/** Größte erlaubte Bilddatei für Anhänge (Ideen, Bugs). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Wirft, wenn eine Datei zu groß ist – vor dem Anlegen prüfen, damit kein Eintrag ohne Bild entsteht. */
export function assertImageSizes(files: readonly Pick<File, 'name' | 'size'>[]): void {
  const tooLarge = files.find((file) => file.size > MAX_IMAGE_BYTES);
  if (tooLarge) throw new Error(`${tooLarge.name} ist größer als 5 MB.`);
}
