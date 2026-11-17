import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import Cyrilic from "./Tinos-Regular-cyrillic.woff2";
import CyrilicExt from "./Tinos-Regular-cyrillic-ext.woff2";
import Greek from "./Tinos-Regular-greek.woff2";
import Latin from "./Tinos-Regular-latin.woff2";
import LatinExt from "./Tinos-Regular-latin-ext.woff2";
import Vietnamese from "./Tinos-Regular-vietnamese.woff2";

/** Tinos, the bundled look-alike of Times New Roman */
export const TinosFontFaces: ExcalidrawFontFaceDescriptor[] = [
  {
    uri: CyrilicExt,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC_EXT },
  },
  {
    uri: Cyrilic,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC },
  },
  {
    uri: Greek,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.GREEK },
  },
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
