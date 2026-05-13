export interface LabelMatch { index: number; length: number; }
interface TextToken { word: string; start: number; end: number; }

/**
 * Tokenize normalized text, preserving character positions.
 */
const tokenizeWithPositions = (normText: string): TextToken[] => {
  const tokens: TextToken[] = [];
  const re = /\w+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normText)) !== null) {
    tokens.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return tokens;
};

/**
 * Tokenize a label: strip punctuation, split on whitespace, lowercase.
 * "Degree Men Ultrac..." → ["degree", "men", "ultrac"]
 */
const tokenizeLabel = (normLabel: string): string[] =>
  normLabel
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);

/**
 * Score how well a label token matches a text token.
 * 1.0 = exact, 0.8 = prefix match (min 3 chars), 0.0 = no match.
 * Handles OCR-truncated tokens ending with "..." (e.g. "Mois..." matches "Moisturizing").
 */
const tokenMatchScore = (labelToken: string, textToken: string): number => {
  if (labelToken === textToken) return 1.0;
  // Strip trailing "..." from OCR-truncated tokens before prefix comparison
  const strippedText = textToken.replace(/\.{2,}$/, "");
  const strippedLabel = labelToken.replace(/\.{2,}$/, "");
  if (strippedLabel.length >= 3 && strippedText.startsWith(strippedLabel)) return 0.8;
  if (strippedText.length >= 3 && strippedLabel.startsWith(strippedText)) return 0.8;
  return 0.0;
};

/** Returns the position of the best matching window, or null. */
export const findLabelPosition = (normText: string, normLabel: string): LabelMatch | null => {
  const labelTokens = tokenizeLabel(normLabel);
  if (labelTokens.length === 0) return null;

  const textTokens = tokenizeWithPositions(normText);
  if (textTokens.length === 0) return null;

  let bestScore = -1;
  let bestTightness = -1;
  let bestMatch: LabelMatch | null = null;

  // Try window sizes from (labelTokens.length - 1) to (labelTokens.length + 3)
  const minWindow = Math.max(1, labelTokens.length - 1);
  const maxWindow = Math.min(textTokens.length, labelTokens.length + 3);

  for (let winSize = minWindow; winSize <= maxWindow; winSize++) {
    for (let i = 0; i <= textTokens.length - winSize; i++) {
      const windowTokens = textTokens.slice(i, i + winSize);

      // Greedy ordered matching: walk label tokens in order,
      // find best match among unclaimed window tokens (preserving order)
      let score = 0;
      let nextWindowIdx = 0;

      for (const lt of labelTokens) {
        let bestTokenScore = 0;
        let bestTokenIdx = -1;

        for (let j = nextWindowIdx; j < windowTokens.length; j++) {
          const s = tokenMatchScore(lt, windowTokens[j].word);
          if (s > bestTokenScore) {
            bestTokenScore = s;
            bestTokenIdx = j;
            if (s === 1.0) break; // exact match, no need to look further
          }
        }

        if (bestTokenIdx >= 0 && bestTokenScore > 0) {
          score += bestTokenScore;
          nextWindowIdx = bestTokenIdx + 1; // preserve order
        }
      }

      const normalizedScore = score / labelTokens.length;
      if (normalizedScore < 0.6) continue;

      // Tightness: what fraction of the line's word tokens does the label cover?
      // "Tax" on a line with 2 tokens ("Tax $7.17") = 1/2 = 0.5
      // "Tax" on a line with 5 tokens ("Total before tax: $84.35") = 1/5 = 0.2
      // This prevents short labels from grabbing amounts from longer phrases.
      const matchStart = textTokens[i].start;
      const matchEnd = textTokens[i + winSize - 1].end;
      const lineStart = normText.lastIndexOf("\n", matchStart) + 1;
      const lineEnd = normText.indexOf("\n", matchEnd);
      const lineEndPos = lineEnd === -1 ? normText.length : lineEnd;
      const lineTokenCount = textTokens.filter(
        t => t.start >= lineStart && t.end <= lineEndPos
      ).length;
      const tightness = lineTokenCount > 0 ? labelTokens.length / lineTokenCount : 0;

      // Prefer higher score, then tighter match on ties
      if (score > bestScore || (score === bestScore && tightness > bestTightness)) {
        bestScore = score;
        bestTightness = tightness;
        bestMatch = { index: matchStart, length: matchEnd - matchStart };
      }
    }
  }

  return bestMatch;
};
