import { arrayToMap, type Bounds } from "@excalidraw/common";
import {
  isPointWithinBounds,
  pointFrom,
  PRECISION,
  segmentsIntersectAt,
} from "@excalidraw/math";

import type {
  AppClassProperties,
  AppState,
  StaticCanvasAppState,
} from "@excalidraw/excalidraw/types";

import type { ReadonlySetLike } from "@excalidraw/common/utility-types";

import {
  getSelectedElements,
  shouldIgnoreElementFromSelection,
} from "./selection";
import { getElementsInGroup, selectGroupsFromGivenElements } from "./groups";

import {
  getElementLineSegments,
  getCommonBounds,
  getElementAbsoluteCoords,
  doBoundsIntersect,
  getElementBounds,
  boundsContainBounds,
  elementsOverlappingBBox,
} from "./bounds";
import { mutateElement } from "./mutateElement";
import { getBoundTextElement, getContainerElement } from "./textElement";
import { syncMovedIndices } from "./fractionalIndex";
import { LinearElementEditor } from "./linearElementEditor";
import {
  isArrowElement,
  isFrameElement,
  isFrameLikeElement,
  isTextElement,
} from "./typeChecks";

import { getNonDeletedElements } from ".";

import type { ExcalidrawElementsIncludingDeleted } from "./Scene";

