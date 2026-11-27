import { useEffect, useRef, useState } from "react";

import { KEYS } from "@excalidraw/common";

import { t } from "../i18n";

import { ZoomInIcon, ZoomOutIcon } from "./icons";

import "./FontSizeStepper.scss";

export const MIN_STEPPER_FONT_SIZE = 1;
export const MAX_STEPPER_FONT_SIZE = 999;

/**
 * Sizes the − / + buttons step through (includes the S/M/L/XL presets).
 * Past either end it keeps going by a fixed step, up to the limits above.
 */
const FONT_SIZE_STEPS = [
  6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112,
  128, 144, 160, 192, 224, 256, 320, 384, 448, 512,
];

const clampFontSize = (size: number) =>
  Math.min(MAX_STEPPER_FONT_SIZE, Math.max(MIN_STEPPER_FONT_SIZE, size));

/** the next size on the ladder above (`1`) or below (`-1`) `size` */
export const stepFontSize = (size: number, direction: 1 | -1) => {
  const first = FONT_SIZE_STEPS[0];
  const last = FONT_SIZE_STEPS[FONT_SIZE_STEPS.length - 1];
  if (direction === 1) {
    const next = FONT_SIZE_STEPS.find((step) => step > size);
    return clampFontSize(next ?? Math.floor(size / 64) * 64 + 64);
  }
  if (size <= first) {
    return clampFontSize(Math.ceil(size) - 1);
  }
  if (size > last) {
    return Math.max(last, Math.ceil(size / 64) * 64 - 64);
  }
  return [...FONT_SIZE_STEPS].reverse().find((step) => step < size) ?? first;
};

const formatFontSize = (size: number) => `${Math.round(size * 10) / 10}`;

export const FontSizeStepper = ({
  value,
  onChange,
  onStep,
}: {
  /** the selection's common font size, or `null` when sizes differ */
  value: number | null;
  onChange: (fontSize: number) => void;
  onStep: (direction: 1 | -1) => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const shownValue = value === null ? "" : formatFontSize(value);
  const [draft, setDraft] = useState(shownValue);
  // whether the field holds typing that wasn't applied yet
  const isTypingRef = useRef(false);

  // follow the selection's size (other controls, steps, undo), but don't
  // overwrite what's being typed
  useEffect(() => {
    if (!isTypingRef.current) {
      setDraft(shownValue);
    }
  }, [shownValue]);

  const commit = () => {
    isTypingRef.current = false;
    const parsed = parseFloat(draft.replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0) {
      const next = clampFontSize(Math.round(parsed * 10) / 10);
      setDraft(formatFontSize(next));
      if (next !== value) {
        onChange(next);
      }
    } else {
      setDraft(shownValue);
    }
  };

  return (
    <div className="font-size-stepper" data-testid="fontSize-stepper">
      <button
        type="button"
        className="font-size-stepper__button"
        title={t("labels.decreaseFontSize")}
        aria-label={t("labels.decreaseFontSize")}
        data-testid="fontSize-decrease"
        onClick={() => onStep(-1)}
      >
        {ZoomOutIcon}
      </button>
      <input
        ref={inputRef}
        className="font-size-stepper__input"
        type="text"
        inputMode="decimal"
        aria-label={t("labels.fontSize")}
        placeholder={value === null ? t("labels.mixedFontSize") : undefined}
        data-testid="fontSize-input"
        value={draft}
        onChange={(event) => {
          isTypingRef.current = true;
          setDraft(event.target.value);
        }}
        onFocus={(event) => event.target.select()}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === KEYS.ENTER) {
            event.preventDefault();
            commit();
          } else if (event.key === KEYS.ESCAPE) {
            event.preventDefault();
            event.stopPropagation();
            isTypingRef.current = false;
            setDraft(shownValue);
            event.currentTarget.blur();
          } else if (
            event.key === KEYS.ARROW_UP ||
            event.key === KEYS.ARROW_DOWN
          ) {
            event.preventDefault();
            const direction = event.key === KEYS.ARROW_UP ? 1 : -1;
            const parsed = parseFloat(draft.replace(",", "."));
            isTypingRef.current = false;
            if (Number.isFinite(parsed) && parsed > 0 && parsed !== value) {
              // a typed size that wasn't applied yet: step from it
              const next = stepFontSize(parsed, direction);
              setDraft(formatFontSize(next));
              onChange(next);
            } else {
              onStep(direction);
            }
          }
          // keep typing out of the canvas' keyboard shortcuts
          event.stopPropagation();
        }}
      />
      <button
        type="button"
        className="font-size-stepper__button"
        title={t("labels.increaseFontSize")}
        aria-label={t("labels.increaseFontSize")}
        data-testid="fontSize-increase"
        onClick={() => onStep(1)}
      >
        {ZoomInIcon}
      </button>
    </div>
  );
};
