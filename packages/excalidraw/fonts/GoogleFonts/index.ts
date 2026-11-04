import {
  DEFAULT_RUNTIME_FONT_METRICS,
  GOOGLE_FONTS_ID_OFFSET,
  isGoogleFontFamily,
  quoteFontFamilyName,
  type FontMetadata,
  type RuntimeFontCategory,
} from "@excalidraw/common";

import type { ExcalidrawFontFaceDescriptor } from "../Fonts";

// -----------------------------------------------------------------------------
// config
// -----------------------------------------------------------------------------

export const DEFAULT_GOOGLE_FONTS_CSS_BASE_URL = "https://fonts.googleapis.com";

export interface GoogleFontsConfig {
  enabled: boolean;
  /**
   * Base url of a Google Fonts compatible CSS API (`<base>/css2?family=...`),
   * i.e. a self-hosted proxy or a privacy-friendly mirror.
   */
  cssBaseUrl: string;
}

let config: GoogleFontsConfig = {
  enabled: false,
  cssBaseUrl: DEFAULT_GOOGLE_FONTS_CSS_BASE_URL,
};

export const getGoogleFontsConfig = (): Readonly<GoogleFontsConfig> => config;

export const setGoogleFontsConfig = (
  value: boolean | { cssBaseUrl?: string } | undefined,
) => {
  if (!value) {
    config = { ...config, enabled: false };
    return;
  }

  config = {
    enabled: true,
    cssBaseUrl: (
      (typeof value === "object" && value.cssBaseUrl) ||
      DEFAULT_GOOGLE_FONTS_CSS_BASE_URL
    ).replace(/\/+$/, ""),
  };
};

// -----------------------------------------------------------------------------
// catalog
// -----------------------------------------------------------------------------

/** [family, categoryCode, popularityRank, lineHeight, removed?] */
export type GoogleFontsCatalogEntry = [string, string, number, number, 1?];

export interface GoogleFontInfo {
  id: number;
  name: string;
  category: RuntimeFontCategory;
  /** 1 = most popular, 0 = unknown (removed) */
  popularity: number;
  lineHeight: number;
  removed: boolean;
}

const CATEGORIES: Record<string, RuntimeFontCategory> = {
  s: "sans-serif",
  r: "serif",
  d: "display",
  h: "handwriting",
  m: "monospace",
};

export const parseGoogleFontsCatalog = (
  entries: readonly GoogleFontsCatalogEntry[],
): GoogleFontInfo[] =>
  entries.map(([name, category, popularity, lineHeight, removed], index) => ({
    id: GOOGLE_FONTS_ID_OFFSET + index,
    name,
    category: CATEGORIES[category] ?? "sans-serif",
    popularity,
    lineHeight,
    removed: !!removed,
  }));

let catalogPromise: Promise<GoogleFontInfo[]> | null = null;
let catalogById: Map<number, GoogleFontInfo> | null = null;

/**
 * Lazily loads the Google Fonts catalog (a separate chunk, never part of the
 * main bundle).
 */
export const loadGoogleFontsCatalog = (): Promise<GoogleFontInfo[]> => {
  if (!catalogPromise) {
    catalogPromise = import("./catalog.json")
      .then((module) => {
        const json = (module.default ?? module) as unknown as {
          fonts: GoogleFontsCatalogEntry[];
        };
        const fonts = parseGoogleFontsCatalog(json.fonts);
        catalogById = new Map(fonts.map((font) => [font.id, font]));
        return fonts;
      })
      .catch((error) => {
        catalogPromise = null;
        throw error;
      });
  }
  return catalogPromise;
};

/** sync lookup, available only once the catalog has been loaded */
export const getGoogleFontInfo = (id: number) => catalogById?.get(id);

export const getGoogleFontInfoAsync = async (id: number) => {
  if (!isGoogleFontFamily(id)) {
    return undefined;
  }
  await loadGoogleFontsCatalog();
  return catalogById?.get(id);
};

// -----------------------------------------------------------------------------
// css2 api
// -----------------------------------------------------------------------------

const encodeFamily = (name: string) =>
  encodeURIComponent(name).replace(/%20/g, "+");

export const getGoogleFontCssUrl = (name: string, text?: string) => {
  const url = `${config.cssBaseUrl}/css2?family=${encodeFamily(
    name,
  )}&display=swap`;
  return text ? `${url}&text=${encodeURIComponent(text)}` : url;
};

/**
 * Parses `@font-face` rules of a Google Fonts css2 response into font face
 * descriptors (one per unicode-range subset).
 */