import type {
  ElementsMap,
  ElementsMapOrArray,
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "./types";

// --------------------------- Frame Hierarchy --------------------------------
//
// Frames nest: a frame-like element may itself have a `frameId` pointing to
// its parent frame. The hierarchy is the `frameId` chain. Helpers below are
// cycle-safe (a corrupted chain is cut where it loops).
//
// Z-order of a frame F's block (contiguous in the elements array):
//
//   [F's non-frame children…, child frame Q1's block, Q2's block, …, F]
//
// i.e. inside a frame, plain content is the bottom layer and child frames
// (with everything in them) the top layer, so child frames are always shown
// above their parent's content.

/**
 * Frame-likes containing the element, innermost (its parent) first.
 */
export const getFrameAncestors = (
  element: ExcalidrawElement,
  elementsMap: ElementsMap,
): ExcalidrawFrameLikeElement[] => {
  const ancestors: ExcalidrawFrameLikeElement[] = [];
  const visited = new Set<string>([element.id]);
  let frameId = element.frameId;
  while (frameId && !visited.has(frameId)) {
    visited.add(frameId);
    const frame = elementsMap.get(frameId);
    if (!frame || !isFrameLikeElement(frame)) {
      break;
    }
    ancestors.push(frame);
    frameId = frame.frameId;
  }
  return ancestors;
};

/** Whether the element is (transitively) inside the given frame. */
export const isFrameDescendantOf = (
  element: ExcalidrawElement,
  frameId: ExcalidrawFrameLikeElement["id"],
  elementsMap: ElementsMap,
) => {
  if (!element.frameId || element.id === frameId) {
    return false;
  }
  if (element.frameId === frameId) {
    return true;
  }
  return getFrameAncestors(element, elementsMap).some(
    (frame) => frame.id === frameId,
  );
};

/** The outermost frame containing the element (or the element itself). */
export const getRootFrame = (
  element: ExcalidrawElement,
  elementsMap: ElementsMap,
): ExcalidrawFrameLikeElement | null => {
  const ancestors = getFrameAncestors(element, elementsMap);
  return (
    ancestors[ancestors.length - 1] ??
    (isFrameLikeElement(element) ? element : null)
  );
};

/**
 * Ids of the given frames and of all frames nested in them, at any depth.
 */
export const getFrameSubtreeIds = (
  allElements: ElementsMapOrArray,
  frameIds: Iterable<ExcalidrawFrameLikeElement["id"]>,
) => {
  const childFramesByParent = new Map<string, string[]>();
  for (const element of allElements.values()) {
    if (isFrameLikeElement(element) && element.frameId) {
      const children = childFramesByParent.get(element.frameId) || [];
      children.push(element.id);
      childFramesByParent.set(element.frameId, children);
    }
  }
  const subtreeIds = new Set<string>();
  const queue = Array.from(frameIds);
  while (queue.length) {
    const frameId = queue.pop()!;
    if (subtreeIds.has(frameId)) {
      continue;
    }
    subtreeIds.add(frameId);
    queue.push(...(childFramesByParent.get(frameId) || []));
  }
  return subtreeIds;
};

/**
 * All elements (transitively) inside the frame, nested frames included, in
 * the order of `allElements`. Includes deleted elements, as
 * `getFrameChildren()` does.
 */
export const getFrameDescendants = (
  allElements: ElementsMapOrArray,
  frameId: ExcalidrawFrameLikeElement["id"],
) => {
  const subtreeIds = getFrameSubtreeIds(allElements, [frameId]);
  const descendants: ExcalidrawElement[] = [];
  for (const element of allElements.values()) {
    if (
      element.frameId &&
      element.id !== frameId &&
      subtreeIds.has(element.frameId)
    ) {
      descendants.push(element);
    }
  }
  return descendants;
};

/**
 * Whether any of the element's ancestor frames is in the given set (a `Set`
 * or an id → truthy record such as `appState.selectedElementIds`).
 */
export const hasFrameAncestorIn = (
  element: ExcalidrawElement,
  frameIds:
    | ReadonlySet<string>
    | ReadonlyMap<string, unknown>
    | Readonly<Record<string, unknown>>,
  elementsMap: ElementsMap,
) => {
  if (!element.frameId) {
    return false;
  }
  const has =
    typeof (frameIds as ReadonlySet<string>).has === "function"
      ? (id: string) => (frameIds as ReadonlySet<string>).has(id)
      : (id: string) => !!(frameIds as Readonly<Record<string, unknown>>)[id];
  if (has(element.frameId)) {
    return true;
  }
  return getFrameAncestors(element, elementsMap).some((frame) => has(frame.id));
};

/**
 * Whether frame `a` is shown above frame `b`: a frame is above the frames
 * containing it, and otherwise ordered as the blocks of the frames containing
 * them that are siblings (a frame closes its block, so its index orders it).
 *
 * @param getIndex the frames' (and their ancestors') z-index
 */
export const isFrameAbove = (
  a: ExcalidrawFrameLikeElement,
  b: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
  getIndex: (element: ExcalidrawElement) => number,
) => {
  const chainA = [a, ...getFrameAncestors(a, elementsMap)];
  const chainB = [b, ...getFrameAncestors(b, elementsMap)];
  if (chainA.includes(b)) {
    return true;
  }
  if (chainB.includes(a)) {
    return false;
  }
  const idsB = new Set(chainB.map((frame) => frame.id));
  // the frames under their closest common ancestor (or at the top level)
  const commonIndexA = chainA.findIndex((frame) => idsB.has(frame.id));
  const siblingA =
    commonIndexA === -1 ? chainA[chainA.length - 1] : chainA[commonIndexA - 1];
  const common = commonIndexA === -1 ? null : chainA[commonIndexA];
  const commonIndexB = common
    ? chainB.findIndex((frame) => frame.id === common.id)
    : chainB.length;
  const siblingB = chainB[commonIndexB - 1];
  return getIndex(siblingA) > getIndex(siblingB);
};

/**
 * Re-emits every frame tree that has nested frames in its normalized order
 * (see top of this section), anchored at its root frame's position. Flat
 * frames are left as they are. Returns the same array if nothing moves.
 */
export const normalizeNestedFrameOrder = <T extends ExcalidrawElement>(
  elements: readonly T[],
): readonly T[] => {
  const elementsMap = arrayToMap(elements);

  const childrenByFrame = new Map<string, T[]>();
  let hasNesting = false;
  for (const element of elements) {
    if (!element.frameId) {
      continue;
    }
    const frame = elementsMap.get(element.frameId);
    if (!frame || !isFrameLikeElement(frame)) {
      continue;
    }
    if (isFrameLikeElement(element)) {
      hasNesting = true;
    }
    const children = childrenByFrame.get(element.frameId) || [];
    children.push(element);
    childrenByFrame.set(element.frameId, children);
  }

  if (!hasNesting) {
    return elements;
  }

  const emitted = new Set<string>();
  const emitBlock = (frame: T, out: T[]) => {
    if (emitted.has(frame.id)) {
      return;
    }
    emitted.add(frame.id);
    const children = childrenByFrame.get(frame.id) || [];
    for (const child of children) {
      if (!isFrameLikeElement(child) && !emitted.has(child.id)) {
        emitted.add(child.id);
        out.push(child);
      }
    }
    for (const child of children) {
      if (isFrameLikeElement(child)) {
        emitBlock(child, out);
      }
    }
    out.push(frame);
  };

  const treesWithNesting = new Set<string>();
  for (const element of elements) {
    if (isFrameLikeElement(element) && element.frameId) {
      const root = getRootFrame(element, elementsMap);
      if (root) {
        treesWithNesting.add(root.id);
      }
    }
  }

  const nextElements: T[] = [];
  const isInNestedTree = (element: T) => {
    const root = getRootFrame(element, elementsMap);
    return !!root && treesWithNesting.has(root.id);
  };

  for (const element of elements) {
    if (emitted.has(element.id)) {
      continue;
    }
    if (treesWithNesting.has(element.id)) {
      emitBlock(element, nextElements);
    } else if (!isInNestedTree(element)) {
      nextElements.push(element);
    }
    // else: emitted with its root frame
  }

  // elements of a tree whose frames chain is broken (shouldn't happen)
  for (const element of elements) {
    if (!emitted.has(element.id) && isInNestedTree(element)) {
      nextElements.push(element);
    }
  }

  if (nextElements.every((element, index) => element === elements[index])) {
    return elements;
  }

  const movedElements = new Map<string, ExcalidrawElement>();
  nextElements.forEach((element, index) => {
    if (element !== elements[index]) {
      movedElements.set(element.id, element);
    }
  });
  syncMovedIndices(nextElements, movedElements);

  return nextElements;
};

// --------------------------- Frame State ------------------------------------
export const bindElementsToFramesAfterDuplication = (
  nextElements: readonly ExcalidrawElement[],
  origElements: readonly ExcalidrawElement[],
  origIdToDuplicateId: Map<ExcalidrawElement["id"], ExcalidrawElement["id"]>,
) => {
  const nextElementMap = arrayToMap(nextElements) as Map<
    ExcalidrawElement["id"],
    ExcalidrawElement
  >;

  for (const element of origElements) {
    if (element.frameId) {
      // use its frameId to get the new frameId
      const nextElementId = origIdToDuplicateId.get(element.id);
      const nextFrameId = origIdToDuplicateId.get(element.frameId);
      const nextElement = nextElementId && nextElementMap.get(nextElementId);
      if (nextElement) {
        mutateElement(nextElement, nextElementMap, {
          frameId: nextFrameId ?? null,
        });
      }
    }
  }
};

export function isElementIntersectingFrame(
  element: ExcalidrawElement,
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
) {
  const frameLineSegments = getElementLineSegments(frame, elementsMap);

  const elementLineSegments = getElementLineSegments(element, elementsMap);

  const intersecting = frameLineSegments.some((frameLineSegment) =>
    elementLineSegments.some((elementLineSegment) =>
      segmentsIntersectAt(frameLineSegment, elementLineSegment),
    ),
  );

  return intersecting;
}

/**
 * What's in the frame: to a hair beyond its edges, which snapping it to an
 * element's (or an element to its) leaves the element at.
 */
const getFrameInnerBounds = (
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
): Bounds => {
  const [x1, y1, x2, y2] = getElementBounds(frame, elementsMap);
  return [x1 - PRECISION, y1 - PRECISION, x2 + PRECISION, y2 + PRECISION];
};

export const getElementsCompletelyInFrame = (
  elements: readonly ExcalidrawElement[],
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
) =>
  omitGroupsContainingFrameLikes(
    // by their outlines (as the frame's other bounds checks), so that a frame
    // snapped to an element's edges contains it
    elementsOverlappingBBox({
      elements,
      elementsMap,
      bounds: getFrameInnerBounds(frame, elementsMap),
      type: "contain",
      shouldIgnoreElementFromSelection,
      includeStroke: false,
    }),
  ).filter(
    (element) =>
      element.id !== frame.id &&
      // its siblings (at the frame's level), or already its children
      ((element.frameId ?? null) === (frame.frameId ?? null) ||
        element.frameId === frame.id) &&
      // not a frame containing it (cycle)
      !isFrameDescendantOf(frame, element.id, elementsMap),
  );

export const isElementContainingFrame = (
  element: ExcalidrawElement,
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
) => {
  return boundsContainBounds(
    getElementBounds(element, elementsMap),
    getElementBounds(frame, elementsMap),
  );
};

export const getElementsIntersectingFrame = (
  elements: readonly ExcalidrawElement[],
  frame: ExcalidrawFrameLikeElement,
) => {
  const elementsMap = arrayToMap(elements);
  return elements.filter((element) =>
    isElementIntersectingFrame(element, frame, elementsMap),
  );
};

export const elementsAreInFrameBounds = (
  elements: readonly ExcalidrawElement[],
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
) => {
  const [frameX1, frameY1, frameX2, frameY2] = getFrameInnerBounds(
    frame,
    elementsMap,
  );

  const [elementX1, elementY1, elementX2, elementY2] =
    getCommonBounds(elements);

  return (
    frameX1 <= elementX1 &&
    frameY1 <= elementY1 &&
    frameX2 >= elementX2 &&
    frameY2 >= elementY2
  );
};

export const elementOverlapsWithFrame = (
  element: ExcalidrawElement,
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
) => {
  return (
    elementsAreInFrameBounds([element], frame, elementsMap) ||
    isElementIntersectingFrame(element, frame, elementsMap) ||
    isElementContainingFrame(element, frame, elementsMap)
  );
};

export const isCursorInFrame = (
  cursorCoords: {
    x: number;
    y: number;
  },
  frame: NonDeleted<ExcalidrawFrameLikeElement>,
  elementsMap: ElementsMap,
) => {
  const [fx1, fy1, fx2, fy2] = getElementAbsoluteCoords(frame, elementsMap);

  return isPointWithinBounds(
    pointFrom(fx1, fy1),
    pointFrom(cursorCoords.x, cursorCoords.y),
    pointFrom(fx2, fy2),
  );
};

export const groupsAreAtLeastIntersectingTheFrame = (
  elements: readonly NonDeletedExcalidrawElement[],
  groupIds: readonly string[],
  frame: ExcalidrawFrameLikeElement,
) => {
  const elementsMap = arrayToMap(elements);
  const elementsInGroup = groupIds.flatMap((groupId) =>
    getElementsInGroup(elements, groupId),
  );

  if (elementsInGroup.length === 0) {
    return true;
  }

  return !!elementsInGroup.find(
    (element) =>
      elementsAreInFrameBounds([element], frame, elementsMap) ||
      isElementIntersectingFrame(element, frame, elementsMap),
  );
};

export const groupsAreCompletelyOutOfFrame = (
  elements: readonly NonDeletedExcalidrawElement[],
  groupIds: readonly string[],
  frame: ExcalidrawFrameLikeElement,
) => {
  const elementsMap = arrayToMap(elements);
  const elementsInGroup = groupIds.flatMap((groupId) =>
    getElementsInGroup(elements, groupId),
  );

  if (elementsInGroup.length === 0) {
    return true;
  }

  return (
    elementsInGroup.find(
      (element) =>
        elementsAreInFrameBounds([element], frame, elementsMap) ||
        isElementIntersectingFrame(element, frame, elementsMap),
    ) === undefined
  );
};

// --------------------------- Frame Utils ------------------------------------

/**
 * Returns a map of frameId to frame elements. Includes empty frames.
 */
export const groupByFrameLikes = (elements: readonly ExcalidrawElement[]) => {
  const frameElementsMap = new Map<
    ExcalidrawElement["id"],
    ExcalidrawElement[]
  >();

  for (const element of elements) {
    const frameId = isFrameLikeElement(element) ? element.id : element.frameId;
    if (frameId && !frameElementsMap.has(frameId)) {
      frameElementsMap.set(frameId, getFrameChildren(elements, frameId));
    }
  }

  return frameElementsMap;
};

export const getFrameChildren = (
  allElements: ElementsMapOrArray,
  frameId: string,
) => {
  const frameChildren: ExcalidrawElement[] = [];
  for (const element of allElements.values()) {
    if (element.frameId === frameId) {
      frameChildren.push(element);
    }
  }
  return frameChildren;
};

export const getFrameLikeElements = (
  allElements: ExcalidrawElementsIncludingDeleted,
): ExcalidrawFrameLikeElement[] => {
  return allElements.filter((element): element is ExcalidrawFrameLikeElement =>
    isFrameLikeElement(element),
  );
};

/**
 * Returns ExcalidrawFrameElements and non-frame-children elements.
 *
 * Considers children as root elements if they point to a frame parent
 * non-existing in the elements set.
 *
 * Considers non-frame bound elements (container or arrow labels) as root.
 */
export const getRootElements = <T extends ExcalidrawElement>(
  allElements: readonly T[],
) => {
  const frameElements = arrayToMap(getFrameLikeElements(allElements));
  return allElements.filter(
    (element) =>
      !element.frameId ||
      // in no frame of the set, at any depth
      !hasFrameAncestorIn(element, frameElements, frameElements),
  );
};

export const getElementsInResizingFrame = (
  allElements: ExcalidrawElementsIncludingDeleted,
  frame: ExcalidrawFrameLikeElement,
  appState: AppState,
  elementsMap: ElementsMap,
): ExcalidrawElement[] => {
  const prevElementsInFrame = getFrameChildren(allElements, frame.id);
  const nextElementsInFrame = new Set<ExcalidrawElement>(prevElementsInFrame);

  const elementsCompletelyInFrame = new Set([
    ...getElementsCompletelyInFrame(allElements, frame, elementsMap),
    ...prevElementsInFrame.filter((element) =>
      isElementContainingFrame(element, frame, elementsMap),
    ),
  ]);

  const elementsNotCompletelyInFrame = prevElementsInFrame.filter(
    (element) => !elementsCompletelyInFrame.has(element),
  );

  // for elements that are completely in the frame
  // if they are part of some groups, then those groups are still
  // considered to belong to the frame
  const groupsToKeep = new Set<string>(
    Array.from(elementsCompletelyInFrame).flatMap(
      (element) => element.groupIds,
    ),
  );

  for (const element of elementsNotCompletelyInFrame) {
    if (!isElementIntersectingFrame(element, frame, elementsMap)) {
      if (element.groupIds.length === 0) {
        nextElementsInFrame.delete(element);
      }
    } else if (element.groupIds.length > 0) {
      // group element intersects with the frame, we should keep the groups
      // that this element is part of
      for (const id of element.groupIds) {
        groupsToKeep.add(id);
      }
    }
  }

  for (const element of elementsNotCompletelyInFrame) {
    if (element.groupIds.length > 0) {
      let shouldRemoveElement = true;

      for (const id of element.groupIds) {
        if (groupsToKeep.has(id)) {
          shouldRemoveElement = false;
        }
      }

      if (shouldRemoveElement) {
        nextElementsInFrame.delete(element);
      }
    }
  }

  const individualElementsCompletelyInFrame = Array.from(
    elementsCompletelyInFrame,
  ).filter((element) => element.groupIds.length === 0);

  for (const element of individualElementsCompletelyInFrame) {
    nextElementsInFrame.add(element);
  }

  const newGroupElementsCompletelyInFrame = Array.from(
    elementsCompletelyInFrame,
  ).filter((element) => element.groupIds.length > 0);
  const nonDeletedNewGroupElementsCompletelyInFrame = getNonDeletedElements(
    newGroupElementsCompletelyInFrame,
  );

  const groupIds = selectGroupsFromGivenElements(
    nonDeletedNewGroupElementsCompletelyInFrame,
    appState,
  );

  // new group elements
  for (const [id, isSelected] of Object.entries(groupIds)) {
    if (isSelected) {
      const elementsInGroup = getElementsInGroup(allElements, id);

      if (elementsAreInFrameBounds(elementsInGroup, frame, elementsMap)) {
        for (const element of elementsInGroup) {
          nextElementsInFrame.add(element);
        }
      }
    }
  }

  return [...nextElementsInFrame].filter((element) => {
    return !(isTextElement(element) && element.containerId);
  });
};

export const getElementsInNewFrame = (
  elements: ExcalidrawElementsIncludingDeleted,
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
) => {
  return omitPartialGroups(
    omitGroupsContainingFrameLikes(
      elements,
      getElementsCompletelyInFrame(elements, frame, elementsMap),
    ),
    frame,
    elementsMap,
  );
};

export const omitPartialGroups = (
  elements: ExcalidrawElement[],
  frame: ExcalidrawFrameLikeElement,
  allElementsMap: ElementsMap,
) => {
  const elementsToReturn = [];
  const checkedGroups = new Map<string, boolean>();

  for (const element of elements) {
    let shouldOmit = false;
    if (element.groupIds.length > 0) {
      // if some partial group should be omitted, then all elements in that group should be omitted
      if (element.groupIds.some((gid) => checkedGroups.get(gid))) {
        shouldOmit = true;
      } else {
        const allElementsInGroup = new Set(
          element.groupIds.flatMap((gid) =>
            getElementsInGroup(allElementsMap, gid),
          ),
        );

        shouldOmit = !elementsAreInFrameBounds(
          Array.from(allElementsInGroup),
          frame,
          allElementsMap,
        );
      }

      element.groupIds.forEach((gid) => {
        checkedGroups.set(gid, shouldOmit);
      });
    }

    if (!shouldOmit) {
      elementsToReturn.push(element);
    }
  }

  return elementsToReturn;
};

export const getContainingFrame = (
  element: ExcalidrawElement,
  elementsMap: ElementsMap,
) => {
  if (!element.frameId) {
    return null;
  }
  return (elementsMap.get(element.frameId) ||
    null) as null | ExcalidrawFrameLikeElement;
};

/**
 * Whether frames clip the element to their bounds (as their child, or when
 * dragged into them). Arrows (with their labels) aren't, so that they can
 * connect elements across and out of frames.
 */
export const isFrameClippable = (
  element: ExcalidrawElement,
  elementsMap: ElementsMap,
) => {
  if (isArrowElement(element)) {
    return false;
  }
  if (isTextElement(element) && element.containerId) {
    return !isArrowElement(elementsMap.get(element.containerId));
  }
  return true;
};

// --------------------------- Frame Operations -------------------------------

/** */
export const filterElementsEligibleAsFrameChildren = (
  elements: readonly ExcalidrawElement[],
  frame: ExcalidrawFrameLikeElement,
) => {
  const otherFrames = new Set<ExcalidrawFrameLikeElement["id"]>();
  const elementsMap = arrayToMap(elements);
  elements = omitGroupsContainingFrameLikes(elements);

  for (const element of elements) {
    if (isFrameLikeElement(element) && element.id !== frame.id) {
      otherFrames.add(element.id);
    }
  }

  const processedGroups = new Set<ExcalidrawElement["id"]>();

  const eligibleElements: ExcalidrawElement[] = [];

  for (const element of elements) {
    // elements inside other frames of the set stay in them (the outermost of
    // those frames is what's eligible), and neither the frame itself nor the
    // frames containing it (cycle) are
    if (
      element.id === frame.id ||
      hasFrameAncestorIn(element, otherFrames, elementsMap) ||
      (isFrameLikeElement(element) &&
        isFrameDescendantOf(frame, element.id, elementsMap))
    ) {
      continue;
    }

    if (element.groupIds.length) {
      const shallowestGroupId = element.groupIds.at(-1)!;
      if (!processedGroups.has(shallowestGroupId)) {
        processedGroups.add(shallowestGroupId);
        const groupElements = getElementsInGroup(elements, shallowestGroupId);
        if (
          groupElements.some((el) =>
            elementOverlapsWithFrame(el, frame, elementsMap),
          )
        ) {
          for (const child of groupElements) {
            eligibleElements.push(child);
          }
        }
      }
    } else {
      const overlaps = elementOverlapsWithFrame(element, frame, elementsMap);
      if (overlaps) {
        eligibleElements.push(element);
      }
    }
  }

  return eligibleElements;
};

export const getCommonFrameId = (elements: readonly ExcalidrawElement[]) => {
  let commonFrameId: ExcalidrawElement["frameId"] | undefined;

  for (const element of elements) {
    if (!element.frameId) {
      return null;
    }

    if (commonFrameId === undefined) {
      commonFrameId = element.frameId;
    } else if (commonFrameId !== element.frameId) {
      return null;
    }
  }

  return commonFrameId ?? null;
};

/**
 * Where to insert new children into the frame's block (see the top of
 * "Frame Hierarchy"): frames at the top of its child-frame layer (just below
 * the frame), other elements at the top of its content layer (just below its
 * lowest child frame's block). Falls back to just above the highest
 * (non-deleted) child when the frame's order is denormalized.
 */
export const getFrameChildrenInsertionIndex = (
  elements: readonly ExcalidrawElement[],
  frameId: ExcalidrawFrameLikeElement["id"],
  opts?: { asFrame?: boolean },
): number | null => {
  const childFrameIds = new Set<string>();
  for (const element of elements) {
    if (isFrameLikeElement(element) && element.frameId === frameId) {
      childFrameIds.add(element.id);
    }
  }

  if (childFrameIds.size && !opts?.asFrame) {
    const childFramesSubtreeIds = getFrameSubtreeIds(elements, childFrameIds);
    const frameIndex = elements.findIndex((element) => element.id === frameId);
    const lowestChildFrameBlockIndex = elements.findIndex(
      (element) =>
        childFrameIds.has(element.id) ||
        (!!element.frameId && childFramesSubtreeIds.has(element.frameId)),
    );
    if (frameIndex !== -1 && lowestChildFrameBlockIndex !== -1) {
      return Math.min(frameIndex, lowestChildFrameBlockIndex);
    }
  }

  const subtreeIds = opts?.asFrame
    ? getFrameSubtreeIds(elements, [frameId])
    : new Set([frameId]);

  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index];

    if (element.id === frameId) {
      return index;
    } else if (
      element.frameId &&
      subtreeIds.has(element.frameId) &&
      !element.isDeleted
    ) {
      // deleted children keep their frameId (and index), but don't count:
      // they'd place the new ones as high as they were
      return index + 1;
    }
  }

  return null;
};

