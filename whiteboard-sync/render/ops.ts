// Headless edit page for the Claude connector (whiteboard-sync/mcp/render.js).
// The connector loads /render/ops.html in headless Chromium and calls
//
//   window.__whiteboardOps({ elements }, { add, update, delete, arrange, files })
//
// with the board's elements and Claude's edits (`files`: the images new
// image elements show; paths and SVGs become ordinary elements, see
// vector.ts and svgImport.ts). It answers with the elements
// that changed (new ones included), built with Excalidraw's own code, so
// text is measured with the real fonts, labels sit in their containers and
// arrows are bound to what they point at. It never saves anything: the
// connector merges the result into the board (whiteboard-sync/scene.js).
import {
  convertToExcalidrawElements,
  fixBindingsAfterDeletion,
  getBoundTextElement,
  getCommonBounds,
  isBindableElement,
  isBoundToContainer,
  isFrameLikeElement,
  isLinearElement,
  isTextElement,
  newTextElement,
  normalizeTextStyles,
  redrawTextBoundingBox,
  remapTextStyles,
  Scene,
  setTextStyle,
  syncInvalidIndices,
  syncMovedIndices,
  updateBoundElements,
} from "@excalidraw/element";
import {
  arrayToMap,
  DEFAULT_FONT_FAMILY,
  randomId,
  ROUNDNESS,
} from "@excalidraw/common";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { Fonts } from "@excalidraw/excalidraw/fonts";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  FontFamilyValues,
  OrderedExcalidrawElement,
  TextStyle,
  TextStyleRange,
} from "@excalidraw/element/types";

import { svgToSkeletons, SvgError } from "./svgImport";
import { flattenPath, lineSkeleton, PathError } from "./vector";

import type { Pt } from "./vector";

type Json = Record<string, any>;

type Ops = {
  add?: { elements: Json[]; frame?: string | null };
  update?: Json[];
  delete?: string[];
  arrange?: {
    ids: string[];
    align?: string;
    distribute?: string;
    gap?: number;
    to?: "elements" | "frame";
  };
  // images the new image elements show, by file id (the connector stores them)
  files?: Record<string, { mimeType: string; dataURL: string }>;
};

type OpsResult =
  | {
      ok: true;
      changed: ExcalidrawElement[];
      created: Created[];
      updated: string[];
      deleted: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

declare global {
  interface Window {
    __whiteboardOps?: (
      board: { elements: Json[] },
      ops: Ops,
    ) => Promise<OpsResult>;
    __whiteboardOpsReady?: boolean;
  }
}

class OpsError extends Error {}

type Created = {
  id: string;
  type: string;
  text?: string;
  // a path or SVG drawn as several elements: their ids (also its group id)
  parts?: string[];
};

// props Claude may set with update_elements, by what they apply to
const STYLE_PROPS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "angle",
  "locked",
  "link",
] as const;
const GEOMETRY_PROPS = ["x", "y", "width", "height"] as const;
const TEXT_PROPS = [
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "lineHeight",
] as const;
const LINEAR_PROPS = ["points", "startArrowhead", "endArrowhead"] as const;

// "round" / "sharp", as Claude is told to write it, in Excalidraw's terms
const toRoundness = (value: unknown, type: string) => {
  if (value === "round") {
    return { type: type === "rectangle" || type === "stickynote" ? 3 : 2 };
  }
  if (value === "sharp") {
    return null;
  }
  return value;
};

const pick = (src: Json, keys: readonly string[]) => {
  const out: Json = {};
  for (const k of keys) {
    if (src[k] !== undefined) {
      out[k] = src[k];
    }
  }
  return out;
};

// every text (and label) a batch of skeletons and updates will draw, so the
// fonts are loaded before anything is measured (measurements are cached)
const textsToMeasure = (
  skeletons: Json[],
  updates: Json[],
  existing: Map<string, ExcalidrawElement>,
) => {
  const texts: Json[] = [];
  const add = (text: unknown, fontFamily: unknown) => {
    if (typeof text === "string" && text) {
      texts.push({
        type: "text",
        fontFamily: (typeof fontFamily === "number"
          ? fontFamily
          : DEFAULT_FONT_FAMILY) as FontFamilyValues,
        originalText: text,
        text,
        isDeleted: false,
      });
    }
  };
  for (const s of skeletons) {
    add(s.text, s.fontFamily);
    add(s.label?.text, s.label?.fontFamily);
    add(s.start?.text, s.start?.fontFamily);
    add(s.end?.text, s.end?.fontFamily);
  }
  for (const u of updates) {
    const el = existing.get(u.id);
    const family =
      u.fontFamily ?? (el && isTextElement(el) ? el.fontFamily : undefined);
    add(u.text, family);
    add(u.label, u.fontFamily);
    if (u.fontFamily && el && isTextElement(el)) {
      add(el.originalText, u.fontFamily);
    }
  }
  return texts as unknown as ExcalidrawElement[];
};

// {"cornerRadius": px} -> Excalidraw's fixed-radius rounding (0: sharp)
const cornerRoundness = (radius: unknown) => {
  const r = Number(radius);
  if (!Number.isFinite(r) || r < 0) {
    throw new OpsError("cornerRadius must be a number of pixels (0 or more).");
  }
  return r ? { type: ROUNDNESS.ADAPTIVE_RADIUS, value: r } : null;
};

// {"group": "name"} or ["inner", "outer"] -> groupIds; null: no group
const toGroupIds = (value: unknown): string[] => {
  if (value === null || value === undefined || value === "") {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((g) => typeof g === "string" && g.trim())) {
    throw new OpsError('"group" must be a group id, a list of them, or null.');
  }
  return list.map((g) => g.trim());
};

const TEXT_STYLE_NAMES: readonly TextStyle[] = ["bold", "italic", "underline"];
const hasTextStyleProps = (src: Json | undefined) =>
  !!src &&
  (TEXT_STYLE_NAMES.some((k) => src[k] !== undefined) ||
    src.styles !== undefined);

