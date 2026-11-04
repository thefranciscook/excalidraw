import type { ExcalidrawTextElement, TextStyle, TextStyleRange } from "./types";

/**
 * Bold / italic / underline formatting of parts of a text element.
 *
 * All styles are rendered without changing glyph advances (bold = fill plus a
 * thin same-color outline, italic = synthesized oblique, underline = a rule),
 * so text measurement & wrapping stay single-font and unaffected.
 */

/** bold outline width, relative to the font size */
export const BOLD_STROKE_RATIO = 0.04;

export const TEXT_STYLES: readonly TextStyle[] = [
  "bold",
  "italic",
  "underline",
];

const STYLE_BITS: Record<TextStyle, number> = {
  bold: 1,
  italic: 2,
  underline: 4,
};

type StyleMask = number;

export type TextStyleFlags = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
};

const maskToFlags = (mask: StyleMask): TextStyleFlags => ({
  bold: !!(mask & STYLE_BITS.bold),
  italic: !!(mask & STYLE_BITS.italic),
  underline: !!(mask & STYLE_BITS.underline),
});

export const textStyleFlagsToMask = (
  flags: Partial<TextStyleFlags> | null | undefined,
): StyleMask =>
  (flags?.bold ? STYLE_BITS.bold : 0) |
  (flags?.italic ? STYLE_BITS.italic : 0) |
  (flags?.underline ? STYLE_BITS.underline : 0);

const rangeToMask = (range: TextStyleRange): StyleMask =>
  textStyleFlagsToMask(range);

const toMask = (
  ranges: readonly TextStyleRange[] | null | undefined,
  length: number,
): Uint8Array => {
  const mask = new Uint8Array(length);
  for (const range of ranges ?? []) {
    const bits = rangeToMask(range);
    const end = Math.min(range.end, length);
    for (let i = Math.max(0, range.start); i < end; i++) {
      mask[i] |= bits;
    }
  }
  return mask;
};

const fromMask = (mask: ArrayLike<number>): TextStyleRange[] => {
  const ranges: TextStyleRange[] = [];
  let start = 0;

  for (let i = 1; i <= mask.length; i++) {
    if (i === mask.length || mask[i] !== mask[start]) {
      const bits = mask[start];
      if (bits) {
        ranges.push({
          start,
          end: i,
          ...(bits & STYLE_BITS.bold ? { bold: true } : null),
          ...(bits & STYLE_BITS.italic ? { italic: true } : null),
          ...(bits & STYLE_BITS.underline ? { underline: true } : null),
        });
      }
      start = i;
    }
  }

  return ranges;
};

/** returns `undefined` when there's no formatting, so the field is omitted */
const toField = (ranges: TextStyleRange[]) =>
  ranges.length ? ranges : undefined;

/**
 * Sanitizes (possibly untrusted) style ranges against a text length.
 */
export const normalizeTextStyles = (
  value: unknown,
  length: number,
): TextStyleRange[] | undefined => {
  if (!Array.isArray(value) || !length) {
    return undefined;
  }

  const valid = value.filter(
    (range): range is TextStyleRange =>
      !!range &&
      typeof range === "object" &&
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.end > range.start &&
      range.end > 0 &&
      range.start < length,
  );

  return toField(fromMask(toMask(valid, length)));
};

export const hasTextStyles = (
  element: Pick<ExcalidrawTextElement, "textStyles">,
) => !!element.textStyles?.length;

/** style flags of the character at `index` */
export const getTextStyleAt = (
  ranges: readonly TextStyleRange[] | null | undefined,
  index: number,
): TextStyleFlags => {
  let mask = 0;
  for (const range of ranges ?? []) {
    if (range.start <= index && index < range.end) {
      mask |= rangeToMask(range);
    }
  }
  return maskToFlags(mask);
};

/** whether every character within [start, end) has the style */
export const isRangeStyled = (
  ranges: readonly TextStyleRange[] | null | undefined,
  start: number,
  end: number,
  style: TextStyle,
): boolean => {
  if (end <= start) {
    return false;
  }
  const mask = toMask(ranges, end);
  for (let i = start; i < end; i++) {
    if (!(mask[i] & STYLE_BITS[style])) {
      return false;
    }
  }
  return true;
};

/** sets or clears a style for [start, end) */
export const setTextStyle = (
  ranges: readonly TextStyleRange[] | null | undefined,
  start: number,
  end: number,
  style: TextStyle,
  enabled: boolean,
  length: number,
): TextStyleRange[] | undefined => {
  const mask = toMask(ranges, length);
  const bit = STYLE_BITS[style];
  for (let i = Math.max(0, start); i < Math.min(end, length); i++) {
    mask[i] = enabled ? mask[i] | bit : mask[i] & ~bit;
  }
  return toField(fromMask(mask));
};