/**
 * Reorders `elementsToMove` (already children of `frame`) into the frame's
 * block: frames, with everything inside them, into its child-frame layer,
 * other elements into its content layer. Pure, returns a new array.
 */
export const getElementsReorderedIntoFrame = <T extends ExcalidrawElement>(
  allElements: readonly T[],
  elementsToMove: ReadonlySetLike<ExcalidrawElement>,
  frame: ExcalidrawFrameLikeElement,
): T[] | null => {
  const toMove = new Set(
    Array.from(elementsToMove, (element) => element.id as string),
  );
  const movedFrameIds = new Set<string>();
  for (const element of elementsToMove) {
    if (isFrameLikeElement(element)) {
      movedFrameIds.add(element.id);
    }
  }
  const movedSubtreeIds = getFrameSubtreeIds(allElements, movedFrameIds);
  const isInMovedFrame = (element: ExcalidrawElement) =>
    !!element.frameId && movedSubtreeIds.has(element.frameId);

  const content: T[] = [];
  const frameBlocks: T[] = [];
  const otherElements: T[] = [];
  for (const element of allElements) {
    if (movedSubtreeIds.has(element.id) || isInMovedFrame(element)) {
      frameBlocks.push(element);
    } else if (toMove.has(element.id)) {
      content.push(element);
    } else {
      otherElements.push(element);
    }
  }

  let nextElements = otherElements;
  if (content.length) {
    const index = getFrameChildrenInsertionIndex(nextElements, frame.id);
    if (index === null) {
      return null;
    }
    nextElements = [
      ...nextElements.slice(0, index),
      ...content,
      ...nextElements.slice(index),
    ];
  }
  if (frameBlocks.length) {
    const index = getFrameChildrenInsertionIndex(nextElements, frame.id, {
      asFrame: true,
    });
    if (index === null) {
      return null;
    }
    nextElements = [
      ...nextElements.slice(0, index),
      ...frameBlocks,
      ...nextElements.slice(index),
    ];
  }
  return nextElements;
};