/**
 * Bold/italic/underline for a text: {"bold": true} for all of it, and
 * "styles": [{"start", "end"} or {"text": "…"}, with "bold"/"italic"/
 * "underline" true or false] for parts (a "text" styles each occurrence).
 */
const applyTextStyleProps = (
  current: readonly TextStyleRange[] | undefined,
  text: string,
  props: Json,
  warnings: string[],
): TextStyleRange[] | undefined => {
  let ranges: TextStyleRange[] | undefined = current ? [...current] : undefined;
  const length = text.length;
  for (const style of TEXT_STYLE_NAMES) {
    if (typeof props[style] === "boolean") {
      ranges = setTextStyle(ranges, 0, length, style, props[style], length);
    }
  }
  if (props.styles !== undefined) {
    if (!Array.isArray(props.styles)) {
      throw new OpsError(
        '"styles" must be a list of {start, end} or {text} with bold/italic/underline.',
      );
    }
    for (const r of props.styles) {
      const spans: [number, number][] = [];
      if (r && typeof r.text === "string" && r.text) {
        for (
          let i = text.indexOf(r.text);
          i >= 0;
          i = text.indexOf(r.text, i + r.text.length)
        ) {
          spans.push([i, i + r.text.length]);
        }
        if (!spans.length) {
          warnings.push(
            `"${r.text.slice(0, 40)}" isn't in the text "${text.slice(
              0,
              40,
            )}" (style skipped).`,
          );
        }
      } else if (r && Number.isInteger(r.start) && Number.isInteger(r.end)) {
        spans.push([r.start, r.end]);
      } else {
        throw new OpsError(
          'Each of "styles" needs "text", or "start" and "end".',
        );
      }
      for (const [start, end] of spans) {
        for (const style of TEXT_STYLE_NAMES) {
          if (typeof r[style] === "boolean") {
            ranges = setTextStyle(ranges, start, end, style, r[style], length);
          }
        }
      }
    }
  }
  return normalizeTextStyles(ranges, length);
};

// skeleton props a path's or an SVG's parts don't take over
const OWN_PROPS = [
  "type",
  "id",
  "x",
  "y",
  "d",
  "svg",
  "scale",
  "closed",
  "group",
  "frame",
  "width",
  "height",
  "z",
  "above",
  "below",
  "points",
];

const lineSize = (points: Pt[]) => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

/**
 * Paths and SVGs become ordinary elements (lines, polygons, shapes, texts),
 * several of them grouped under the skeleton's id; closed lines become
 * polygons. -> the skeletons to build, and which ids became which parts.
 */
const expandVectors = (skeletons: Json[], warnings: string[]) => {
  const out: Json[] = [];
  const parts = new Map<string, { type: string; ids: string[]; z: Json }>();
  for (const s of skeletons) {
    if (s.type === "line" && Array.isArray(s.points)) {
      const points = s.points as Pt[];
      if (s.closed) {
        const [first, last] = [points[0], points[points.length - 1]];
        if (first && (first[0] !== last[0] || first[1] !== last[1])) {
          points.push([first[0], first[1]]);
        }
        s.polygon = points.length > 3;
      }
      delete s.closed;
      if (s.width === undefined && s.height === undefined && points.length) {
        Object.assign(s, lineSize(points));
      }
      out.push(s);
      continue;
    }
    if (s.type !== "path" && s.type !== "svg") {
      out.push(s);
      continue;
    }
    const id = s.id || randomId();
    const name = s.id
      ? `${s.type === "path" ? "Path" : "SVG"} ${s.id}`
      : s.type === "path"
      ? "A path"
      : "An SVG";
    const base = { ...s };
    for (const k of OWN_PROPS) {
      delete base[k];
    }
    let built: Json[] = [];
    if (s.type === "path") {
      if (typeof s.d !== "string" || !s.d.trim()) {
        throw new OpsError(
          'A path needs "d": SVG path data, e.g. "M0 0 C 40 -40, 80 40, 120 0".',
        );
      }
      const scale = Number(s.scale) > 0 ? Number(s.scale) : 1;
      const filled = !!s.backgroundColor && s.backgroundColor !== "transparent";
      let subpaths;
      try {
        subpaths = flattenPath(s.d, scale);
      } catch (e) {
        throw new OpsError(
          `${name}: ${e instanceof PathError ? e.message : String(e)}`,
        );
      }
      for (const sub of subpaths) {
        const line = lineSkeleton(
          sub.points.map(([x, y]): Pt => [x * scale, y * scale]),
          sub.closed || s.closed === true || filled,
        );
        if (line) {
          built.push({
            ...line,
            roughness: 0,
            ...base,
            ...(filled ? { fillStyle: base.fillStyle || "solid" } : {}),
          });
        }
      }
      if (!built.length) {
        throw new OpsError(`${name} draws nothing.`);
      }
    } else {
      if (typeof s.svg !== "string" || !s.svg.trim()) {
        throw new OpsError(
          'An svg element needs "svg" (SVG markup) or "src" (its URL).',
        );
      }
      let result;
      try {
        result = svgToSkeletons(s.svg, {
          width: Number(s.width) || undefined,
          height: Number(s.height) || undefined,
          roughness: typeof s.roughness === "number" ? s.roughness : undefined,
        });
      } catch (e) {
        throw new OpsError(
          `${name}: ${e instanceof SvgError ? e.message : String(e)}`,
        );
      }
      warnings.push(...result.warnings.map((w) => `${name}: ${w}`));
      built = result.skeletons;
      if (!built.length) {
        continue;
      }
    }
    const outer = toGroupIds(s.group);
    const ids =
      built.length === 1 && s.type === "path"
        ? [id]
        : built.map((_, i) => `${id}:${i + 1}`);
    built.forEach((b, i) => {
      out.push({
        ...b,
        id: ids[i],
        x: (Number(s.x) || 0) + b.x,
        y: (Number(s.y) || 0) + b.y,
        ...(s.frame ? { frame: s.frame } : {}),
        groupIds: ids.length > 1 ? [id, ...outer] : outer,
      });
    });
    parts.set(id, { type: s.type, ids, z: pick(s, ["z", "above", "below"]) });
  }
  return { skeletons: out, parts };
};

