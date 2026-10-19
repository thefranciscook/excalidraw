import { BULLET, getListLineMarker } from "@excalidraw/element";

/**
 * Paragraphs and lists in the text editor, which edits plain text:
 *
 * - Enter starts a new paragraph, with a blank line between the two so that
 *   paragraphs stand apart (Shift+Enter breaks the line without one)
 * - in a list (`• `, `1.`, `a)`…), Enter starts the next item (`• `, `2.`,
 *   `b)`…), and on an empty item ends the list
 * - `- ` and `* ` typed at the start of a line turn into a `• ` bullet
 */

/** replace `start`–`end` with `text`, then select `selection` */
export type TextEdit = {
  start: number;
  end: number;
  text: string;
  /** defaults to a caret after the inserted text */
  selection?: { start: number; end: number };
};

export const PARAGRAPH_BREAK = "\n\n";

const TAB_SIZE = 4;

const getLineStart = (value: string, offset: number) =>
  offset > 0 ? value.lastIndexOf("\n", offset - 1) + 1 : 0;

const getLineEnd = (value: string, offset: number) => {
  const end = value.indexOf("\n", offset);
  return end === -1 ? value.length : end;
};

const getLine = (value: string, offset: number) => {
  const start = getLineStart(value, offset);
  const end = getLineEnd(value, offset);
  return { start, end, text: value.slice(start, end) };
};

/** Enter, without modifiers */
export const getEnterEdit = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextEdit => {
  const line = getLine(value, selectionStart);
  const textBefore = value.slice(line.start, selectionStart);
  const marker = getListLineMarker(line.text);

  if (marker && textBefore.length >= marker.contentIndex) {
    const isEmptyItem =
      selectionEnd <= line.end && !line.text.slice(marker.contentIndex).trim();

    if (!isEmptyItem) {
      return {
        start: selectionStart,
        end: selectionEnd,
        text: `\n${marker.nextPrefix}`,
      };
    }

    // an empty, nested item goes a level up…
    if (marker.index > 0) {
      return {
        start: line.start,
        end: line.start + Math.min(marker.index, TAB_SIZE),
        text: "",
        selection: {
          start: line.end - Math.min(marker.index, TAB_SIZE),
          end: line.end - Math.min(marker.index, TAB_SIZE),
        },
      };
    }

    // …and a top-level one ends the list, starting a paragraph below it
    const isAfterText =
      line.start > 0 && !!getLine(value, line.start - 1).text.trim();
    return {
      start: line.start,
      end: line.end,
      text: isAfterText ? "\n" : "",
    };
  }

  // at the start of a line (or on an empty one, or within a list marker),
  // the line just moves down
  if (!textBefore.trim() || marker) {
    return { start: selectionStart, end: selectionEnd, text: "\n" };
  }

  const indent = line.text.match(/^\s*/)![0];
  return {
    start: selectionStart,
    end: selectionEnd,
    text: `${PARAGRAPH_BREAK}${indent}`,
  };
};

/** Backspace, without modifiers */
export const getBackspaceEdit = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextEdit | null => {
  if (selectionStart !== selectionEnd) {
    return null;
  }

  const line = getLine(value, selectionStart);
  const textBefore = value.slice(line.start, selectionStart);
  const marker = getListLineMarker(line.text);

  // right after a list marker (and its space), removes the marker
  if (
    marker &&
    textBefore.length === marker.contentIndex &&
    /\s$/.test(textBefore)
  ) {
    return {
      start: line.start + marker.index,
      end: selectionStart,
      text: "",
    };
  }

  // at the start of a paragraph, joins it with the one above (as Enter split
  // them)
  if (
    !textBefore &&
    /[^\n]\n\n$/.test(
      value.slice(Math.max(0, selectionStart - 3), selectionStart),
    )
  ) {
    return {
      start: selectionStart - PARAGRAPH_BREAK.length,
      end: selectionStart,
      text: "",
    };
  }

  return null;
};

/** Delete, without modifiers */
export const getDeleteEdit = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextEdit | null => {
  if (selectionStart !== selectionEnd) {
    return null;
  }

  const line = getLine(value, selectionStart);

  // at the end of a paragraph, joins it with the one below
  if (
    selectionStart === line.end &&
    line.text &&
    /^\n\n[^\n]/.test(value.slice(selectionStart, selectionStart + 3))
  ) {
    return {
      start: selectionStart,
      end: selectionStart + PARAGRAPH_BREAK.length,
      text: "",
    };
  }

  return null;
};

/**
 * After typing a space: `- ` or `* ` at the start of a line turns into a
 * bullet (undone with Ctrl/Cmd+Z, like any edit).
 */
export const getAutoBulletEdit = (
  value: string,
  caret: number,
): TextEdit | null => {
  const textBefore = value.slice(getLineStart(value, caret), caret);
  if (!/^\s*[-*] $/.test(textBefore)) {
    return null;
  }
  return { start: caret - 2, end: caret, text: `${BULLET} ` };
};

/**
 * Bullets the selected lines, or, if they all are bulleted already, removes
 * their bullets. Numbered items become bulleted ones.
 */
export const getToggleBulletsEdit = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextEdit => {
  const start = getLineStart(value, selectionStart);
  const end = getLineEnd(
    value,
    // a selection ending at the start of a line doesn't take that line
    selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
      ? selectionEnd - 1
      : selectionEnd,
  );
  const lines = value.slice(start, end).split("\n");
  const textLines = lines.filter((line) => line.trim());

  const shouldBullet =
    !textLines.length ||
    textLines.some((line) => !getListLineMarker(line)?.isBullet);

  const nextLines = lines.map((line) => {
    if (!line.trim() && textLines.length) {
      return line;
    }
    const marker = getListLineMarker(line);
    const indent = line.match(/^\s*/)![0];
    const content = marker
      ? line.slice(marker.contentIndex)
      : line.slice(indent.length);
    return shouldBullet ? `${indent}${BULLET} ${content}` : indent + content;
  });
  const text = nextLines.join("\n");

  if (selectionStart === selectionEnd && lines.length === 1) {
    // the caret stays with the text it was at
    const caret = Math.max(
      start +
        nextLines[0].length -
        (lines[0].length - (selectionStart - start)),
      start + (getListLineMarker(nextLines[0])?.contentIndex ?? 0),
    );
    return { start, end, text, selection: { start: caret, end: caret } };
  }

  return {
    start,
    end,
    text,
    selection: { start, end: start + text.length },
  };
};
