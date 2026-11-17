import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import Cyrilic from "./Cousine-Regular-cyrillic.woff2";
import CyrilicExt from "./Cousine-Regular-cyrillic-ext.woff2";
import Greek from "./Cousine-Regular-greek.woff2";
import Latin from "./Cousine-Regular-latin.woff2";
import LatinExt from "./Cousine-Regular-latin-ext.woff2";
import Vietnamese from "./Cousine-Regular-vietnamese.woff2";

/** Cousine, the bundled look-alike of Courier New */
export const CousineFontFaces: ExcalidrawFontFaceDescriptor[] = [
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