// an image's natural size, from its data
const imageSize = async (dataURL: string) => {
  const img = new Image();
  img.src = dataURL;
  try {
    await img.decode();
  } catch {
    throw new OpsError(
      "An image couldn't be decoded; is it a PNG, JPEG, GIF, WebP or SVG?",
    );
  }
  return { width: img.naturalWidth || 300, height: img.naturalHeight || 150 };
};
const MAX_IMAGE_SIDE = 800;

const runOps = async (
  board: { elements: Json[] },
  ops: Ops,
): Promise<OpsResult> => {
  const warnings: string[] = [];
  const elements = restoreElements(
    board.elements as ExcalidrawElement[],
    null,
  ) as OrderedExcalidrawElement[];
  const byId = new Map<string, OrderedExcalidrawElement>(
    elements.map((el) => [el.id, el]),
  );
  const live = (id: string) => {
    const el = byId.get(id);
    return el && !el.isDeleted ? el : undefined;
  };
  const before = new Map(
    elements.map((el) => [el.id, `${el.version}:${el.versionNonce}`]),
  );

  // elements of a group: by group id, without labels (they go with their containers)
  const groupMembers = (groupId: string) =>
    [...byId.values()].filter(
      (el) =>
        !el.isDeleted &&
        el.groupIds.includes(groupId) &&
        !(isTextElement(el) && el.containerId),
    );
  // an id given to update, delete or arrange: an element, or else a group
  const resolveIds = (id: unknown): OrderedExcalidrawElement[] => {
    if (typeof id !== "string") {
      return [];
    }
    const el = live(id);
    return el ? [el] : groupMembers(id);
  };

  const expanded = expandVectors(
    (ops.add?.elements || []).map((s) => ({
      ...s,
      ...(s.label && typeof s.label === "object"
        ? { label: { ...s.label } }
        : {}),
    })),
    warnings,
  );
  const skeletons = expanded.skeletons;
  const partsOf = expanded.parts;
  // what's done once the new elements are in the scene, by element id:
  // text styles and fixed widths, and moves in the stacking order
  const textExtras = new Map<
    string,
    { props: Json; x?: number; label: boolean }
  >();
  const zRequests: {
    ids: string[];
    z?: string;
    above?: string;
    below?: string;
  }[] = [];
  // part id -> the path's or SVG's id (paths drawn as one line keep theirs)
  const partOf = new Map<string, string>();
  for (const [id, { ids }] of partsOf) {
    ids.forEach((part) => partOf.set(part, id));
    if (live(id)) {
      throw new OpsError(
        `The id "${id}" is already used on this board. Pick another one.`,
      );
    }
  }
  for (const { ids, z } of partsOf.values()) {
    if (Object.keys(z).length) {
      zRequests.push({ ids, ...z });
    }
  }
  // a frame listing a path or SVG as its child gets all its parts
  for (const s of skeletons) {
    if (Array.isArray(s.children)) {
      s.children = s.children.flatMap(
        (c: string) => partsOf.get(c)?.ids || [c],
      );
    }
  }
  const updates = ops.update || [];

  // images: the file the connector stored, at the size asked (or its own)
  for (const s of skeletons) {
    if (s.type !== "image") {
      continue;
    }
    const file = typeof s.fileId === "string" && ops.files?.[s.fileId];
    if (!file) {
      throw new OpsError(
        'An image needs "src" (an image URL or data URL), "svg", or the "file_id" of an image on the board.',
      );
    }
    const natural = await imageSize(file.dataURL);
    const w = Number(s.width) > 0 ? Number(s.width) : 0;
    const h = Number(s.height) > 0 ? Number(s.height) : 0;
    if (w && h) {
      Object.assign(s, { width: w, height: h });
    } else if (w || h) {
      const k = w ? w / natural.width : h / natural.height;
      Object.assign(s, {
        width: natural.width * k,
        height: natural.height * k,
      });
    } else {
      const k = Math.min(
        1,
        MAX_IMAGE_SIDE / Math.max(natural.width, natural.height),
      );
      Object.assign(s, {
        width: natural.width * k,
        height: natural.height * k,
      });
    }
    Object.assign(s, { status: "saved", scale: [1, 1] });
  }

  await Fonts.loadElementsFonts(textsToMeasure(skeletons, updates, byId));

  const created: Created[] = [];
  const updated = new Set<string>();
  const deleted = new Set<string>();
  let newElements: OrderedExcalidrawElement[] = [];

  // --- add ------------------------------------------------------------------
  if (skeletons.length) {
    const frameId = ops.add?.frame || null;
    const frame = frameId ? live(frameId) : null;
    if (frameId && (!frame || !isFrameLikeElement(frame))) {
      throw new OpsError(`There's no frame with id ${frameId} on this board.`);
    }
    const batchIds = new Set<string>();
    for (const s of skeletons) {
      if (typeof s.type !== "string") {
        throw new OpsError("Every element needs a type.");
      }
      if (s.id !== undefined) {
        if (typeof s.id !== "string" || !s.id.trim()) {
          throw new OpsError("Element ids must be non-empty strings.");
        }
        // a deleted element's id may be used again (see `fresh` below)
        if (live(s.id) || batchIds.has(s.id)) {
          throw new OpsError(
            `The id "${s.id}" is already used on this board. Pick another one, or change that element with update_elements.`,
          );
        }
        batchIds.add(s.id);
      }
      if (s.roundness !== undefined) {
        s.roundness = toRoundness(s.roundness, s.type);
      }
      if (s.cornerRadius !== undefined) {
        s.roundness = cornerRoundness(s.cornerRadius);
        delete s.cornerRadius;
      }
      if (s.group !== undefined) {
        s.groupIds = [...(s.groupIds || []), ...toGroupIds(s.group)];
        delete s.group;
      }
      const textProps = s.type === "text" ? s : s.label;
      if (
        textProps &&
        (hasTextStyleProps(textProps) ||
          (s.type === "text" && s.width !== undefined))
      ) {
        s.id = s.id || randomId();
        textExtras.set(s.id, {
          props: pick(textProps, [...TEXT_STYLE_NAMES, "styles"]),
          label: s.type !== "text",
        });
      }
      if (s.type === "text") {
        delete s.height; // texts are as tall as their lines
      }
      if (s.z !== undefined || s.above !== undefined || s.below !== undefined) {
        s.id = s.id || randomId();
        zRequests.push({ ids: [s.id], ...pick(s, ["z", "above", "below"]) });
      }
    }

    // Children of a frame drawn in the same call are placed relative to it
    // too (frames in frames, relative to their parent): one rule for x/y.
    const batchFrames = new Map<string, Json>();
    const parentOf = new Map<string, string>();
    for (const s of skeletons) {
      if ((s.type === "frame" || s.type === "magicframe") && s.id) {
        batchFrames.set(s.id, s);
        for (const child of s.children || []) {
          parentOf.set(child, s.id);
        }
      }
    }
    // an element may also name its frame itself: {"frame": id}
    const homeFrame = new Map<string, OrderedExcalidrawElement>();
    for (const s of skeletons) {
      if (typeof s.frame !== "string" || !s.frame) {
        continue;
      }
      s.id = s.id || randomId();
      const target = batchFrames.get(s.frame);
      if (target && target !== s) {
        target.children = [...new Set([...(target.children || []), s.id])];
        parentOf.set(s.id, target.id);
      } else {
        const existing = live(s.frame);
        if (!existing || !isFrameLikeElement(existing)) {
          throw new OpsError(
            `There's no frame with id ${s.frame} on this board.`,
          );
        }
        homeFrame.set(s.id, existing);
      }
      delete s.frame;
    }
    // the top-left corner x/y of an element are relative to; elements not
    // in a new frame are relative to the frame drawn in (`frame`), if any
    const offsetOf = (id: string | undefined, depth = 0): [number, number] => {
      const parent = id ? parentOf.get(id) : undefined;
      const f = parent && batchFrames.get(parent);
      if (!f || depth > 8) {
        const home = (id && homeFrame.get(id)) || frame;
        return home ? [home.x, home.y] : [0, 0];
      }
      const [px, py] = offsetOf(parent!, depth + 1);
      return [px + (Number(f.x) || 0), py + (Number(f.y) || 0)];
    };
    const offsets = skeletons.map((s) => offsetOf(s.id));
    skeletons.forEach((s, i) => {
      s.x = (Number(s.x) || 0) + offsets[i][0];
      s.y = (Number(s.y) || 0) + offsets[i][1];
      // a text box of a fixed width: x is its left edge, whatever the alignment
      const extra = s.type === "text" && textExtras.get(s.id);
      if (extra && s.width !== undefined) {
        extra.x = s.x;
        extra.props.width = Number(s.width);
      }
    });
    // An arrow between two elements, without points of its own, goes from
    // edge to edge on the line between their centers. (Given ends far from
    // what they're bound to, convertToExcalidrawElements would unbind them.)
    const boxOf = (id: string) => {
      const s = skeletons.find((x) => x.id === id);
      if (s) {
        return {
          x: s.x,
          y: s.y,
          width: Number(s.width) || 100,
          height: Number(s.height) || 100,
        };
      }
      const el = live(id);
      return el
        ? { x: el.x, y: el.y, width: el.width, height: el.height }
        : null;
    };
    const edgePoint = (box: Json, towardX: number, towardY: number) => {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const dx = towardX - cx;
      const dy = towardY - cy;
      const t = Math.min(
        dx ? box.width / 2 / Math.abs(dx) : Infinity,
        dy ? box.height / 2 / Math.abs(dy) : Infinity,
      );
      return Number.isFinite(t) ? [cx + dx * t, cy + dy * t] : [cx, cy];
    };
    for (const s of skeletons) {
      if (s.type !== "arrow" || s.points || !s.start?.id || !s.end?.id) {
        continue;
      }
      const a = boxOf(s.start.id);
      const b = boxOf(s.end.id);
      if (!a || !b) {
        continue;
      }
      const [x1, y1] = edgePoint(a, b.x + b.width / 2, b.y + b.height / 2);
      const [x2, y2] = edgePoint(b, a.x + a.width / 2, a.y + a.height / 2);
      Object.assign(s, {
        x: x1,
        y: y1,
        points: [
          [0, 0],
          [x2 - x1, y2 - y1],
        ],
      });
      delete s.width;
      delete s.height;
    }

    // where frames were asked to be (convertToExcalidrawElements moves a
    // frame at 0,0 to its children, and fits frames without a size)
    const frameBoxes = new Map<string, Json>();
    for (const f of batchFrames.values()) {
      frameBoxes.set(f.id, pick(f, ["x", "y", "width", "height"]));
    }

    // Arrows (and new frames) may point at elements already on the board.
    // convertToExcalidrawElements only looks within its batch, so copies of
    // those join the batch; only the bindings they gain are kept.
    const referenced = new Set<string>();
    for (const s of skeletons) {
      for (const end of [s.start, s.end]) {
        if (end?.id && !batchIds.has(end.id)) {
          if (!live(end.id)) {
            throw new OpsError(
              `An arrow points at "${end.id}", which isn't on this board.`,
            );
          }
          referenced.add(end.id);
        }
      }
      for (const child of s.children || []) {
        if (!batchIds.has(child)) {
          if (!live(child)) {
            throw new OpsError(
              `Frame "${
                s.name || s.id
              }" lists "${child}" as a child, which isn't on this board.`,
            );
          }
          referenced.add(child);
        }
      }
    }
    const copies = [...referenced].map((id) => ({ ...live(id)! } as Json));

    const converted = convertToExcalidrawElements(
      [...copies, ...skeletons] as ExcalidrawElementSkeleton[],
      { regenerateIds: false },
    );

    for (const el of converted) {
      if (referenced.has(el.id)) {
        const original = live(el.id)!;
        const bound = [...(original.boundElements || [])];
        for (const b of el.boundElements || []) {
          if (!bound.some((x) => x.id === b.id)) {
            bound.push(b);
          }
        }
        const changes: Json = {};
        if (bound.length !== (original.boundElements || []).length) {
          changes.boundElements = bound;
        }
        if (el.frameId !== original.frameId) {
          changes.frameId = el.frameId;
        }
        if (Object.keys(changes).length) {
          Object.assign(original, changes, {
            version: original.version + 1,
            versionNonce: Math.floor(Math.random() * 2 ** 31),
            updated: Date.now(),
          });
        }
        continue;
      }
      // reusing a deleted element's id: newer than its tombstone, or the
      // merge would keep the tombstone
      const tombstone = byId.get(el.id);
      const fresh = {
        ...el,
        index: null,
        ...(frameBoxes.get(el.id) || {}),
        ...(tombstone ? { version: tombstone.version + el.version } : {}),
      } as unknown as OrderedExcalidrawElement;
      const home =
        homeFrame.get(fresh.id) ||
        (isTextElement(fresh) &&
          fresh.containerId &&
          homeFrame.get(fresh.containerId)) ||
        frame;
      if (
        home &&
        !fresh.frameId &&
        (homeFrame.has(fresh.id) || !isFrameLikeElement(fresh))
      ) {
        (fresh as Json).frameId = home.id;
      }
      newElements.push(fresh);
      if (!(isTextElement(fresh) && fresh.containerId)) {
        const whole = partOf.get(fresh.id);
        if (whole) {
          if (!created.some((c) => c.id === whole)) {
            const { type, ids } = partsOf.get(whole)!;
            created.push({ id: whole, type, parts: ids });
          }
          continue;
        }
        created.push({
          id: fresh.id,
          type: fresh.type,
          ...(isTextElement(fresh) ? { text: fresh.originalText } : {}),
        });
      }
    }
  }

  // an arrow (and its label) between two elements in the same frame is in it
  const newById = new Map(newElements.map((el) => [el.id, el]));
  const frameIdOf = (id: string | undefined) =>
    (id ? (newById.get(id) || live(id))?.frameId : null) ?? null;
  for (const el of newElements) {
    if (el.type !== "arrow" || el.frameId) {
      continue;
    }
    const arrow = el as Json;
    const from = frameIdOf(arrow.startBinding?.elementId);
    if (from && from === frameIdOf(arrow.endBinding?.elementId)) {
      arrow.frameId = from;
      for (const b of arrow.boundElements || []) {
        const label = newById.get(b.id) as Json | undefined;
        if (label) {
          label.frameId = from;
        }
      }
    }
  }

  // new elements go on top
  const all = syncInvalidIndices([
    ...elements,
    ...newElements,
  ]) as OrderedExcalidrawElement[];
  newElements = all.slice(elements.length);
  for (const el of newElements) {
    byId.set(el.id, el);
  }
  const scene = new Scene(all, { skipValidation: true });
  const mutate = (el: ExcalidrawElement, changes: Json) =>
    scene.mutateElement(el as any, changes as any, {
      informMutation: false,
      isDragging: false,
    });

  // Moves an element (with its label, a frame with what's in it); arrows
  // bound to it follow. `moved`: what's been moved already in this move.
  const moveBy = (
    el: ExcalidrawElement,
    dx: number,
    dy: number,
    moved: Set<string>,
  ) => {
    if (moved.has(el.id) || (!dx && !dy)) {
      return;
    }
    moved.add(el.id);
    mutate(el, { x: el.x + dx, y: el.y + dy });
    if (!(isTextElement(el) && el.containerId)) {
      updated.add(el.id);
    }
    const label = getBoundTextElement(el, scene.getNonDeletedElementsMap());
    if (label) {
      moved.add(label.id);
      redrawTextBoundingBox(label, el, scene);
    }
    if (isFrameLikeElement(el)) {
      for (const child of scene.getNonDeletedElements()) {
        if (child.frameId === el.id) {
          moveBy(child, dx, dy, moved);
        }
      }
    }
    if (isBindableElement(el)) {
      updateBoundElements(el as any, scene);
    }
  };

  // Moves elements in the stacking order: to the front or back, one step
  // forward or backward, or just above or below another element. Labels
  // stay right above their containers.
  const restack = (req: {
    ids: string[];
    z?: string;
    above?: string;
    below?: string;
  }) => {
    const order = [...scene.getElementsIncludingDeleted()];
    const moving = new Set<string>();
    for (const id of req.ids) {
      const el = scene.getElement(id);
      if (!el || el.isDeleted) {
        continue;
      }
      moving.add(el.id);
      for (const b of el.boundElements || []) {
        if (b.type === "text") {
          moving.add(b.id);
        }
      }
    }
    if (!moving.size) {
      return;
    }
    const rest = order.filter((el) => !moving.has(el.id));
    const block = order.filter((el) => moving.has(el.id));
    const isLabel = (el: ExcalidrawElement) =>
      isTextElement(el) && !!el.containerId;
    // the position in `rest` just above `el` and its label
    const after = (el: ExcalidrawElement) => {
      let at = rest.indexOf(el as OrderedExcalidrawElement) + 1;
      while (
        at < rest.length &&
        isLabel(rest[at]) &&
        (rest[at] as ExcalidrawTextElement).containerId === el.id
      ) {
        at++;
      }
      return at;
    };
    // a label stands for its container
    const owner = (el: ExcalidrawElement) =>
      isLabel(el)
        ? scene.getElement((el as ExcalidrawTextElement).containerId!) || el
        : el;
    let at: number;
    const ref = req.above ?? req.below;
    if (ref !== undefined) {
      const target = typeof ref === "string" ? scene.getElement(ref) : null;
      if (!target || target.isDeleted || moving.has(target.id)) {
        warnings.push(
          `Can't stack ${req.ids.join(", ")} ${
            req.above !== undefined ? "above" : "below"
          } "${ref}": no such other element (left where it was).`,
        );
        return;
      }
      at =
        req.above !== undefined
          ? after(target)
          : rest.indexOf(target as OrderedExcalidrawElement);
    } else if (req.z === "front") {
      at = rest.length;
    } else if (req.z === "back") {
      at = 0;
    } else if (req.z === "forward" || req.z === "backward") {
      const positions = block.map((el) => order.indexOf(el));
      if (req.z === "forward") {
        const top = Math.max(...positions);
        const next = order
          .slice(top + 1)
          .find((el) => !el.isDeleted && !moving.has(el.id));
        at = next ? after(owner(next)) : rest.length;
      } else {
        const bottom = Math.min(...positions);
        const prev = order
          .slice(0, bottom)
          .reverse()
          .find((el) => !el.isDeleted && !moving.has(el.id));
        at = prev ? rest.indexOf(owner(prev) as OrderedExcalidrawElement) : 0;
      }
    } else {
      warnings.push(
        `"z" must be "front", "back", "forward" or "backward" (got ${JSON.stringify(
          req.z,
        )}).`,
      );
      return;
    }
    const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
    syncMovedIndices(next, arrayToMap(block));
    scene.replaceAllElements(next, { skipValidation: true });
    for (const el of block) {
      if (!isLabel(el)) {
        updated.add(el.id);
      }
    }
  };

  // Lines elements up ("align") and/or spaces them evenly ("distribute"),
  // within their bounding box or their frame ("to": "frame"). Each id is an
  // element or a group, which moves as a whole.
  const arrange = (req: NonNullable<Ops["arrange"]>) => {
    const ALIGN = ["left", "center", "right", "top", "middle", "bottom"];
    if (req.align !== undefined && !ALIGN.includes(req.align)) {
      throw new OpsError(`"align" must be one of ${ALIGN.join(", ")}.`);
    }
    if (
      req.distribute !== undefined &&
      req.distribute !== "horizontal" &&
      req.distribute !== "vertical"
    ) {
      throw new OpsError('"distribute" must be "horizontal" or "vertical".');
    }
    if (!req.align && !req.distribute) {
      throw new OpsError(
        'Say how to arrange them: "align", "distribute", or both.',
      );
    }
    const units = (req.ids || [])
      .map((id) => {
        const members = resolveIds(id);
        if (!members.length) {
          warnings.push(`No element or group with id ${id} (skipped).`);
        }
        return members;
      })
      .filter((unit) => unit.length);
    if (!units.length) {
      throw new OpsError("None of those ids is on this board.");
    }
    const boundsOf = (unit: readonly ExcalidrawElement[]) =>
      getCommonBounds(unit, scene.getNonDeletedElementsMap());
    let ref = boundsOf(units.flat());
    if (req.to === "frame") {
      const frameIds = new Set(units.flat().map((el) => el.frameId));
      const frame =
        frameIds.size === 1 ? live([...frameIds][0] || "") : undefined;
      if (!frame) {
        throw new OpsError(
          'To arrange them in their frame ("to": "frame"), they must all be in the same frame.',
        );
      }
      ref = [
        frame.x,
        frame.y,
        frame.x + frame.width,
        frame.y + frame.height,
      ] as typeof ref;
    }
    const shift = (
      unit: readonly ExcalidrawElement[],
      dx: number,
      dy: number,
    ) => {
      const moved = new Set<string>();
      for (const el of unit) {
        moveBy(el, dx, dy, moved);
      }
    };

    if (req.align) {
      for (const unit of units) {
        const [x1, y1, x2, y2] = boundsOf(unit);
        const dx =
          req.align === "left"
            ? ref[0] - x1
            : req.align === "right"
            ? ref[2] - x2
            : req.align === "center"
            ? (ref[0] + ref[2]) / 2 - (x1 + x2) / 2
            : 0;
        const dy =
          req.align === "top"
            ? ref[1] - y1
            : req.align === "bottom"
            ? ref[3] - y2
            : req.align === "middle"
            ? (ref[1] + ref[3]) / 2 - (y1 + y2) / 2
            : 0;
        shift(unit, dx, dy);
      }
    }

    if (req.distribute) {
      const horizontal = req.distribute === "horizontal";
      const [lo, hi] = horizontal ? [0, 2] : [1, 3];
      const boxes = units
        .map((unit) => ({ unit, box: boundsOf(unit) }))
        .sort((a, b) => a.box[lo] - b.box[lo]);
      const n = boxes.length;
      const sizes = boxes.map(({ box }) => box[hi] - box[lo]);
      const total = sizes.reduce((a, b) => a + b, 0);
      const first = boxes[0].box[lo];
      const last = Math.max(...boxes.map(({ box }) => box[hi]));
      const inFrame = req.to === "frame";
      let gap: number;
      let pos: number;
      if (req.gap !== undefined) {
        gap = Number(req.gap) || 0;
        // in a frame, the row is centered in it
        pos = inFrame
          ? (ref[lo] + ref[hi]) / 2 - (total + gap * (n - 1)) / 2
          : first;
      } else if (inFrame) {
        gap = (ref[hi] - ref[lo] - total) / (n + 1);
        pos = ref[lo] + gap;
      } else {
        gap = n > 1 ? (last - first - total) / (n - 1) : 0;
        pos = first;
      }
      for (let i = 0; i < n; i++) {
        const d = pos - boxes[i].box[lo];
        shift(boxes[i].unit, horizontal ? d : 0, horizontal ? 0 : d);
        pos += sizes[i] + gap;
      }
    }
  };

  // text styles, fixed widths and stacking asked for with the new elements
  for (const [id, extra] of textExtras) {
    const owner = scene.getElement(id);
    if (!owner) {
      continue;
    }
    const text = extra.label
      ? getBoundTextElement(owner, scene.getNonDeletedElementsMap())
      : owner;
    if (!text || !isTextElement(text)) {
      continue;
    }
    const changes: Json = {};
    const styles = applyTextStyleProps(
      text.textStyles,
      text.originalText,
      extra.props,
      warnings,
    );
    if (styles) {
      changes.textStyles = styles;
    }
    if (!extra.label && extra.props.width > 0) {
      Object.assign(changes, {
        autoResize: false,
        width: extra.props.width,
        x: extra.x ?? text.x,
      });
    }
    if (Object.keys(changes).length) {
      Object.assign(text, changes);
      const container = extra.label ? owner : null;
      redrawTextBoundingBox(text, container, scene);
    }
  }
  for (const el of newElements) {
    // labels are in their containers' groups
    if (isTextElement(el) && el.containerId) {
      const container = scene.getElement(el.containerId);
      if (container?.groupIds.length) {
        Object.assign(el, { groupIds: [...container.groupIds] });
      }
    }
  }
  for (const req of zRequests) {
    restack(req);
  }
  // created elements were reported as such, not as changed
  for (const el of newElements) {
    updated.delete(el.id);
  }

  // --- update ---------------------------------------------------------------
  // A group's id stands for its elements: styles go to each of them, x/y
  // move the group as a whole (its top-left corner goes there).
  const elementUpdates: Json[] = [];
  const groupMoves: { id: string; x?: number; y?: number }[] = [];
  const updateZ: {
    ids: string[];
    z?: string;
    above?: string;
    below?: string;
  }[] = [];
  for (const u of updates) {
    const members =
      typeof u.id === "string" && !live(u.id) ? groupMembers(u.id) : [];
    if (!members.length) {
      elementUpdates.push(u);
      continue;
    }
    const { id, x, y, width, height, z, above, below, ...rest } = u;
    if (width !== undefined || height !== undefined) {
      warnings.push(
        `${id} is a group: its size can't be set (width/height skipped); resize its elements.`,
      );
    }
    // the group's own grouping: null ungroups it (its elements stay in the
    // groups inside it), a group id puts it inside that group
    let regroup: ((m: ExcalidrawElement) => string[]) | null = null;
    if ("group" in rest) {
      const into = toGroupIds(rest.group);
      regroup = (m) => [
        ...m.groupIds.slice(0, m.groupIds.indexOf(id) + (into.length ? 1 : 0)),
        ...into,
      ];
      delete rest.group;
    }
    if (Object.keys(rest).length || regroup) {
      elementUpdates.push(
        ...members.map((m) => ({
          ...rest,
          id: m.id,
          ...(regroup ? { groupIds: regroup(m) } : {}),
        })),
      );
    }
    if (x !== undefined || y !== undefined) {
      groupMoves.push({ id, x, y });
    }
    if (z !== undefined || above !== undefined || below !== undefined) {
      updateZ.push({ ids: members.map((m) => m.id), z, above, below });
    }
  }

  for (const u of elementUpdates) {
    const el = typeof u.id === "string" ? live(u.id) : undefined;
    if (!el) {
      warnings.push(`No element or group with id ${u.id} (skipped).`);
      continue;
    }
    const changes: Json = {
      ...pick(u, STYLE_PROPS),
      ...pick(u, GEOMETRY_PROPS),
    };
    if (u.roundness !== undefined) {
      changes.roundness = toRoundness(u.roundness, el.type);
    }
    if (u.cornerRadius !== undefined) {
      changes.roundness = cornerRoundness(u.cornerRadius);
    }
    if (u.group !== undefined) {
      changes.groupIds = toGroupIds(u.group);
    } else if (Array.isArray(u.groupIds)) {
      changes.groupIds = u.groupIds; // from a group's update, above
    }
    if (isTextElement(el) && !el.containerId) {
      // a width makes it a box its text wraps in; autoResize: true undoes that
      if (u.width !== undefined) {
        changes.autoResize = false;
      }
      if (u.autoResize === true || u.autoResize === false) {
        changes.autoResize = u.autoResize;
      }
    }
    if (u.z !== undefined || u.above !== undefined || u.below !== undefined) {
      updateZ.push({ ids: [el.id], ...pick(u, ["z", "above", "below"]) });
    }
    if ("frame" in u) {
      const target = u.frame ? live(u.frame) : null;
      if (u.frame && (!target || !isFrameLikeElement(target))) {
        warnings.push(
          `No frame with id ${u.frame}; ${el.id} stays where it is.`,
        );
      } else {
        changes.frameId = target ? target.id : null;
      }
    }
    // x/y are relative to the frame the element is (or goes) in
    const inFrame = live(
      ("frameId" in changes ? changes.frameId : el.frameId) || "",
    );
    if (inFrame) {
      if (changes.x !== undefined) {
        changes.x = Number(changes.x) + inFrame.x;
      }
      if (changes.y !== undefined) {
        changes.y = Number(changes.y) + inFrame.y;
      }
    }
    if (isFrameLikeElement(el) && u.name !== undefined) {
      changes.name = u.name;
    }
    if (isLinearElement(el)) {
      Object.assign(changes, pick(u, LINEAR_PROPS));
    }
    const textChanges: Json = pick(u, TEXT_PROPS);
    if (isTextElement(el) && typeof u.text === "string") {
      textChanges.text = u.text;
      textChanges.originalText = u.text;
    } else if (isTextElement(el) && changes.autoResize === true) {
      textChanges.text = el.originalText; // unwrapped again
    }

    // bold/italic/underline: kept on the characters they were on when the
    // text changes, then whatever is asked for
    const restyle = (
      t: ExcalidrawTextElement,
      prev: { text: string; styles?: readonly TextStyleRange[] },
    ) => {
      let styles =
        prev.text !== t.originalText
          ? remapTextStyles(prev.styles, prev.text, t.originalText)
          : prev.styles && [...prev.styles];
      if (hasTextStyleProps(u)) {
        styles = applyTextStyleProps(styles, t.originalText, u, warnings);
      }
      if (JSON.stringify(styles) !== JSON.stringify(t.textStyles)) {
        mutate(t, { textStyles: styles });
      }
    };

    const dx = changes.x !== undefined ? changes.x - el.x : 0;
    const dy = changes.y !== undefined ? changes.y - el.y : 0;
    const prevText = isTextElement(el)
      ? { text: el.originalText, styles: el.textStyles }
      : null;
    mutate(el, isTextElement(el) ? { ...changes, ...textChanges } : changes);
    if (isTextElement(el)) {
      restyle(el, prevText!);
    }

    // a container's label: change it, or add one
    let label = getBoundTextElement(
      el,
      scene.getNonDeletedElementsMap(),
    ) as ExcalidrawTextElement | null;
    const labelChanges: Json = isTextElement(el) ? {} : { ...textChanges };
    if (!isTextElement(el) && typeof u.label === "string") {
      if (label) {
        labelChanges.text = u.label;
        labelChanges.originalText = u.label;
      } else if (u.label) {
        label = newTextElement({
          text: u.label,
          x: el.x,
          y: el.y,
          containerId: el.id,
          textAlign: "center",
          verticalAlign: "middle",
          strokeColor: el.strokeColor,
          frameId: el.frameId,
          ...pick(u, TEXT_PROPS),
        } as any);
        scene.insertElement(label);
        byId.set(label.id, label as OrderedExcalidrawElement);
        mutate(el, {
          boundElements: [
            ...(el.boundElements || []),
            { type: "text", id: label.id },
          ],
        });
      }
    }
    if (label) {
      if (u.label === "") {
        mutate(label, { isDeleted: true });
        mutate(el, {
          boundElements: (el.boundElements || []).filter(
            (b) => b.id !== label!.id,
          ),
        });
      } else {
        if ("frameId" in changes) {
          labelChanges.frameId = changes.frameId;
        }
        if ("groupIds" in changes) {
          labelChanges.groupIds = changes.groupIds;
        }
        const prevLabel = {
          text: label.originalText,
          styles: label.textStyles,
        };
        if (Object.keys(labelChanges).length) {
          mutate(label, labelChanges);
        }
        restyle(label, prevLabel);
        redrawTextBoundingBox(label, el, scene);
      }
    } else if (isTextElement(el)) {
      const container = isBoundToContainer(el)
        ? byId.get(el.containerId) || null
        : null;
      redrawTextBoundingBox(el, container, scene);
    }

    // a frame takes its contents along
    if (isFrameLikeElement(el) && (dx || dy)) {
      for (const child of scene.getNonDeletedElements()) {
        if (child.frameId === el.id) {
          mutate(child, { x: child.x + dx, y: child.y + dy });
          updated.add(child.id);
        }
      }
    }
    if (isBindableElement(el)) {
      updateBoundElements(el as any, scene);
    }
    updated.add(el.id);
  }

  // x/y of a group: where its top-left corner goes, relative to the frame
  // its elements are in
  for (const move of groupMoves) {
    const members = groupMembers(move.id);
    const [x1, y1] = getCommonBounds(members, scene.getNonDeletedElementsMap());
    const frameIds = new Set(members.map((m) => m.frameId));
    const inFrame =
      frameIds.size === 1 ? live([...frameIds][0] || "") : undefined;
    const dx =
      move.x !== undefined
        ? Number(move.x) + (inFrame ? inFrame.x : 0) - x1
        : 0;
    const dy =
      move.y !== undefined
        ? Number(move.y) + (inFrame ? inFrame.y : 0) - y1
        : 0;
    const moved = new Set<string>();
    for (const m of members) {
      moveBy(m, dx, dy, moved);
    }
  }
  for (const req of updateZ) {
    restack(req);
  }

  // --- arrange ----------------------------------------------------------------
  if (ops.arrange) {
    arrange(ops.arrange);
  }

  // --- delete ---------------------------------------------------------------
  const toDelete: ExcalidrawElement[] = [];
  // labels of deleted containers (unbinding them clears their containerId)
  const labelIds = new Set<string>();
  // a group's id deletes its elements
  const queue = (ops.delete || []).flatMap((id) => {
    const members = live(id) ? [] : groupMembers(id);
    return members.length ? members.map((m) => m.id) : [id];
  });
  while (queue.length) {
    const id = queue.shift()!;
    const el = live(id);
    if (!el) {
      if (!deleted.has(id)) {
        warnings.push(`No element or group with id ${id} (skipped).`);
      }
      continue;
    }
    if (deleted.has(id)) {
      continue;
    }
    deleted.add(id);
    toDelete.push(el);
    for (const b of el.boundElements || []) {
      if (b.type === "text") {
        labelIds.add(b.id);
        queue.push(b.id);
      }
    }
    if (isFrameLikeElement(el)) {
      for (const child of scene.getNonDeletedElements()) {
        if (child.frameId === el.id) {
          queue.push(child.id);
        }
      }
    }
  }
  if (toDelete.length) {
    fixBindingsAfterDeletion(scene.getNonDeletedElements(), toDelete);
    for (const el of toDelete) {
      mutate(el, { isDeleted: true });
    }
  }

  const changed = scene
    .getElementsIncludingDeleted()
    .filter((el) => before.get(el.id) !== `${el.version}:${el.versionNonce}`);

  // bound labels are reported with their containers
  const isLabel = (id: string) => {
    const el = byId.get(id);
    return labelIds.has(id) || (!!el && isTextElement(el) && !!el.containerId);
  };
  return {
    ok: true,
    changed: changed.map((el) => ({ ...el })),
    created,
    updated: [...updated].filter((id) => !isLabel(id)),
    deleted: [...deleted].filter((id) => !isLabel(id)),
    warnings,
  };
};

window.__whiteboardOps = (board, ops) =>
  runOps(board, ops).catch(
    (error): OpsResult => ({
      ok: false,
      error:
        error instanceof OpsError
          ? error.message
          : `couldn't apply the edit: ${
              error instanceof Error ? error.message : String(error)
            }`,
    }),
  );
window.__whiteboardOpsReady = true;
document.getElementById("status")!.textContent = "Ready.";
