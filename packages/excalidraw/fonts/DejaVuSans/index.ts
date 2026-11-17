import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import Cyrilic from "./DejaVuSans-Regular-cyrillic.woff2";
import CyrilicExt from "./DejaVuSans-Regular-cyrillic-ext.woff2";
import Greek from "./DejaVuSans-Regular-greek.woff2";
import Latin from "./DejaVuSans-Regular-latin.woff2";
import LatinExt from "./DejaVuSans-Regular-latin-ext.woff2";
import Vietnamese from "./DejaVuSans-Regular-vietnamese.woff2";

/** DejaVu Sans, the bundled look-alike of Verdana */
export const DejaVuSansFontFaces: ExcalidrawFontFaceDescriptor[] = [
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
