import {
  FONT_FAMILY,
  getFontFamilyString,
  getLineHeight,
  getVerticalOffset,
  GOOGLE_FONTS_ID_OFFSET,
  isGoogleFontFamily,
  registerRuntimeFont,
  updateRuntimeFontMetrics,
} from "@excalidraw/common";

import { restoreAppState } from "../../data/restore";

import {
  getGoogleFontCssUrl,
  getGoogleFontsConfig,
  parseGoogleFontsCatalog,
  parseGoogleFontsCss,
  setGoogleFontsConfig,
} from "./index";

const CSS2_RESPONSE = `/* cyrillic */
@font-face {
  font-family: 'Playfair Display';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/playfairdisplay/v40/cyrillic.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
/* latin-italic */
@font-face {
  font-family: 'Playfair Display';
  font-style: italic;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/playfairdisplay/v40/italic.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
/* latin */
@font-face {
  font-family: 'Playfair Display';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/playfairdisplay/v40/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153;
}
/* insecure */
@font-face {
  font-family: 'Playfair Display';
  src: url(http://example.com/latin.woff2) format('woff2');
}`;

describe("Google Fonts", () => {
  afterEach(() => {
    setGoogleFontsConfig(false);
  });

  describe("css2 parsing", () => {
    it("parses normal style font faces with their unicode ranges", () => {
      expect(parseGoogleFontsCss(CSS2_RESPONSE)).toEqual([
        {
          uri: "https://fonts.gstatic.com/s/playfairdisplay/v40/cyrillic.woff2",
          descriptors: {
            weight: "400",
            unicodeRange:
              "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
          },
        },
        {
          uri: "https://fonts.gstatic.com/s/playfairdisplay/v40/latin.woff2",
          descriptors: {
            weight: "400",
            unicodeRange: "U+0000-00FF, U+0131, U+0152-0153",
          },
        },
      ]);
    });

    it("parses a `text` subset without a unicode range", () => {
      expect(
        parseGoogleFontsCss(`@font-face {
  font-family: 'Lobster';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/l/font?kit=abc&skey=def&v=v20) format('woff2');
}`),
      ).toEqual([
        {
          uri: "https://fonts.gstatic.com/l/font?kit=abc&skey=def&v=v20",
          descriptors: { weight: "400" },
        },
      ]);
    });
  });

  describe("config", () => {
    it("is disabled by default and uses Google's API when enabled", () => {
      expect(getGoogleFontsConfig().enabled).toBe(false);

      setGoogleFontsConfig(true);
      expect(getGoogleFontsConfig()).toEqual({
        enabled: true,
        cssBaseUrl: "https://fonts.googleapis.com",
      });
      expect(getGoogleFontCssUrl("Playfair Display")).toBe(
        "https://fonts.googleapis.com/css2?family=Playfair+Display&display=swap",
      );
    });

    it("supports a custom css base url", () => {
      setGoogleFontsConfig({ cssBaseUrl: "https://fonts.example.com/" });
      expect(getGoogleFontCssUrl("Noto Sans JP", "Noto Sans JP")).toBe(
        "https://fonts.example.com/css2?family=Noto+Sans+JP&display=swap&text=Noto%20Sans%20JP",
      );
    });
  });

  describe("catalog", () => {
    it("derives stable ids from the catalog index", () => {
      const fonts = parseGoogleFontsCatalog([
        ["Roboto", "s", 2, 1.17],
        ["Lobster", "d", 40, 1.25],
        ["Old Font", "h", 0, 1.3, 1],
      ]);

      expect(
        fonts.map((font) => [font.id, font.category, font.removed]),
      ).toEqual([
        [GOOGLE_FONTS_ID_OFFSET, "sans-serif", false],
        [GOOGLE_FONTS_ID_OFFSET + 1, "display", false],
        [GOOGLE_FONTS_ID_OFFSET + 2, "handwriting", true],
      ]);
      expect(fonts.every((font) => isGoogleFontFamily(font.id))).toBe(true);
      expect(isGoogleFontFamily(FONT_FAMILY.Excalifont)).toBe(false);
    });
  });

  describe("runtime registry", () => {
    const fontFamily = GOOGLE_FONTS_ID_OFFSET + 5_000;

    it("resolves font strings & metrics of registered runtime fonts", () => {
      const excalifontOffset = getVerticalOffset(
        FONT_FAMILY.Excalifont,
        20,
        25,
      );

      // unknown before registration, falls back to defaults
      expect(getLineHeight(fontFamily)).toBe(1.25);
      expect(getVerticalOffset(fontFamily, 20, 25)).toBe(excalifontOffset);

      registerRuntimeFont(fontFamily, {
        name: "Noto Sans Symbols 2",
        category: "serif",
        metadata: {
          metrics: {
            unitsPerEm: 1000,
            ascender: 886,
            descender: -374,
            lineHeight: 1.4,
          },
        },
      });

      expect(getFontFamilyString({ fontFamily })).toBe(
        `"Noto Sans Symbols 2", serif, Segoe UI Emoji`,
      );
      expect(getLineHeight(fontFamily)).toBe(1.4);

      updateRuntimeFontMetrics(fontFamily, { ascender: 1000, descender: -250 });
      expect(getVerticalOffset(fontFamily, 20, 25)).not.toBe(excalifontOffset);
    });
  });

  describe("restore", () => {
    it("keeps google fonts in top picks & recently used fonts", () => {
      const googleFont = GOOGLE_FONTS_ID_OFFSET + 42;

      const appState = restoreAppState(
        {
          fontTopPicks: [googleFont, FONT_FAMILY.Excalifont, 4],
          recentFontFamilies: [
            googleFont,
            FONT_FAMILY.Nunito,
            "nope" as any,
            googleFont,
            ...Array.from({ length: 10 }, (_, i) => GOOGLE_FONTS_ID_OFFSET + i),
          ],
        },
        null,
      );

      expect(appState.fontTopPicks).toEqual([
        googleFont,
        FONT_FAMILY.Excalifont,
      ]);
      expect(appState.recentFontFamilies).toEqual([
        googleFont,
        ...Array.from({ length: 7 }, (_, i) => GOOGLE_FONTS_ID_OFFSET + i),
      ]);
      expect(restoreAppState({}, null).recentFontFamilies).toBe(null);
    });
  });
});