/**
 * Adds elements and their bound elements to frame. Reorders added elements to
 * be just below frame, or just above its highest child (whichever is higher).
 * Frames are added with everything inside them, into the frame's child-frame
 * layer (above its other children).
 *
 * @returns mutated allElements (same data structure)
 */
export const addElementsToFrame = <T extends ElementsMapOrArray>(
  allElements: T,
  elementsToAdd: ExcalidrawElement[],
  frame: ExcalidrawFrameLikeElement,
): T => {
  const elementsMap = arrayToMap(allElements);
  const commonFrameId = getCommonFrameId(elementsToAdd);

  const finalElementsToAdd = new Set<ExcalidrawElement>();

  const otherFrames = new Set<ExcalidrawFrameLikeElement["id"]>();

  for (const element of elementsToAdd) {
    if (isFrameLikeElement(element) && element.id !== frame.id) {
      otherFrames.add(element.id);
    }
  }

  // - add bound text elements if not already in the array
  // - keep elements already in the frame so mixed selections can be reordered
  //   together
  for (const element of omitGroupsContainingFrameLikes(
    allElements,
    elementsToAdd,
  )) {
    if (
      element.id === frame.id ||
      // frames containing the frame (cycle)
      (isFrameLikeElement(element) &&
        isFrameDescendantOf(frame, element.id, elementsMap)) ||
      // elements inside frames being added stay in them
      hasFrameAncestorIn(element, otherFrames, elementsMap)
    ) {
      continue;
    }

    finalElementsToAdd.add(element);

    const boundTextElement = getBoundTextElement(element, elementsMap);
    if (boundTextElement && !finalElementsToAdd.has(boundTextElement)) {
      finalElementsToAdd.add(boundTextElement);
    }
  }

  for (const element of finalElementsToAdd) {
    // we don't always need to update the element if it's already in the frame,
    // but we still need to accumulate in finalElementsToAdd so we potentially
    // reorder them if added together
    if (element.frameId !== frame.id) {
      mutateElement(element, elementsMap, {
        frameId: frame.id,
      });
    }
  }

  // (re)order elements to be just below the frame,
  // or just above the highest child if that is higher
  // (latter case is denormalized order until we migrate)
  // ---------------------------------------------------------------------------

  if (
    !finalElementsToAdd.size ||
    // if all elements to add already belong to the frame, then we don't want to
    // reorder (case: we're dragging element children within the frame)
    commonFrameId === frame.id
  ) {
    return allElements;
  }

  const reorderedElements = getElementsReorderedIntoFrame(
    Array.from(allElements.values()),
    finalElementsToAdd,
    frame,
  );

  if (!reorderedElements) {
    return allElements;
  }

  syncMovedIndices(
    reorderedElements,
    arrayToMap([
      ...finalElementsToAdd,
      ...getFrameDescendants(reorderedElements, frame.id).filter((element) =>
        hasFrameAncestorIn(element, otherFrames, elementsMap),
      ),
    ]),
  );

  return (
    Array.isArray(allElements)
      ? reorderedElements
      : new Map(reorderedElements.map((element) => [element.id, element]))
  ) as T;
};

