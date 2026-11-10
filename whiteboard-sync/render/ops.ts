// Headless edit page for the Claude connector (whiteboard-sync/mcp/render.js).
// The connector loads /render/ops.html in headless Chromium and calls
//
//   window.__whiteboardOps({ elements }, { add, update, delete })
//
// with the board's elements and Claude's edits. It answers with the elements
// that changed (new ones included), built with Excalidraw's own code, so
// text is measured with the real fonts, labels sit in their containers and
// arrows are bound to what they point at. It never saves anything: the
// connector merges the result into the board (whiteboard-sync/scene.js).
import {
  convertToExcalidrawElements,
  fixBindingsAfterDeletion,
  getBoundTextElement,
  isBindableElement,
  isBoundToContainer,
  isFrameLikeElement,
  isLinearElement,
  isTextElement,
  newTextElement,
  redrawTextBoundingBox,
  Scene,
  syncInvalidIndices,
  updateBoundElements,
} from "@excalidraw/element";
import { DEFAULT_FONT_FAMILY, randomId } from "@excalidraw/common";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { setGoogleFontsConfig } from "@excalidraw/excalidraw/fonts/GoogleFonts";
import { Fonts } from "@excalidraw/excalidraw/fonts";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  FontFamilyValues,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

type Json = Record<string, any>;

type Ops = {
  add?: { elements: Json[]; frame?: string | null };
  update?: Json[];
  delete?: string[];
};

type OpsResult =
  | {
      ok: true;
      changed: ExcalidrawElement[];
      created: { id: string; type: string; text?: string }[];
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

// Boards can use Google Fonts, which the editor turns on (excalidraw-app
// App.tsx); without this, that text falls back to a default font.
setGoogleFontsConfig({
  cssBaseUrl:
    import.meta.env.VITE_APP_GOOGLE_FONTS_CSS_URL ||
    "https://fonts.googleapis.com",
});

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

  const skeletons = (ops.add?.elements || []).map((s) => ({ ...s }));
  const updates = ops.update || [];
  await Fonts.loadElementsFonts(textsToMeasure(skeletons, updates, byId));

  const created: { id: string; type: string; text?: string }[] = [];
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

  // --- update ---------------------------------------------------------------
  for (const u of updates) {
    const el = typeof u.id === "string" ? live(u.id) : undefined;
    if (!el) {
      warnings.push(`No element with id ${u.id} (skipped).`);
      continue;
    }
    const changes: Json = {
      ...pick(u, STYLE_PROPS),
      ...pick(u, GEOMETRY_PROPS),
    };
    if (u.roundness !== undefined) {
      changes.roundness = toRoundness(u.roundness, el.type);
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
    }

    const dx = changes.x !== undefined ? changes.x - el.x : 0;
    const dy = changes.y !== undefined ? changes.y - el.y : 0;
    mutate(el, isTextElement(el) ? { ...changes, ...textChanges } : changes);

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
        if (Object.keys(labelChanges).length) {
          mutate(label, labelChanges);
        }
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

  // --- delete ---------------------------------------------------------------
  const toDelete: ExcalidrawElement[] = [];
  // labels of deleted containers (unbinding them clears their containerId)
  const labelIds = new Set<string>();
  const queue = [...(ops.delete || [])];
  while (queue.length) {
    const id = queue.shift()!;
    const el = live(id);
    if (!el) {
      if (!deleted.has(id)) {
        warnings.push(`No element with id ${id} (skipped).`);
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
