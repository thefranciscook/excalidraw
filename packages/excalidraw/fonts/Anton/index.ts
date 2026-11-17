import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import Latin from "./Anton-Regular-latin.woff2";
import LatinExt from "./Anton-Regular-latin-ext.woff2";
import Vietnamese from "./Anton-Regular-vietnamese.woff2";

/** Anton, the bundled look-alike of Impact */
export const AntonFontFaces: ExcalidrawFontFaceDescriptor[] = [
  {
    uri: Vietnamese,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.VIETNAMESE },
  },
  {
    uri: LatinExt,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.LATIN_EXT },
  },
  {
    uri: Latin,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.LATIN },
  },
];