export const removeElementsFromFrame = (
  elementsToRemove: ReadonlySetLike<ExcalidrawElement>,
  elementsMap: ElementsMap,
  opts?: {
    /**
     * Move each element to the closest frame containing its frame that it
     * still overlaps (instead of out of all frames). Callers should then
     * `normalizeNestedFrameOrder()`.
     */
    reparent?: boolean;
  },
) => {
  const _elementsToRemove = new Map<
    ExcalidrawElement["id"],
    ExcalidrawElement
  >();

  const toRemoveElementsByFrame = new Map<
    ExcalidrawFrameLikeElement["id"],
    ExcalidrawElement[]
  >();

  for (const element of elementsToRemove) {
    if (element.frameId) {
      _elementsToRemove.set(element.id, element);

      const arr = toRemoveElementsByFrame.get(element.frameId) || [];
      arr.push(element);

      const boundTextElement = getBoundTextElement(element, elementsMap);
      if (boundTextElement) {
        _elementsToRemove.set(boundTextElement.id, boundTextElement);
        arr.push(boundTextElement);
      }

      toRemoveElementsByFrame.set(element.frameId, arr);
    }
  }

  for (const [, element] of _elementsToRemove) {
    let nextFrameId: ExcalidrawFrameLikeElement["id"] | null = null;
    if (opts?.reparent) {
      const container = isTextElement(element)
        ? getContainerElement(element, elementsMap)
        : null;
      const target = container || element;
      const frame = target.frameId ? elementsMap.get(target.frameId) : null;
      nextFrameId =
        (frame &&
          getFrameAncestors(frame, elementsMap).find((ancestor) =>
            elementOverlapsWithFrame(target, ancestor, elementsMap),
          )?.id) ??
        null;
    }
    mutateElement(element, elementsMap, {
      frameId: nextFrameId,
    });
  }
};

