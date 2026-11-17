import {
  FONT_FAMILY,
  FONT_FAMILY_FALLBACKS,
  FONT_METADATA,
  getFontFamilyString,
  getLineHeight,
  getWebSafeFontBackupFamily,
  WEB_SAFE_FONT_BACKUPS,
} from "@excalidraw/common";

describe("web-safe system fonts", () => {
  it("names the installed font first, then its bundled look-alike, then the generic family", () => {
    expect(getFontFamilyString({ fontFamily: FONT_FAMILY.Arial })).toBe(
      "Arial, Liberation Sans, sans-serif, Segoe UI Emoji",
    );
    expect(
      getFontFamilyString({ fontFamily: FONT_FAMILY["Comic Sans MS"] }),
    ).toBe("Comic Sans MS, Comic Relief, sans-serif, Segoe UI Emoji");
    expect(
      getFontFamilyString({ fontFamily: FONT_FAMILY["Courier New"] }),
    ).toBe("Courier New, Cousine, monospace, Segoe UI Emoji");
    expect(getFontFamilyString({ fontFamily: FONT_FAMILY.Georgia })).toBe(
      "Georgia, Gelasio, serif, Segoe UI Emoji",
    );
    expect(getFontFamilyString({ fontFamily: FONT_FAMILY.Impact })).toBe(
      "Impact, Anton, sans-serif, Segoe UI Emoji",
    );
    expect(
      getFontFamilyString({ fontFamily: FONT_FAMILY["Times New Roman"] }),
    ).toBe("Times New Roman, Tinos, serif, Segoe UI Emoji");
    expect(getFontFamilyString({ fontFamily: FONT_FAMILY.Verdana })).toBe(
      "Verdana, DejaVu Sans, sans-serif, Segoe UI Emoji",
    );
  });

  it("leaves the font-family list of the other fonts as it was", () => {
    expect(getFontFamilyString({ fontFamily: FONT_FAMILY.Helvetica })).toBe(
      "Helvetica, sans-serif, Segoe UI Emoji",
    );
    expect(getFontFamilyString({ fontFamily: FONT_FAMILY.Excalifont })).toBe(
      "Excalifont, Xiaolai, sans-serif, Segoe UI Emoji",
    );
    expect(getFontFamilyString({ fontFamily: FONT_FAMILY.Cascadia })).toBe(
      "Cascadia, monospace, Segoe UI Emoji",
    );
  });

  it("has a local font with its own metrics and a bundled look-alike for each", () => {
    const families = Object.keys(WEB_SAFE_FONT_BACKUPS).map(Number);

    expect(families).toHaveLength(7);

    for (const family of families) {
      expect(FONT_METADATA[family]).toMatchObject({ local: true });
      expect(FONT_METADATA[family].deprecated).toBeUndefined();

      const backupFamily = getWebSafeFontBackupFamily(family)!;

      expect(FONT_METADATA[backupFamily]).toBeDefined();
      // the look-alike has a font file, and isn't offered on its own
      expect(FONT_METADATA[backupFamily].local).toBeUndefined();
      expect(
        FONT_METADATA[backupFamily].private ??
          FONT_METADATA[backupFamily].fallback,
      ).toBe(true);
    }

    expect(getWebSafeFontBackupFamily(FONT_FAMILY.Arial)).toBe(
      FONT_FAMILY["Liberation Sans"],
    );
    expect(getWebSafeFontBackupFamily(FONT_FAMILY.Georgia)).toBe(
      FONT_FAMILY_FALLBACKS.Gelasio,
    );
    expect(getWebSafeFontBackupFamily(FONT_FAMILY.Nunito)).toBeUndefined();
  });

  it("uses the line height of the font, not the default one", () => {
    expect(getLineHeight(FONT_FAMILY.Arial)).toBe(1.15);
    expect(getLineHeight(FONT_FAMILY["Comic Sans MS"])).toBe(1.4);
    expect(getLineHeight(FONT_FAMILY.Verdana)).toBe(1.2);
  });
});
