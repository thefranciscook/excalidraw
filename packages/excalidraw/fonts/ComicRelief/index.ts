import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import Cyrilic from "./ComicRelief-Regular-cyrillic.woff2";
import Greek from "./ComicRelief-Regular-greek.woff2";
import Latin from "./ComicRelief-Regular-latin.woff2";
import LatinExt from "./ComicRelief-Regular-latin-ext.woff2";

/** Comic Relief, the bundled look-alike of Comic Sans MS */
export const ComicReliefFontFaces: ExcalidrawFontFaceDescriptor[] = [
  {
    uri: Cyrilic,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC },
  },
  {
    uri: Greek,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.GREEK },
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
