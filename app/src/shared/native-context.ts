export interface NativeContext {
  selectionPresent: boolean;
  editable: boolean;
  linkURL: string;
  imageURL: string;
  misspelledWord: string;
  suggestions: string[];
}
