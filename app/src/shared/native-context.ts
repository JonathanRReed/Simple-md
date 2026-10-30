export interface NativeContext {
  selectionPresent: boolean;
  editable: boolean;
  linkURL: string;
  imageURL: string;
  misspelledWord: string;
  suggestions: string[];
}

export type ContextResult = { kind: "spelling"; replacement: string } | { kind: "fragment"; href: string } | null;
