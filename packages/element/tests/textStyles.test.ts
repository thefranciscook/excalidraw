import {
  diffTextEdit,
  getStyledLines,
  getStyledRuns,
  getTextStyleAt,
  isRangeStyled,
  mapWrappedTextToOriginal,
  normalizeTextStyles,
  remapTextStyles,
  setTextStyle,
  spliceTextStyles,
  toggleTextStyle,
} from "../src/textStyles";

import type { ExcalidrawTextElement, TextStyleRange } from "../src/types";

const describeRuns = (runs: ReturnType<typeof getStyledRuns>) =>
  runs
    .map(
      (run) =>
        `${run.text}${run.bold ? "[b]" : ""}${run.italic ? "[i]" : ""}${
          run.underline ? "[u]" : ""
        }`,
    )
    .join("|");

describe("textStyles", () => {
  describe("normalizeTextStyles", () => {
    it("drops invalid ranges, clamps, sorts and merges", () => {
      expect(
        normalizeTextStyles(
          [
            { start: 4, end: 20, bold: true },
            { start: 0, end: 2, bold: true },
            { start: 2, end: 4, bold: true },
            { start: 3, end: 3, italic: true },
            { start: 5, end: 2, italic: true },
            { start: "1", end: 2, italic: true },
            null,
            { start: 8, end: 9 },
            { start: 6, end: 8, underline: true },
          ],
          10,
        ),
      ).toEqual([
        { start: 0, end: 6, bold: true },
        { start: 6, end: 8, bold: true, underline: true },
        { start: 8, end: 10, bold: true },
      ]);
    });

    it("returns undefined for no formatting", () => {
      expect(normalizeTextStyles(undefined, 10)).toBe(undefined);
      expect(normalizeTextStyles([], 10)).toBe(undefined);
      expect(normalizeTextStyles([{ start: 0, end: 4 }], 10)).toBe(undefined);
      expect(normalizeTextStyles([{ start: 0, end: 4, bold: true }], 0)).toBe(
        undefined,
      );
    });
  });

  describe("toggling", () => {
    const ranges: TextStyleRange[] = [{ start: 2, end: 6, bold: true }];

    it("applies a style to a partially styled range", () => {
      expect(toggleTextStyle(ranges, 0, 4, "bold", 10)).toEqual([
        { start: 0, end: 6, bold: true },
      ]);
    });

    it("removes a style from a fully styled range", () => {
      expect(toggleTextStyle(ranges, 3, 5, "bold", 10)).toEqual([
        { start: 2, end: 3, bold: true },
        { start: 5, end: 6, bold: true },
      ]);
      expect(toggleTextStyle(ranges, 2, 6, "bold", 10)).toBe(undefined);
    });

    it("combines styles", () => {
      expect(toggleTextStyle(ranges, 4, 8, "italic", 10)).toEqual([
        { start: 2, end: 4, bold: true },
        { start: 4, end: 6, bold: true, italic: true },
        { start: 6, end: 8, italic: true },
      ]);
    });

    it("queries styles", () => {
      expect(isRangeStyled(ranges, 2, 6, "bold")).toBe(true);
      expect(isRangeStyled(ranges, 1, 6, "bold")).toBe(false);
      expect(isRangeStyled(ranges, 3, 3, "bold")).toBe(false);
      expect(getTextStyleAt(ranges, 2)).toEqual({
        bold: true,
        italic: false,
        underline: false,
      });
      expect(getTextStyleAt(ranges, 6).bold).toBe(false);
      expect(setTextStyle(ranges, 0, 10, "underline", true, 10)).toEqual([
        { start: 0, end: 2, underline: true },
        { start: 2, end: 6, bold: true, underline: true },
        { start: 6, end: 10, underline: true },
      ]);
    });
  });

  describe("editing", () => {
    const ranges: TextStyleRange[] = [{ start: 6, end: 10, bold: true }];
    // "Hello bold world"

    it("finds the edited span, using the caret for repeated characters", () => {
      expect(diffTextEdit("aa", "aaa")).toEqual({
        start: 2,
        deleteCount: 0,
        insertCount: 1,
      });
      expect(diffTextEdit("aa", "aaa", 1)).toEqual({
        start: 0,
        deleteCount: 0,
        insertCount: 1,
      });
      expect(diffTextEdit("abc", "abc")).toBe(null);
      expect(diffTextEdit("hello world", "hello")).toEqual({
        start: 5,
        deleteCount: 6,
        insertCount: 0,
      });
    });

    it("shifts ranges after an edit before them", () => {
      expect(
        remapTextStyles(ranges, "Hello bold world", "Oh, Hello bold world"),
      ).toEqual([{ start: 10, end: 14, bold: true }]);
    });

    it("continues the style when typing at the end of a styled run", () => {
      expect(
        remapTextStyles(ranges, "Hello bold world", "Hello bolder world", 12),
      ).toEqual([{ start: 6, end: 12, bold: true }]);
    });

    it("doesn't style text typed before a styled run", () => {
      expect(
        remapTextStyles(ranges, "Hello bold world", "Hello xbold world", 7),
      ).toEqual([{ start: 7, end: 11, bold: true }]);
    });

    it("applies a pending style to typed text", () => {
      expect(
        remapTextStyles(undefined, "Hello world", "Hello big world", 10, {
          italic: true,
        }),
      ).toEqual([{ start: 6, end: 10, italic: true }]);
    });

    it("trims ranges on delete", () => {
      expect(
        remapTextStyles(ranges, "Hello bold world", "Hello bd world", 7),
      ).toEqual([{ start: 6, end: 8, bold: true }]);
      expect(
        remapTextStyles(ranges, "Hello bold world", "Hello  world", 6),
      ).toBe(undefined);
    });

    it("typing over a selection takes the style of its first character", () => {
      expect(
        spliceTextStyles(ranges, 16, {
          start: 6,
          deleteCount: 4,
          insertCount: 2,
        }),
      ).toEqual([{ start: 6, end: 8, bold: true }]);
    });

    it("keeps the formatting within multi-line edits (indent)", () => {
      const prev = "one\ntwo\nthree";
      const next = "    one\n    two\n    three";
      // "two" bold
      expect(
        remapTextStyles([{ start: 4, end: 7, bold: true }], prev, next, 25),
      ).toEqual([{ start: 12, end: 15, bold: true }]);
    });
  });

  describe("layout", () => {
    it("splits text into styled runs", () => {
      expect(
        describeRuns(
          getStyledRuns("Hello bold world", [
            { start: 6, end: 10, bold: true },
          ]),
        ),
      ).toBe("Hello |bold[b]| world");
    });

    it("maps wrapped text to the original text", () => {
      // soft break replaces a (trimmed) space, and a hanging indent is added
      expect(
        Array.from(
          mapWrappedTextToOriginal("- one two\n  three", "- one two three"),
        ),
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, -1, -1, -1, 10, 11, 12, 13, 14]);
      // soft break within a word (nothing trimmed)
      expect(
        Array.from(mapWrappedTextToOriginal("abc\ndef", "abcdef")),
      ).toEqual([0, 1, 2, -1, 3, 4, 5]);
    });

    it("gets styled lines of wrapped text", () => {
      const element = {
        text: "The quick brown fox\njumps over",
        originalText: "The quick brown fox jumps over",
        textStyles: [{ start: 16, end: 25, bold: true, underline: true }],
      } as unknown as ExcalidrawTextElement;

      expect(getStyledLines(element)?.map(describeRuns)).toEqual([
        "The quick brown |fox[b][u]",
        "jumps[b][u]| over",
      ]);
      // cached per element
      expect(getStyledLines(element)).toBe(getStyledLines(element));
      expect(getStyledLines({ ...element, textStyles: undefined })).toBe(null);
    });
  });
});
