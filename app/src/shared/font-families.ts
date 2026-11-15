/** Hide families intended for pictograms rather than document text. */
export function isTextFont(family: string): boolean {
  return !!family.trim() && !family.startsWith(".") && !/(emoji|symbols?|dingbats?|wingdings?|webdings?|braille|last\s*resort|(?:^|[ -])icons?(?:$|[ -])|ornaments?|pictographs?|music|engraver|(?:^|[ -])math(?:$|[ -])|(?:^|[ -])extras?(?:$|[ -])|segoe mdl2 assets)/i.test(family);
}
