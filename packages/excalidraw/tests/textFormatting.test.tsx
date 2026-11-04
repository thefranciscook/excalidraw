import { KEYS } from "@excalidraw/common";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";

import { Excalidraw, exportToSvg } from "../index";
import { restoreElements } from "../data/restore";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { getTextEditor, updateTextEditor } from "./queries/dom";
import { fireEvent, render, unmountComponent } from "./test-utils";

const { h } = window;
const mouse = new Pointer("mouse");

unmountComponent();

const getText = () =>
  h.elements.find(
    (element): element is ExcalidrawTextElement => element.type === "text",
  )!;

const pressInEditor = (
  editor: HTMLTextAreaElement,
  key: string,
  modifiers: { shift?: boolean } = {},
) =>
  fireEvent.keyDown(editor, {
    key,
    ctrlKey: true,
    shiftKey: !!modifiers.shift,
  });

describe("text formatting", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  describe("in the text editor", () => {
    const openEditor = async (text: string) => {
      UI.clickTool("text");
      mouse.clickAt(100, 100);
      const editor = await getTextEditor();
      updateTextEditor(editor, text);
      return editor;
    };

    it("formats the selected part of the text", async () => {
      const editor = await openEditor("Hello bold world");

      editor.setSelectionRange(6, 10);
      pressInEditor(editor, KEYS.B);
      editor.setSelectionRange(11, 16);
      pressInEditor(editor, KEYS.U);

      expect(getText().textStyles).toEqual([
        { start: 6, end: 10, bold: true },
        { start: 11, end: 16, underline: true },
      ]);

      // the textarea's glyphs are hidden, the mirror shows the formatting
      const mirror = document.querySelector(".excalidraw-wysiwyg-mirror")!;
      expect((mirror as HTMLElement).style.display).toBe("block");
      expect(
        Array.from(mirror.querySelectorAll("span")).map((span) => [
          span.textContent,
          span.dataset.textStyle,
        ]),
      ).toEqual([
        ["Hello ", ""],
        ["bold", "bold"],
        [" ", ""],
        ["world", "underline"],
      ]);

      // toggles off when all of the selection has the style
      editor.setSelectionRange(7, 9);
      pressInEditor(editor, KEYS.B);
      expect(getText().textStyles?.filter((range) => range.bold)).toEqual([
        { start: 6, end: 7, bold: true },
        { start: 9, end: 10, bold: true },
      ]);

      Keyboard.exitTextEditor(editor);
      expect(getText().textStyles).toEqual([
        { start: 6, end: 7, bold: true },
        { start: 9, end: 10, bold: true },
        { start: 11, end: 16, underline: true },
      ]);
      expect(document.querySelector(".excalidraw-wysiwyg-mirror")).toBe(null);
    });

    it("keeps the formatting on the same characters while typing", async () => {
      const editor = await openEditor("Hello bold world");
      editor.setSelectionRange(6, 10);
      pressInEditor(editor, KEYS.I);

      // typed before
      updateTextEditor(editor, "Oh, Hello bold world");
      expect(getText().textStyles).toEqual([
        { start: 10, end: 14, italic: true },
      ]);

      // typed at the end of the italic run continues it
      editor.setSelectionRange(14, 14);
      fireEvent.change(editor, { target: { value: "Oh, Hello bolder world" } });
      editor.setSelectionRange(16, 16);
      fireEvent.input(editor);
      expect(getText().textStyles).toEqual([
        { start: 10, end: 16, italic: true },
      ]);
    });

    it("applies a style toggled at a collapsed caret to typed text", async () => {
      const editor = await openEditor("Hello");
      editor.setSelectionRange(5, 5);
      pressInEditor(editor, KEYS.B);
      expect(getText().textStyles).toBe(undefined);

      fireEvent(editor, new InputEvent("beforeinput"));
      updateTextEditor(editor, "Hello you");
      expect(getText().textStyles).toEqual([{ start: 5, end: 9, bold: true }]);
    });

    it("undoes & redoes formatting toggles", async () => {
      const editor = await openEditor("Hello bold world");
      editor.setSelectionRange(6, 10);
      pressInEditor(editor, KEYS.B);
      expect(getText().textStyles).toEqual([{ start: 6, end: 10, bold: true }]);

      pressInEditor(editor, KEYS.Z);
      expect(getText().textStyles).toEqual([]);

      pressInEditor(editor, KEYS.Z, { shift: true });
      expect(getText().textStyles).toEqual([{ start: 6, end: 10, bold: true }]);
    });

    it("prevents the browser's own shortcuts", async () => {
      const editor = await openEditor("Hello");
      editor.setSelectionRange(0, 5);
      const event = new KeyboardEvent("keydown", {
        key: KEYS.U,
        ctrlKey: true,
        cancelable: true,
        bubbles: true,
      });
      editor.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe("with text selected on the canvas", () => {
    it("toggles the style of the whole text of the selected texts", () => {
      const text1 = API.createElement({ type: "text", text: "Hello" });
      const text2 = {
        ...API.createElement({ type: "text", text: "World" }),
        textStyles: [{ start: 0, end: 2, bold: true as const }],
      };
      API.setElements([text1, text2]);
      API.setSelectedElements([text1, text2]);

      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress(KEYS.B);
      });
      expect(
        h.elements.map(
          (element) => (element as ExcalidrawTextElement).textStyles,
        ),
      ).toEqual([
        [{ start: 0, end: 5, bold: true }],
        [{ start: 0, end: 5, bold: true }],
      ]);

      // all bold → removes it
      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress(KEYS.B);
      });
      expect(
        h.elements.map(
          (element) => (element as ExcalidrawTextElement).textStyles,
        ),
      ).toEqual([[], []]);

      Keyboard.undo();
      expect(
        h.elements.map(
          (element) => (element as ExcalidrawTextElement).textStyles,
        ),
      ).toEqual([
        [{ start: 0, end: 5, bold: true }],
        [{ start: 0, end: 5, bold: true }],
      ]);
    });

    it("formats the label of a selected container", () => {
      const container = API.createElement({ type: "rectangle" });
      const label = API.createElement({
        type: "text",
        text: "Label",
        containerId: container.id,
      });
      const boundContainer = {
        ...container,
        boundElements: [{ type: "text" as const, id: label.id }],
      };
      API.setElements([boundContainer, label]);
      API.setSelectedElements([boundContainer]);

      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress(KEYS.I);
      });
      expect(getText().textStyles).toEqual([
        { start: 0, end: 5, italic: true },
      ]);
    });

    it("leaves the plain tool shortcuts alone", () => {
      const text = API.createElement({ type: "text", text: "Hello" });
      API.setElements([text]);
      API.setSelectedElements([text]);

      Keyboard.keyPress(KEYS.B);
      expect(getText().textStyles).toBe(undefined);
    });
  });

  it("sanitizes formatting on restore", () => {
    const [text] = restoreElements(
      [
        {
          ...API.createElement({ type: "text", text: "Hello" }),
          textStyles: [
            { start: 3, end: 99, bold: true },
            { start: 1, end: 1, italic: true },
            { start: 0, end: 3, bold: true },
          ],
        },
        {
          ...API.createElement({ type: "text", text: "Plain" }),
          textStyles: [{ start: 0, end: 5 }],
        },
      ],
      null,
    ) as ExcalidrawTextElement[];

    expect(text.textStyles).toEqual([{ start: 0, end: 5, bold: true }]);
    expect(
      "textStyles" in
        restoreElements(
          [API.createElement({ type: "text", text: "Plain" })],
          null,
        )[0],
    ).toBe(false);
  });

  it("exports formatted runs to SVG", async () => {
    const text = {
      ...API.createElement({ type: "text", text: "Hello bold italic" }),
      textStyles: [
        { start: 6, end: 10, bold: true as const, underline: true as const },
        { start: 11, end: 17, italic: true as const },
      ],
    };

    const svg = await exportToSvg({
      elements: [text],
      appState: { exportBackground: false },
      files: null,
      skipInliningFonts: true,
    } as any);

    expect(
      Array.from(svg.querySelectorAll("tspan")).map((tspan) => [
        tspan.textContent,
        tspan.getAttribute("stroke") ? "bold" : "",
        tspan.getAttribute("font-style") ?? "",
        tspan.getAttribute("text-decoration") ?? "",
      ]),
    ).toEqual([
      ["Hello ", "", "", ""],
      ["bold", "bold", "", "underline"],
      [" ", "", "", ""],
      ["italic", "", "italic", ""],
    ]);
  });
});
