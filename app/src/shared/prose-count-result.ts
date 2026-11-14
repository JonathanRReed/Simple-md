export interface ProseCount { words: number; characters: number }
export interface ProseCounts { document: ProseCount; selection?: ProseCount; minutes: number }

export function isProseCounts(value: unknown): value is ProseCounts {
  const count = (input: unknown): input is ProseCount => typeof input === "object" && input !== null && "words" in input && "characters" in input && Number.isSafeInteger(input.words) && Number.isSafeInteger(input.characters) && Number(input.words) >= 0 && Number(input.characters) >= 0;
  return typeof value === "object" && value !== null && "document" in value && count(value.document) && "minutes" in value && Number.isSafeInteger(value.minutes) && Number(value.minutes) >= 1 && (!("selection" in value) || value.selection === undefined || count(value.selection));
}
