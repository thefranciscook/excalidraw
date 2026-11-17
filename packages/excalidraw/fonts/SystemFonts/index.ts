import { LOCAL_FONT_PROTOCOL } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

/**
 * Web-safe system fonts (Arial, Georgia, ...) ship no font file: the browser
 * draws them with the font installed on the machine, or else with the bundled
 * look-alike that follows them in the font-family list.
 */
export const SystemFontFaces: ExcalidrawFontFaceDescriptor[] = [
  {
    uri: LOCAL_FONT_PROTOCOL,
  },
];
