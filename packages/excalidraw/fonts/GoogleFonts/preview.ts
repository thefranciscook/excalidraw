import { quoteFontFamilyName } from "@excalidraw/common";

import { getGoogleFontCssUrl, parseGoogleFontsCss } from "./index";

/**
 * Font previews use the css2 `text` parameter, which serves a tiny font
 * containing just the glyphs of the font name (~hundreds of bytes), under a
 * separate family so that it never clashes with the real font faces.
 */
const previews = new Map<string, Promise<string | null>>();

const getPreviewFamily = (name: string) => `${name} __excalidraw_preview`;

export const loadGoogleFontPreview = (
  name: string,
  ownerDocument: Document = document,
): Promise<string | null> => {
  const url = getGoogleFontCssUrl(name, name);
  let promise = previews.get(url);

  if (!promise) {
    promise = (async () => {
      try {
        const response = await fetch(url);

        if (!response.ok) {
          return null;
        }

        const [descriptor] = parseGoogleFontsCss(await response.text());

        if (!descriptor) {
          return null;
        }

        const family = getPreviewFamily(name);
        const fontFace = new FontFace(family, `url(${descriptor.uri})`, {
          display: "block",
        });

        ownerDocument.fonts.add(fontFace);
        await fontFace.load();

        return quoteFontFamilyName(family);
      } catch {
        previews.delete(url);
        return null;
      }
    })();
    previews.set(url, promise);
  }

  return promise;
};
