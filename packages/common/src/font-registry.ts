import type { FontMetadata } from "./font-metadata";

/**
 * Font family ids at or above this offset refer to dynamically loaded
 * Google Fonts, where `id = GOOGLE_FONTS_ID_OFFSET + index` in the
 * (append-only) Google Fonts catalog.
 */
export const GOOGLE_FONTS_ID_OFFSET = 10_000;

export const isGoogleFontFamily = (fontFamily: unknown): boolean =>
  typeof fontFamily === "number" &&
  Number.isInteger(fontFamily) &&
  fontFamily >= GOOGLE_FONTS_ID_OFFSET;

export type RuntimeFontGenericFamily =
  | "sans-serif"
  | "serif"
  | "monospace"
  | "cursive";

export type RuntimeFontCategory =
  | "sans-serif"
  | "serif"
  | "display"
  | "handwriting"
  | "monospace";

export interface RuntimeFont {
  /** font family name, as used in CSS (unquoted) */
  name: string;
  category: RuntimeFontCategory;
  metadata: FontMetadata;
}

/** fallback metrics used until the real metrics are measured */
export const DEFAULT_RUNTIME_FONT_METRICS: FontMetadata["metrics"] = {
  unitsPerEm: 1000,
  ascender: 886,
  descender: -374,
  lineHeight: 1.25,
};

const runtimeFonts = new Map<number, RuntimeFont>();

/**
 * Registers a font that isn't bundled with the editor (i.e. Google Fonts),
 * so that synchronous lookups (font strings, metrics) can resolve it.
 */
export const registerRuntimeFont = (id: number, font: RuntimeFont) => {
  runtimeFonts.set(id, font);
};

export const getRuntimeFont = (id: number): RuntimeFont | undefined =>
  runtimeFonts.get(id);

export const getRuntimeFonts = (): ReadonlyMap<number, RuntimeFont> =>
  runtimeFonts;

export const updateRuntimeFontMetrics = (
  id: number,
  metrics: Partial<FontMetadata["metrics"]>,
) => {
  const font = runtimeFonts.get(id);
  if (font) {
    font.metadata = {
      ...font.metadata,
      metrics: { ...font.metadata.metrics, ...metrics },
    };
  }
};

export const getRuntimeFontGenericFamily = (
  category: RuntimeFontCategory,
): RuntimeFontGenericFamily => {
  switch (category) {
    case "serif":
      return "serif";
    case "monospace":
      return "monospace";
    case "handwriting":
      return "cursive";
    default:
      return "sans-serif";
  }
};

/** quotes a family name for use in CSS `font` / `font-family` declarations */
export const quoteFontFamilyName = (name: string) =>
  /^["']/.test(name) ? name : `"${name.replace(/["\\]/g, "")}"`;
