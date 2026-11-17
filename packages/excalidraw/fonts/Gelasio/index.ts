import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import Latin from "./Gelasio-Regular-latin.woff2";
import LatinExt from "./Gelasio-Regular-latin-ext.woff2";
import Vietnamese from "./Gelasio-Regular-vietnamese.woff2";

/** Gelasio, the bundled look-alike of Georgia */
export const GelasioFontFaces: ExcalidrawFontFaceDescriptor[] = [
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
