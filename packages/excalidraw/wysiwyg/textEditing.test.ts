import {
  getAutoBulletEdit,
  getBackspaceEdit,
  getDeleteEdit,
  getEnterEdit,
  getToggleBulletsEdit,
} from "./textEditing";

import type { TextEdit } from "./textEditing";

/**
 * Applies the edit for the text with the caret (`|`) or the selection
 * (`[…]`), and returns the result the same way.
 */
const edit = (
  marked: string,
  getEdit: (value: string, start: number, end: number) => TextEdit | null,
) => {
  const value = marked.replace(/[|[\]]/g, "");
  const start = marked.search(/[|[]/);
  const end = marked.includes("[") ? marked.indexOf("]") - 1 : start;
  const textEdit = getEdit(value, start, end);
  if (!textEdit) {
    return null;
  }
  const next =
    value.slice(0, textEdit.start) + textEdit.text + value.slice(textEdit.end);
  const selection = textEdit.selection ?? {
    start: textEdit.start + textEdit.text.length,
    end: textEdit.start + textEdit.text.length,
  };
  return selection.start === selection.end
    ? `${next.slice(0, selection.start)}|${next.slice(selection.start)}`
    : `${next.slice(0, selection.start)}[${next.slice(
        selection.start,
        selection.end,
      )}]${next.slice(selection.end)}`;
};

describe("text editing", () => {
  describe("Enter", () => {
    it("should start a new paragraph, with a blank line between", () => {
      expect(edit("foo|", getEnterEdit)).toBe("foo\n\n|");
      expect(edit("fo|o", getEnterEdit)).toBe("fo\n\n|o");
      expect(edit("foo|\n\nbar", getEnterEdit)).toBe("foo\n\n|\n\nbar");
      expect(edit("[foo]bar", getEnterEdit)).toBe("\n|bar");
      expect(edit("x[foo]bar", getEnterEdit)).toBe("x\n\n|bar");
    });

    it("should keep the paragraph's indentation", () => {
      expect(edit("    foo|", getEnterEdit)).toBe("    foo\n\n    |");
    });

    it("should only move the line down at its start, or on an empty line", () => {
      expect(edit("|foo", getEnterEdit)).toBe("\n|foo");
      expect(edit("foo\n\n|", getEnterEdit)).toBe("foo\n\n\n|");
      expect(edit("|", getEnterEdit)).toBe("\n|");
    });

    it("should continue a list", () => {
      expect(edit("• foo|", getEnterEdit)).toBe("• foo\n• |");
      expect(edit("• fo|o", getEnterEdit)).toBe("• fo\n• |o");
      expect(edit("    • foo|", getEnterEdit)).toBe("    • foo\n    • |");
      expect(edit("- foo|", getEnterEdit)).toBe("- foo\n- |");
      expect(edit("1. foo|", getEnterEdit)).toBe("1. foo\n2. |");
      expect(edit("9) foo|", getEnterEdit)).toBe("9) foo\n10) |");
      expect(edit("(a) foo|", getEnterEdit)).toBe("(a) foo\n(b) |");
      expect(edit("iv. foo|", getEnterEdit)).toBe("iv. foo\nv. |");
    });

    it("should end a list on an empty item", () => {
      expect(edit("• foo\n• |", getEnterEdit)).toBe("• foo\n\n|");
      expect(edit("1. foo\n2. |", getEnterEdit)).toBe("1. foo\n\n|");
      expect(edit("• |", getEnterEdit)).toBe("|");
      expect(edit("foo\n\n• |", getEnterEdit)).toBe("foo\n\n|");
    });

    it("should move an empty nested item a level up", () => {
      expect(edit("• foo\n    • |", getEnterEdit)).toBe("• foo\n• |");
    });

    it("should not take numbers that aren't list markers for lists", () => {
      expect(edit("1.5 foo|", getEnterEdit)).toBe("1.5 foo\n\n|");
      expect(edit("-5 °C|", getEnterEdit)).toBe("-5 °C\n\n|");
    });
  });

  describe("Backspace", () => {
    it("should join a paragraph with the one above", () => {
      expect(edit("foo\n\n|bar", getBackspaceEdit)).toBe("foo|bar");
      expect(edit("foo\n\n|", getBackspaceEdit)).toBe("foo|");
    });

    it("should otherwise leave it to the browser", () => {
      expect(edit("foo\n|bar", getBackspaceEdit)).toBe(null);
      expect(edit("foo\n\n\n|bar", getBackspaceEdit)).toBe(null);
      expect(edit("fo|o", getBackspaceEdit)).toBe(null);
      expect(edit("[foo]", getBackspaceEdit)).toBe(null);
      expect(edit("1.|", getBackspaceEdit)).toBe(null);
    });

    it("should remove a list marker right after it", () => {
      expect(edit("• |foo", getBackspaceEdit)).toBe("|foo");
      expect(edit("x\n    • |", getBackspaceEdit)).toBe("x\n    |");
      expect(edit("12. |foo", getBackspaceEdit)).toBe("|foo");
    });
  });

  describe("Delete", () => {
    it("should join a paragraph with the one below", () => {
      expect(edit("foo|\n\nbar", getDeleteEdit)).toBe("foo|bar");
      expect(edit("foo|\nbar", getDeleteEdit)).toBe(null);
      expect(edit("|\n\nbar", getDeleteEdit)).toBe(null);
    });
  });

  describe("auto bullet", () => {
    it("should turn a typed `- ` or `* ` at the start of a line into a bullet", () => {
      expect(
        edit("- |", (value, caret) => getAutoBulletEdit(value, caret)),
      ).toBe("• |");
      expect(
        edit("foo\n  * |", (value, caret) => getAutoBulletEdit(value, caret)),
      ).toBe("foo\n  • |");
      expect(
        edit("a - |", (value, caret) => getAutoBulletEdit(value, caret)),
      ).toBe(null);
      expect(
        edit("- |foo", (value, caret) => getAutoBulletEdit(value, caret)),
      ).toBe("• |foo");
    });
  });

  describe("toggle bullets", () => {
    it("should bullet the caret's line", () => {
      expect(edit("f|oo", getToggleBulletsEdit)).toBe("• f|oo");
      expect(edit("|", getToggleBulletsEdit)).toBe("• |");
      expect(edit("1. foo|", getToggleBulletsEdit)).toBe("• foo|");
    });

    it("should remove the caret's line's bullet", () => {
      expect(edit("• fo|o", getToggleBulletsEdit)).toBe("fo|o");
      expect(edit("• |foo", getToggleBulletsEdit)).toBe("|foo");
    });

    it("should bullet the selected lines, skipping empty ones", () => {
      expect(edit("f[oo\n\nbar\n  b]az\nqux", getToggleBulletsEdit)).toBe(
        "[• foo\n\n• bar\n  • baz]\nqux",
      );
      expect(edit("[foo\n• bar\n]baz", getToggleBulletsEdit)).toBe(
        "[• foo\n• bar]\nbaz",
      );
    });

    it("should remove the bullets of the selected lines if all have one", () => {
      expect(edit("[• foo\n\n  • bar]", getToggleBulletsEdit)).toBe(
        "[foo\n\n  bar]",
      );
    });
  });
});
