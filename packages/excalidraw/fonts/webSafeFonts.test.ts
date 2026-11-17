import { FONT_FAMILY, getWebSafeFontBackupFamily } from "@excalidraw/common";

import { Fonts } from "./Fonts";

describe("loading the look-alike of a web-safe system font", () => {
  const TEXT = "hello";

  /** a font set in which the browser reports every font as loaded */
  const fontFaceSet = {
    check: () => true,
    has: () => true,
  } as unknown as FontFaceSet;

  const getBackupFontFaces = (fontFamily: number) =>
    Fonts.registered.get(getWebSafeFontBackupFamily(fontFamily)!)!.fontFaces;

  const setStatus = (fontFamily: number, status: FontFaceLoadStatus) => {
    for (const { fontFace } of getBackupFontFaces(fontFamily)) {
      (fontFace as { status: FontFaceLoadStatus }).status = status;
    }
  };

  afterEach(() => {
    setStatus(FONT_FAMILY.Verdana, "unloaded");
  });

  it("registers the system fonts without a file, and their look-alikes with one", () => {
    for (const fontFamily of [
      FONT_FAMILY.Arial,
      FONT_FAMILY["Comic Sans MS"],
      FONT_FAMILY["Courier New"],
      FONT_FAMILY.Georgia,
      FONT_FAMILY.Impact,
      FONT_FAMILY["Times New Roman"],
      FONT_FAMILY.Verdana,
    ]) {
      const { metadata, fontFaces } = Fonts.registered.get(fontFamily)!;

      expect(metadata.local).toBe(true);
      expect(fontFaces.every((fontFace) => !fontFace.urls.length)).toBe(true);

      const backupFontFaces = getBackupFontFaces(fontFamily);

      expect(backupFontFaces.length).toBeGreaterThan(0);
      for (const fontFace of backupFontFaces) {
        expect(String(fontFace.urls[0])).toMatch(/\.woff2$/);
      }
    }
  });

  it("isn't taken as loaded just because the browser knows a font of that name", () => {
    // i.e. DejaVu Sans is installed on most Linux machines, so the browser
    // answers that "Verdana, DejaVu Sans" needs no loading, but the font that
    // gets drawn is the bundled DejaVu Sans, which hasn't loaded yet
    expect(
      Fonts.areFontFacesLoaded(
        FONT_FAMILY.Verdana,
        "16px Verdana, DejaVu Sans, sans-serif",
        TEXT,
        fontFaceSet,
      ),
    ).toBe(false);

    setStatus(FONT_FAMILY.Verdana, "loading");

    expect(
      Fonts.areFontFacesLoaded(
        FONT_FAMILY.Verdana,
        "16px Verdana, DejaVu Sans, sans-serif",
        TEXT,
        fontFaceSet,
      ),
    ).toBe(false);
  });

  it("is loaded once the look-alike has loaded, or failed to", () => {
    for (const status of ["loaded", "error"] as const) {
      setStatus(FONT_FAMILY.Verdana, status);

      expect(
        Fonts.areFontFacesLoaded(
          FONT_FAMILY.Verdana,
          "16px Verdana, DejaVu Sans, sans-serif",
          TEXT,
          fontFaceSet,
        ),
      ).toBe(true);
    }
  });

  it("ignores the font faces which don't cover the text", () => {
    // the mocked font faces cover just U+0000-00FF
    expect(
      Fonts.areFontFacesLoaded(
        FONT_FAMILY.Verdana,
        "16px Verdana, DejaVu Sans, sans-serif",
        "Ж",
        fontFaceSet,
      ),
    ).toBe(true);
  });

  it("goes by the browser's answer for the other fonts", () => {
    expect(
      Fonts.areFontFacesLoaded(
        FONT_FAMILY.Nunito,
        "16px Nunito, sans-serif",
        TEXT,
        fontFaceSet,
      ),
    ).toBe(true);

    expect(
      Fonts.areFontFacesLoaded(
        FONT_FAMILY.Nunito,
        "16px Nunito, sans-serif",
        TEXT,
        { check: () => false, has: () => true } as unknown as FontFaceSet,
      ),
    ).toBe(false);
  });
});