/**
 * Whether one of the arrow's ends is in the frame: bound to an element in it,
 * or, unbound, inside it. An arrow belongs to a frame only while one is.
 */
export const isArrowEndInFrame = (
  arrow: ExcalidrawArrowElement,
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
) => {
  const [x1, y1, x2, y2] = getElementAbsoluteCoords(frame, elementsMap);
  return [arrow.startBinding, arrow.endBinding].some((binding, index) =>
    binding
      ? isFrameDescendantOf(
          elementsMap.get(binding.elementId) ?? arrow,
          frame.id,
          elementsMap,
        )
      : isPointWithinBounds(
          pointFrom(x1, y1),
          LinearElementEditor.getPointAtIndexGlobalCoordinates(
            arrow,
            index ? -1 : 0,
            elementsMap,
          ),
          pointFrom(x2, y2),
        ),
  );
};

/**
 * Takes the arrows among `elements`, and those bound to them, that have no end
 * in their frame (see `isArrowEndInFrame()`) out of it. Call it once their ends
 * (and the elements they're bound to) may have left it. Arrows in groups are
 * left to their group.
 */
export const removeArrowsWithoutEndInFrame = (
  elements: Iterable<ExcalidrawElement>,
  elementsMap: ElementsMap,
) => {
  const arrows = new Set<ExcalidrawArrowElement>();
  for (const element of elements) {
    if (isArrowElement(element)) {
      arrows.add(element);
    }
    for (const { id, type } of element.boundElements ?? []) {
      const arrow = type === "arrow" ? elementsMap.get(id) : undefined;
      if (isArrowElement(arrow)) {
        arrows.add(arrow);
      }
    }
  }

  const arrowsToRemove = [];
  for (const arrow of arrows) {
    const frame = arrow.frameId ? elementsMap.get(arrow.frameId) : undefined;
    if (
      !arrow.isDeleted &&
      !arrow.groupIds.length &&
      frame &&
      isFrameLikeElement(frame) &&
      !isArrowEndInFrame(arrow, frame, elementsMap)
    ) {
      arrowsToRemove.push(arrow);
    }
  }
  removeElementsFromFrame(arrowsToRemove, elementsMap);
};

