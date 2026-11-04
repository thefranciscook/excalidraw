import { getTextStyleShortcut } from "@excalidraw/common";

import {
  CaptureUpdateAction,
  isRangeStyled,
  isTextElement,
  newElementWith,
  setTextStyle,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeleted,
  TextStyle,
} from "@excalidraw/element/types";

import { getSelectedElements } from "../scene";

import { register } from "./register";

import type { AppState } from "../types";

/** selected texts, including the labels of selected containers */
const getSelectedTextElements = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
) =>
  getSelectedElements(elements, appState, {
    includeBoundTextElement: true,
  }).filter(
    (element): element is NonDeleted<ExcalidrawTextElement> =>
      isTextElement(element) && !!element.originalText,
  );

/**
 * Toggles a style for the whole text of the selected text elements (and
 * labels): removed if they all have it already, applied to all otherwise.
 * Formatting parts of a text is done in the text editor.
 */
const createToggleTextStyleAction = <T extends ActionName>(
  name: T,
  style: TextStyle,
) =>
  register({
    name,
    label: `labels.${style}`,
    trackEvent: { category: "element" },
    predicate: (elements, appState) =>
      getSelectedTextElements(elements, appState).length > 0,
    perform: (elements, appState) => {
      const selected = getSelectedTextElements(elements, appState);

      if (!selected.length) {
        return false;
      }

      const enabled = !selected.every((element) =>
        isRangeStyled(
          element.textStyles,
          0,
          element.originalText.length,
          style,
        ),
      );
      const selectedIds = new Set(selected.map((element) => element.id));

      return {
        elements: elements.map((element) => {
          if (!selectedIds.has(element.id) || !isTextElement(element)) {
            return element;
          }
          return newElementWith(element, {
            // an empty array clears it (`undefined` is no update)
            textStyles:
              setTextStyle(
                element.textStyles,
                0,
                element.originalText.length,
                style,
                enabled,
                element.originalText.length,
              ) ?? [],
          });
        }),
        appState,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      };
    },
    keyTest: (event, appState, elements) =>
      !appState.editingTextElement &&
      getTextStyleShortcut(event) === style &&
      getSelectedTextElements(elements, appState).length > 0,
  });

type ActionName = "toggleTextBold" | "toggleTextItalic" | "toggleTextUnderline";

export const actionToggleTextBold = createToggleTextStyleAction(
  "toggleTextBold",
  "bold",
);

export const actionToggleTextItalic = createToggleTextStyleAction(
  "toggleTextItalic",
  "italic",
);

export const actionToggleTextUnderline = createToggleTextStyleAction(
  "toggleTextUnderline",
  "underline",
);