export const parseGoogleFontsCss = (
  css: string,
): ExcalidrawFontFaceDescriptor[] => {
  const descriptors: ExcalidrawFontFaceDescriptor[] = [];
  const blocks = css.match(/@font-face\s*{[^}]*}/g) ?? [];

  for (const block of blocks) {
    const src = block.match(/src:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/)?.[1];

    if (!src || !/^https:\/\//.test(src)) {
      continue;
    }

    const style = block.match(/font-style:\s*([^;]+);/)?.[1]?.trim();

    if (style && style !== "normal") {
      continue;
    }

    const weight = block.match(/font-weight:\s*([^;]+);/)?.[1]?.trim();
    const unicodeRange = block
      .match(/unicode-range:\s*([^;]+);/)?.[1]
      ?.trim()
      .replace(/\s+/g, " ");

    const fontFaceDescriptors: FontFaceDescriptors = {};

    if (weight) {
      fontFaceDescriptors.weight = weight;
    }

    if (unicodeRange) {
      fontFaceDescriptors.unicodeRange = unicodeRange;
    }

    descriptors.push({ uri: src, descriptors: fontFaceDescriptors });
  }

  return descriptors;
};

const cssCache = new Map<string, Promise<ExcalidrawFontFaceDescriptor[]>>();

export const fetchGoogleFontDescriptors = (
  name: string,
): Promise<ExcalidrawFontFaceDescriptor[]> => {
  const url = getGoogleFontCssUrl(name);
  let promise = cssCache.get(url);

  if (!promise) {
    promise = fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        const descriptors = parseGoogleFontsCss(await response.text());
        if (!descriptors.length) {
          throw new Error("no font faces found");
        }
        return descriptors;
      })
      .catch((error) => {
        cssCache.delete(url);
        throw new Error(`Failed to load Google Font "${name}": ${error}`);
      });
    cssCache.set(url, promise);
  }

  return promise;
};

// -----------------------------------------------------------------------------
// metrics
// -----------------------------------------------------------------------------

const METRICS_STORAGE_KEY = "excalidraw-google-fonts-metrics";

type StoredMetrics = Record<string, [ascender: number, descender: number]>;

let storedMetrics: StoredMetrics | null = null;

const getStoredMetrics = (): StoredMetrics => {
  if (!storedMetrics) {
    try {
      storedMetrics = JSON.parse(
        window.localStorage.getItem(METRICS_STORAGE_KEY) || "{}",
      );
    } catch {
      storedMetrics = {};
    }
  }
  return storedMetrics!;
};

const storeMetrics = (name: string, ascender: number, descender: number) => {
  const metrics = getStoredMetrics();
  metrics[name] = [ascender, descender];
  try {
    window.localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(metrics));
  } catch {
    // storage full or unavailable, metrics will be re-measured next time
  }
};

/**
 * Initial metadata for a Google Font, using the previously measured metrics
 * when available.
 */
export const getGoogleFontMetadata = (info: GoogleFontInfo): FontMetadata => {
  const stored = getStoredMetrics()[info.name];

  return {
    metrics: {
      ...DEFAULT_RUNTIME_FONT_METRICS,
      lineHeight: info.lineHeight || DEFAULT_RUNTIME_FONT_METRICS.lineHeight,
      ...(stored ? { ascender: stored[0], descender: stored[1] } : null),
    },
  };
};

export const hasStoredGoogleFontMetrics = (name: string) =>
  !!getStoredMetrics()[name];

/**
 * Measures the (hhea) ascender & descender of an already loaded font, in
 * units of a 1000 units-per-em font.
 */
export const measureGoogleFontMetrics = (
  name: string,
  ownerDocument: Document,
): { ascender: number; descender: number } | null => {
  try {
    const context = ownerDocument.createElement("canvas").getContext("2d");

    if (!context) {
      return null;
    }

    context.font = `1000px ${quoteFontFamilyName(name)}`;
    const { fontBoundingBoxAscent, fontBoundingBoxDescent } =
      context.measureText(" ");

    if (
      !Number.isFinite(fontBoundingBoxAscent) ||
      !Number.isFinite(fontBoundingBoxDescent) ||
      fontBoundingBoxAscent <= 0
    ) {
      return null;
    }

    const ascender = Math.round(fontBoundingBoxAscent);
    const descender = -Math.round(fontBoundingBoxDescent);

    storeMetrics(name, ascender, descender);

    return { ascender, descender };
  } catch {
    return null;
  }
};