export const removeAllElementsFromFrame = <T extends ExcalidrawElement>(
  allElements: readonly T[],
  frame: ExcalidrawFrameLikeElement,
  opts?: { reparent?: boolean },
) => {
  const elementsInFrame = getFrameChildren(allElements, frame.id);
  removeElementsFromFrame(elementsInFrame, arrayToMap(allElements), opts);
  return opts?.reparent ? normalizeNestedFrameOrder(allElements) : allElements;
};

export const replaceAllElementsInFrame = <T extends ExcalidrawElement>(
  allElements: readonly T[],
  nextElementsInFrame: ExcalidrawElement[],
  frame: ExcalidrawFrameLikeElement,
): T[] => {
  const elementsMap = arrayToMap(allElements);
  const isNested = getFrameChildren(allElements, frame.id).some(
    isFrameLikeElement,
  );
  const hasNesting =
    isNested ||
    !!frame.frameId ||
    nextElementsInFrame.some((element) => isFrameLikeElement(element));

  if (!hasNesting) {
    const nextElements = addElementsToFrame(
      removeAllElementsFromFrame(allElements, frame),
      nextElementsInFrame,
      frame,
    ).slice();
    removeArrowsWithoutEndInFrame(
      nextElementsInFrame,
      arrayToMap(nextElements),
    );
    return nextElements;
  }

  // nested: children leaving the frame go to the frame containing it (if
  // still in it), and those staying keep their place
  const nextChildren = new Set(nextElementsInFrame);
  const leaving = getFrameChildren(allElements, frame.id).filter(
    (element) =>
      !nextChildren.has(element) &&
      !(
        isTextElement(element) &&
        element.containerId &&
        nextChildren.has(elementsMap.get(element.containerId)!)
      ),
  );
  removeElementsFromFrame(leaving, elementsMap, { reparent: true });
  const nextElements = normalizeNestedFrameOrder(
    addElementsToFrame(allElements, nextElementsInFrame, frame),
  ).slice();
  removeArrowsWithoutEndInFrame(nextElementsInFrame, arrayToMap(nextElements));
  return nextElements;
};

/** does not mutate elements, but returns new ones */
export const updateFrameMembershipOfSelectedElements = <
  T extends ElementsMapOrArray,
>(
  allElements: T,
  appState: AppState,
  app: AppClassProperties,
) => {
  const selectedElements = app.scene.getSelectedElements({
    selectedElementIds: appState.selectedElementIds,
    // supplying elements explicitly in case we're passed non-state elements
    elements: allElements,
  });
  const elementsToFilter = new Set<ExcalidrawElement>(selectedElements);

  if (appState.editingGroupId) {
    for (const element of selectedElements) {
      if (element.groupIds.length === 0) {
        elementsToFilter.add(element);
      } else {
        element.groupIds
          .flatMap((gid) => getElementsInGroup(allElements, gid))
          .forEach((element) => elementsToFilter.add(element));
      }
    }
  }

  const elementsToRemove = new Set<ExcalidrawElement>();

  const elementsMap = arrayToMap(allElements);

  elementsToFilter.forEach((element) => {
    if (element.frameId && !isElementInFrame(element, elementsMap, appState)) {
      elementsToRemove.add(element);
    }
  });

  if (elementsToRemove.size > 0) {
    removeElementsFromFrame(elementsToRemove, elementsMap);
  }
  return allElements;
};

/**
 * filters out elements that are inside groups that contain a frame element
 * anywhere in the group tree
 */
export const omitGroupsContainingFrameLikes = (
  allElements: ElementsMapOrArray,
  /** subset of elements you want to filter. Optional perf optimization so we
   * don't have to filter all elements unnecessarily
   */
  selectedElements?: readonly ExcalidrawElement[],
) => {
  const uniqueGroupIds = new Set<string>();
  const elements = selectedElements || allElements;

  for (const el of elements.values()) {
    const topMostGroupId = el.groupIds[el.groupIds.length - 1];
    if (topMostGroupId) {
      uniqueGroupIds.add(topMostGroupId);
    }
  }

  const rejectedGroupIds = new Set<string>();
  for (const groupId of uniqueGroupIds) {
    if (
      getElementsInGroup(allElements, groupId).some((el) =>
        isFrameLikeElement(el),
      )
    ) {
      rejectedGroupIds.add(groupId);
    }
  }

  const ret: ExcalidrawElement[] = [];

  for (const element of elements.values()) {
    if (!rejectedGroupIds.has(element.groupIds[element.groupIds.length - 1])) {
      ret.push(element);
    }
  }

  return ret;
};

/**
 * depending on the appState, return target frame, which is the frame the given element
 * is going to be added to or remove from
 */
export const getTargetFrame = (
  element: ExcalidrawElement,
  elementsMap: ElementsMap,
  appState: StaticCanvasAppState,
) => {
  const _element = isTextElement(element)
    ? getContainerElement(element, elementsMap) || element
    : element;

  // if the element and a frame containing it are both selected (it moves
  // with that frame), then its containing frame is the target frame
  if (
    _element.frameId &&
    appState.selectedElementIds[_element.id] &&
    hasFrameAncestorIn(_element, appState.selectedElementIds, elementsMap)
  ) {
    return getContainingFrame(_element, elementsMap);
  }

  return appState.selectedElementIds[_element.id] &&
    appState.selectedElementsAreBeingDragged
    ? appState.frameToHighlight
    : getContainingFrame(_element, elementsMap);
};