/**
 * Removes the style from [start, end) when the whole range has it already,
 * applies it to the whole range otherwise.
 */
export const toggleTextStyle = (
  ranges: readonly TextStyleRange[] | null | undefined,
  start: number,
  end: number,
  style: TextStyle,
  length: number,
): TextStyleRange[] | undefined =>
  setTextStyle(
    ranges,
    start,
    end,
    style,
    !isRangeStyled(ranges, start, end, style),
    length,
  );

export type TextEdit = {
  start: number;
  deleteCount: number;
  insertCount: number;
};

/**
 * Finds the single changed span between two texts.
 *
 * @param caretAfter caret position after the edit, used to disambiguate
 *  repeated characters (i.e. typing "a" after "aa")
 */
export const diffTextEdit = (
  prev: string,
  next: string,
  caretAfter?: number,
): TextEdit | null => {
  if (prev === next) {
    return null;
  }

  const minLength = Math.min(prev.length, next.length);

  let prefix = 0;
  while (prefix < minLength && prev[prefix] === next[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLength &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }

  if (
    caretAfter !== undefined &&
    caretAfter >= 0 &&
    caretAfter <= next.length
  ) {
    // the edit ends at the caret: the text after it is untouched, and
    // the common suffix takes precedence over the prefix
    suffix = Math.min(suffix, next.length - caretAfter, minLength);
    prefix = Math.min(prefix, minLength - suffix);
  } else {
    // prefer an edit as late as possible (i.e. typing at the end)
    prefix = Math.min(prefix, minLength);
    suffix = Math.min(suffix, minLength - prefix);
  }

  return {
    start: prefix,
    deleteCount: prev.length - prefix - suffix,
    insertCount: next.length - prefix - suffix,
  };
};

/**
 * Remaps style ranges after a text edit. Inserted text takes the style of the
 * first replaced character, or the preceding one (i.e. typing after a bold
 * word continues bold), unless `insertStyle` is passed.
 */
export const spliceTextStyles = (
  ranges: readonly TextStyleRange[] | null | undefined,
  prevLength: number,
  edit: TextEdit,
  insertStyle?: Partial<TextStyleFlags> | null,
): TextStyleRange[] | undefined => {
  if (!ranges?.length && !insertStyle) {
    return undefined;
  }

  const { start, deleteCount, insertCount } = edit;
  const mask = toMask(ranges, prevLength);

  let insertMask: StyleMask;
  if (insertStyle) {
    insertMask = textStyleFlagsToMask(insertStyle);
  } else if (deleteCount > 0) {
    insertMask = mask[start] ?? 0;
  } else if (start > 0) {
    insertMask = mask[start - 1];
  } else {
    insertMask = mask[0] ?? 0;
  }

  const next = new Uint8Array(prevLength - deleteCount + insertCount);
  next.set(mask.subarray(0, start), 0);
  next.fill(insertMask, start, start + insertCount);
  next.set(mask.subarray(start + deleteCount), start + insertCount);

  return toField(fromMask(next));
};

/** max cells of the LCS table, above which a plain splice is used */
const MAX_ALIGNMENT_CELLS = 250_000;

/**
 * Aligns `deleted` with `inserted` (longest common subsequence), returning
 * for each inserted character the index of its matching deleted character,
 * or -1 for new characters.
 */
const alignReplacedText = (deleted: string, inserted: string): Int32Array => {
  const rows = deleted.length + 1;
  const cols = inserted.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = deleted.length - 1; i >= 0; i--) {
    for (let j = inserted.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        deleted[i] === inserted[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const matches = new Int32Array(inserted.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < deleted.length && j < inserted.length) {
    if (deleted[i] === inserted[j]) {
      matches[j++] = i++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return matches;
};

/**
 * Remaps styles from `prevText` to `nextText`, keeping the formatting of
 * characters that survived the edit, even within the changed span (i.e.
 * indenting or bulleting several lines at once).
 *
 * @param caretAfter caret position after the edit (disambiguates repeated
 *  characters)
 * @param insertStyle style for newly typed characters (i.e. after toggling
 *  bold with a collapsed caret), inherited from the neighbours otherwise
 */
export const remapTextStyles = (
  ranges: readonly TextStyleRange[] | null | undefined,
  prevText: string,
  nextText: string,
  caretAfter?: number,
  insertStyle?: Partial<TextStyleFlags> | null,
): TextStyleRange[] | undefined => {
  if (!ranges?.length && !insertStyle) {
    return undefined;
  }

  const edit = diffTextEdit(prevText, nextText, caretAfter);
  if (!edit) {
    return ranges?.length ? [...ranges] : undefined;
  }

  const { start, deleteCount, insertCount } = edit;

  if (
    !deleteCount ||
    !insertCount ||
    (deleteCount + 1) * (insertCount + 1) > MAX_ALIGNMENT_CELLS
  ) {
    return spliceTextStyles(
      ranges,
      prevText.length,
      edit,
      insertCount ? insertStyle : null,
    );
  }

  const prevMask = toMask(ranges, prevText.length);
  const matches = alignReplacedText(
    prevText.slice(start, start + deleteCount),
    nextText.slice(start, start + insertCount),
  );
  const insertMask = insertStyle ? textStyleFlagsToMask(insertStyle) : null;

  const next = new Uint8Array(nextText.length);
  next.set(prevMask.subarray(0, start), 0);
  next.set(prevMask.subarray(start + deleteCount), start + insertCount);

  for (let k = 0; k < insertCount; k++) {
    const match = matches[k];
    if (match !== -1) {
      next[start + k] = prevMask[start + match];
    } else if (insertMask !== null) {
      next[start + k] = insertMask;
    } else if (k === 0) {
      // typing over a selection takes the style of its first character
      next[start] = prevMask[start];
    } else {
      next[start + k] = next[start + k - 1];
    }
  }

  return toField(fromMask(next));
};

// -----------------------------------------------------------------------------
// layout
// -----------------------------------------------------------------------------

export type StyledRun = TextStyleFlags & {
  text: string;
};

/** runs of each line of `element.text` (the wrapped text) */
export type StyledLines = StyledRun[][];

const isTrimmableWhitespace = (char: string) => char === " " || char === "\t";

/**
 * Maps each character of the wrapped `text` to its `originalText` offset,
 * or -1 for characters inserted by wrapping (soft line breaks, list
 * hanging indents). Whitespace trimmed at soft breaks is skipped.
 */
export const mapWrappedTextToOriginal = (
  text: string,
  originalText: string,
): Int32Array => {
  const map = new Int32Array(text.length);
  let j = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === "\n") {
      // whitespace trimmed before a soft break
      while (
        j < originalText.length &&
        originalText[j] !== "\n" &&
        isTrimmableWhitespace(originalText[j])
      ) {
        j++;
      }
    }

    if (j < originalText.length && originalText[j] === char) {
      map[i] = j++;
    } else if (char === "\n" || isTrimmableWhitespace(char)) {
      // soft line break or hanging indent inserted by wrapping
      map[i] = -1;
    } else if (j < originalText.length) {
      // differs (i.e. unicode normalization), assume a substitution so that
      // the rest of the text stays aligned
      map[i] = j++;
    } else {
      map[i] = -1;
    }
  }

  return map;
};

const styledLinesCache = new WeakMap<
  ExcalidrawTextElement,
  StyledLines | null
>();

/**
 * Splits `element.text` into lines of styled runs. Returns `null` when the
 * element has no formatting (render as plain text).
 */
export const getStyledLines = (
  element: ExcalidrawTextElement,
): StyledLines | null => {
  if (!element.textStyles?.length) {
    return null;
  }

  const cached = styledLinesCache.get(element);
  if (cached !== undefined) {
    return cached;
  }

  const { text, originalText } = element;
  const mask = toMask(element.textStyles, originalText.length);
  const map = mapWrappedTextToOriginal(text, originalText);

  const lines: StyledLines = [];
  let runs: StyledRun[] = [];
  let runText = "";
  let runMask = -1;

  const flush = () => {
    if (runText) {
      runs.push({ text: runText, ...maskToFlags(runMask) });
    }
    runText = "";
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === "\n") {
      flush();
      lines.push(runs);
      runs = [];
      runMask = -1;
      continue;
    }

    const charMask = map[i] === -1 ? 0 : mask[map[i]];

    if (charMask !== runMask) {
      flush();
      runMask = charMask;
    }

    runText += char;
  }

  flush();
  lines.push(runs);

  styledLinesCache.set(element, lines);

  return lines;
};

/** splits (unwrapped) text into runs of the same style */
export const getStyledRuns = (
  text: string,
  ranges: readonly TextStyleRange[] | null | undefined,
): StyledRun[] => {
  const mask = toMask(ranges, text.length);
  const runs: StyledRun[] = [];
  let start = 0;

  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || mask[i] !== mask[start]) {
      runs.push({ text: text.slice(start, i), ...maskToFlags(mask[start]) });
      start = i;
    }
  }

  return runs;
};

/** whether a line has any formatting (otherwise render it as plain text) */
export const isStyledLine = (runs: readonly StyledRun[]) =>
  runs.some((run) => run.bold || run.italic || run.underline);

/** underline position (below the alphabetic baseline) & thickness */
export const getUnderlineMetrics = (fontSize: number) => ({
  offset: fontSize * 0.12,
  thickness: Math.max(1, fontSize / 16),
});