// TODO: this a huge bottleneck for large scenes, optimise
// given an element, return if the element is in some frame
export const isElementInFrame = (
  element: ExcalidrawElement,
  allElementsMap: ElementsMap,
  appState: StaticCanvasAppState,
  opts?: {
    targetFrame?: ExcalidrawFrameLikeElement;
    checkedGroups?: Map<string, boolean>;
  },
) => {
  const frame =
    opts?.targetFrame ?? getTargetFrame(element, allElementsMap, appState);

  if (!frame) {
    return false;
  }

  const _element = isTextElement(element)
    ? getContainerElement(element, allElementsMap) || element
    : element;

  const setGroupsInFrame = (isInFrame: boolean) => {
    if (opts?.checkedGroups) {
      _element.groupIds.forEach((groupId) => {
        opts.checkedGroups?.set(groupId, isInFrame);
      });
    }
  };

  if (
    // if the element is not selected, or it is selected but not being dragged,
    // frame membership won't update, so return true
    !appState.selectedElementIds[_element.id] ||
    !appState.selectedElementsAreBeingDragged ||
    // if both frame and element are selected, won't update membership, so return true
    (appState.selectedElementIds[_element.id] &&
      (appState.selectedElementIds[frame.id] ||
        hasFrameAncestorIn(
          _element,
          appState.selectedElementIds,
          allElementsMap,
        )))
  ) {
    return true;
  }

  if (_element.groupIds.length === 0) {
    return elementOverlapsWithFrame(_element, frame, allElementsMap);
  }

  for (const gid of _element.groupIds) {
    if (opts?.checkedGroups?.has(gid)) {
      return opts.checkedGroups.get(gid)!!;
    }
  }

  const allElementsInGroup = new Set(
    _element.groupIds
      .filter((gid) => {
        if (opts?.checkedGroups) {
          return !opts.checkedGroups.has(gid);
        }
        return true;
      })
      .flatMap((gid) => getElementsInGroup(allElementsMap, gid)),
  );

  if (appState.editingGroupId && appState.selectedElementsAreBeingDragged) {
    const selectedElements = new Set(
      getSelectedElements(allElementsMap, appState),
    );

    const editingGroupOverlapsFrame = appState.frameToHighlight !== null;

    if (editingGroupOverlapsFrame) {
      return true;
    }

    selectedElements.forEach((selectedElement) => {
      allElementsInGroup.delete(selectedElement);
    });
  }

  for (const elementInGroup of allElementsInGroup) {
    if (isFrameLikeElement(elementInGroup)) {
      setGroupsInFrame(false);
      return false;
    }
  }

  for (const elementInGroup of allElementsInGroup) {
    if (elementOverlapsWithFrame(elementInGroup, frame, allElementsMap)) {
      setGroupsInFrame(true);
      return true;
    }
  }

  return false;
};

export const shouldApplyFrameClip = (
  element: ExcalidrawElement,
  frame: ExcalidrawFrameLikeElement,
  appState: StaticCanvasAppState,
  elementsMap: ElementsMap,
  checkedGroups?: Map<string, boolean>,
) => {
  if (
    !appState.frameRendering ||
    !appState.frameRendering.clip ||
    !isFrameClippable(element, elementsMap)
  ) {
    return false;
  }

  // a frame's children are clipped to it (as in SVG exports): one inside it
  // may still reach out of it with its stroke. Only those being dragged are
  // checked (as their drop will be), the rest are in it as they stand.
  if (element.frameId === frame.id) {
    const shouldClip = isElementInFrame(element, elementsMap, appState, {
      targetFrame: frame,
      checkedGroups,
    });

    for (const groupId of element.groupIds) {
      checkedGroups?.set(groupId, shouldClip);
    }
    return shouldClip;
  }

  // for individual elements, only clip when the element is
  // a. overlapping with the frame, or
  // b. containing the frame, for example when an element is used as a background
  //    and is therefore bigger than the frame and completely contains the frame
  const shouldClipElementItself =
    isElementIntersectingFrame(element, frame, elementsMap) ||
    isElementContainingFrame(element, frame, elementsMap);

  if (shouldClipElementItself) {
    for (const groupId of element.groupIds) {
      checkedGroups?.set(groupId, true);
    }

    return true;
  }

  // if an element is outside the frame, but is part of a group being dragged
  // "in" the frame, we should clip the element
  if (
    appState.selectedElementsAreBeingDragged &&
    element.groupIds.length > 0 &&
    !elementsAreInFrameBounds([element], frame, elementsMap)
  ) {
    const shouldClip = isElementInFrame(element, elementsMap, appState, {
      targetFrame: frame,
      checkedGroups,
    });

    for (const groupId of element.groupIds) {
      checkedGroups?.set(groupId, shouldClip);
    }

    return shouldClip;
  }

  return false;
};

const DEFAULT_FRAME_NAME = "Frame";
const DEFAULT_AI_FRAME_NAME = "AI Frame";

export const getDefaultFrameName = (element: ExcalidrawFrameLikeElement) => {
  // TODO name frames "AI" only if specific to AI frames
  return isFrameElement(element) ? DEFAULT_FRAME_NAME : DEFAULT_AI_FRAME_NAME;
};

export const getFrameLikeTitle = (element: ExcalidrawFrameLikeElement) => {
  return element.name === null ? getDefaultFrameName(element) : element.name;
};

export const getElementsOverlappingFrame = <T extends ExcalidrawElement>(
  elements: readonly T[],
  frame: ExcalidrawFrameLikeElement,
  elementsMap: ElementsMap,
) => {
  const frameBounds = getElementBounds(frame, elementsMap);

  return elements.filter((el) => {
    const container =
      isTextElement(el) && el.containerId
        ? elementsMap.get(el.containerId)
        : null;
    // an arrow's label is placed, and thus shown, with its arrow
    const target = isArrowElement(container) ? container : el;

    return (
      // exclude elements which are overlapping, but are in a different frame,
      // and thus invisible in target frame (unless not clipped by theirs)
      // (nested frames' contents included)
      (!target.frameId ||
        isFrameDescendantOf(target, frame.id, elementsMap) ||
        !isFrameClippable(target, elementsMap)) &&
      doBoundsIntersect(getElementBounds(target, elementsMap), frameBounds)
    );
  });
};

export const frameAndChildrenSelectedTogether = (
  selectedElements: readonly ExcalidrawElement[],
) => {
  const selectedElementsMap = arrayToMap(selectedElements);

  return (
    selectedElements.length > 1 &&
    selectedElements.some((element) =>
      hasFrameAncestorIn(element, selectedElementsMap, selectedElementsMap),
    )
  );
};
