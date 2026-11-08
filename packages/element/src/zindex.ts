import { arrayToMap, findIndex, findLastIndex } from "@excalidraw/common";

import { isFiniteNumber } from "@excalidraw/math";

import type { AppState } from "@excalidraw/excalidraw/types";
import type { GlobalPoint } from "@excalidraw/math";

import { isFrameLikeElement, isTextElement } from "./typeChecks";
import { getElementsInGroup } from "./groups";
import { syncMovedIndices } from "./fractionalIndex";
import { getSelectedElements } from "./selection";
import { getBoundTextElement, getContainerElement } from "./textElement";
import {
  getFrameAncestors,
  getRootFrame,
  isFrameDescendantOf,
  normalizeNestedFrameOrder,
} from "./frame";

import type { Scene } from "./Scene";
import type {
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
  OrderedExcalidrawElement,
} from "./types";

/** the frame, or (transitively) inside it */
const isOfTargetFrame = (
  element: ExcalidrawElement,
  frameId: string,
  elementsMap: ElementsMap,
) => {
  return (
    element.frameId === frameId ||
    element.id === frameId ||
    isFrameDescendantOf(element, frameId, elementsMap)
  );
};

/**
 * Returns indices of elements to move based on selected elements.
 * Includes contiguous deleted elements that are between two selected elements,
 *  e.g.: [0 (selected), 1 (deleted), 2 (deleted), 3 (selected)]
 *
 * Specified elements (elementsToBeMoved) take precedence over
 * appState.selectedElementsIds
 */
const getIndicesToMove = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  elementsToBeMoved?: readonly ExcalidrawElement[],
) => {
  let selectedIndices: number[] = [];
  let deletedIndices: number[] = [];
  let includeDeletedIndex = null;
  let index = -1;
  const selectedElementIds = arrayToMap(
    elementsToBeMoved
      ? elementsToBeMoved
      : getSelectedElements(elements, appState, {
          includeBoundTextElement: true,
          includeElementsInFrames: true,
        }),
  );
  while (++index < elements.length) {
    const element = elements[index];
    if (selectedElementIds.get(element.id)) {
      if (deletedIndices.length) {
        selectedIndices = selectedIndices.concat(deletedIndices);
        deletedIndices = [];
      }
      selectedIndices.push(index);
      includeDeletedIndex = index + 1;
    } else if (element.isDeleted && includeDeletedIndex === index) {
      includeDeletedIndex = index + 1;
      deletedIndices.push(index);
    } else {
      deletedIndices = [];
    }
  }
  return selectedIndices;
};

const toContiguousGroups = (array: number[]) => {
  let cursor = 0;
  return array.reduce((acc, value, index) => {
    if (index > 0 && array[index - 1] !== value - 1) {
      cursor = ++cursor;
    }
    (acc[cursor] || (acc[cursor] = [])).push(value);
    return acc;
  }, [] as number[][]);
};

/**
 * @returns index of target element, consindering tightly-bound elements
 * (currently non-linear elements bound to a container) as a one unit.
 * If no binding present, returns `undefined`.
 */
const getTargetIndexAccountingForBinding = (
  nextElement: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
  direction: "left" | "right",
  scene: Scene,
) => {
  if ("containerId" in nextElement && nextElement.containerId) {
    // TODO: why not to get the container from the nextElements?
    const containerElement = scene.getElement(nextElement.containerId);
    if (containerElement) {
      return direction === "left"
        ? Math.min(
            elements.indexOf(containerElement),
            elements.indexOf(nextElement),
          )
        : Math.max(
            elements.indexOf(containerElement),
            elements.indexOf(nextElement),
          );
    }
  } else {
    const boundElementId = nextElement.boundElements?.find(
      (binding) => binding.type !== "arrow",
    )?.id;
    if (boundElementId) {
      const boundTextElement = scene.getElement(boundElementId);
      if (boundTextElement) {
        return direction === "left"
          ? Math.min(
              elements.indexOf(boundTextElement),
              elements.indexOf(nextElement),
            )
          : Math.max(
              elements.indexOf(boundTextElement),
              elements.indexOf(nextElement),
            );
      }
    }
  }
};

/** the frame's block: it and everything in it (nested frames included) */
const getContiguousFrameRangeElements = (
  allElements: readonly ExcalidrawElement[],
  frameId: ExcalidrawFrameLikeElement["id"],
) => {
  const elementsMap = arrayToMap(allElements);
  let rangeStart = -1;
  let rangeEnd = -1;
  allElements.forEach((element, index) => {
    if (isOfTargetFrame(element, frameId, elementsMap)) {
      if (rangeStart === -1) {
        rangeStart = index;
      }
      rangeEnd = index;
    }
  });
  if (rangeStart === -1) {
    return [];
  }
  return allElements.slice(rangeStart, rangeEnd + 1);
};

/**
 * Moves the arrow element above any bindable elements it intersects with or
 * hovers over.
 */
export const moveArrowAboveBindable = (
  point: GlobalPoint,
  arrow: ExcalidrawArrowElement,
  elements: readonly OrderedExcalidrawElement[],
  elementsMap: NonDeletedSceneElementsMap,
  scene: Scene,
  hoveredElement: NonDeletedExcalidrawElement,
): readonly OrderedExcalidrawElement[] => {
  if (!hoveredElement) {
    return elements;
  }

  const boundTextElement = getBoundTextElement(hoveredElement, elementsMap);
  const containerElement = isTextElement(hoveredElement)
    ? getContainerElement(hoveredElement, elementsMap)
    : null;

  const bindableIds = [
    hoveredElement.id,
    boundTextElement?.id,
    containerElement?.id,
  ].filter((id): id is NonDeletedExcalidrawElement["id"] => !!id);
  const bindableIdx = elements.findIndex((el) => bindableIds.includes(el.id));
  const arrowIdx = elements.findIndex((el) => el.id === arrow.id);

  if (arrowIdx !== -1 && bindableIdx !== -1 && arrowIdx < bindableIdx) {
    const updatedElements = Array.from(elements);
    const arrow = updatedElements.splice(arrowIdx, 1)[0];
    updatedElements.splice(bindableIdx, 0, arrow);

    scene.replaceAllElements(updatedElements);
  }

  return elements;
};

/**
 * Returns next candidate index that's available to be moved to. Currently that
 *  is a non-deleted element, and not inside a group (unless we're editing it).
 */
const getTargetIndex = (
  appState: AppState,
  elements: readonly ExcalidrawElement[],
  boundaryIndex: number,
  direction: "left" | "right",
  /**
   * Frame id if moving frame children.
   * If whole frame (including all children) is being moved, supply `null`.
   */
  containingFrame: ExcalidrawFrameLikeElement["id"] | null,
  scene: Scene,
  /** whether a (nested) frame is moved, within `containingFrame` */
  isMovingFrame = false,
) => {
  const sourceElement = elements[boundaryIndex];

  const indexFilter = (element: ExcalidrawElement) => {
    if (element.isDeleted) {
      return false;
    }
    if (containingFrame) {
      return element.frameId === containingFrame;
    }
    // if we're editing group, find closest sibling irrespective of whether
    // there's a different-group element between them (for legacy reasons)
    if (appState.editingGroupId) {
      return element.groupIds.includes(appState.editingGroupId);
    }
    return true;
  };

  const candidateIndex =
    direction === "left"
      ? findLastIndex(
          elements,
          (el) => indexFilter(el),
          Math.max(0, boundaryIndex - 1),
        )
      : findIndex(elements, (el) => indexFilter(el), boundaryIndex + 1);

  const nextElement = elements[candidateIndex];

  if (!nextElement) {
    return -1;
  }

  if (appState.editingGroupId) {
    if (
      // candidate element is a sibling in current editing group → return
      sourceElement?.groupIds.join("") === nextElement?.groupIds.join("")
    ) {
      return (
        getTargetIndexAccountingForBinding(
          nextElement,
          elements,
          direction,
          scene,
        ) ?? candidateIndex
      );
    } else if (!nextElement?.groupIds.includes(appState.editingGroupId)) {
      // candidate element is outside current editing group → prevent
      return -1;
    }
  }

  if (containingFrame && isFrameLikeElement(nextElement)) {
    // a nested frame: moved over as a whole, and only by other nested frames
    // (child frames stay above their parent's other children)
    if (!isMovingFrame) {
      return -1;
    }
    const frameElements = getContiguousFrameRangeElements(
      elements,
      nextElement.id,
    );
    return direction === "left"
      ? elements.indexOf(frameElements[0])
      : elements.indexOf(frameElements[frameElements.length - 1]);
  }

  if (containingFrame && isMovingFrame) {
    // a nested frame doesn't go below its parent's other children
    return -1;
  }

  if (
    !containingFrame &&
    (nextElement.frameId || isFrameLikeElement(nextElement))
  ) {
    const rootFrame = getRootFrame(nextElement, arrayToMap(elements));
    const frameElements = getContiguousFrameRangeElements(
      elements,
      rootFrame?.id ?? nextElement.frameId ?? nextElement.id,
    );
    return direction === "left"
      ? elements.indexOf(frameElements[0])
      : elements.indexOf(frameElements[frameElements.length - 1]);
  }

  if (!nextElement.groupIds.length) {
    return (
      getTargetIndexAccountingForBinding(
        nextElement,
        elements,
        direction,
        scene,
      ) ?? candidateIndex
    );
  }

  const siblingGroupId = appState.editingGroupId
    ? nextElement.groupIds[
        nextElement.groupIds.indexOf(appState.editingGroupId) - 1
      ]
    : nextElement.groupIds[nextElement.groupIds.length - 1];

  const elementsInSiblingGroup = getElementsInGroup(elements, siblingGroupId);

  if (elementsInSiblingGroup.length) {
    // assumes getElementsInGroup() returned elements are sorted
    // by zIndex (ascending)
    return direction === "left"
      ? elements.indexOf(elementsInSiblingGroup[0])
      : elements.indexOf(
          elementsInSiblingGroup[elementsInSiblingGroup.length - 1],
        );
  }

  return candidateIndex;
};

const getTargetElementsMap = <T extends ExcalidrawElement>(
  elements: readonly T[],
  indices: number[],
) => {
  return indices.reduce((acc, index) => {
    const element = elements[index];
    acc.set(element.id, element);
    return acc;
  }, new Map<string, ExcalidrawElement>());
};

const hasSameElementIds = (
  prevElements: readonly ExcalidrawElement[],
  nextElements: readonly ExcalidrawElement[],
) => {
  if (prevElements.length !== nextElements.length) {
    console.error(
      "z-index reordering failed: resulting array have different lengths",
    );
    return false;
  }

  const prevElementIdCounts = new Map<ExcalidrawElement["id"], number>();
  for (const element of prevElements) {
    prevElementIdCounts.set(
      element.id,
      (prevElementIdCounts.get(element.id) || 0) + 1,
    );
  }

  for (const element of nextElements) {
    const count = prevElementIdCounts.get(element.id);
    if (!count) {
      console.error(
        "z-index reordering failed: element id mismatch / duplicate ids",
      );
      return false;
    }
    prevElementIdCounts.set(element.id, count - 1);
  }

  return true;
};

const shiftElementsByOne = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  direction: "left" | "right",
  scene: Scene,
) => {
  const originalElements = elements;
  const indicesToMove = getIndicesToMove(elements, appState);
  const targetElementsMap = getTargetElementsMap(elements, indicesToMove);

  let groupedIndices = toContiguousGroups(indicesToMove);

  if (direction === "right") {
    groupedIndices = groupedIndices.reverse();
  }

  const selectedFrames = new Set<ExcalidrawFrameLikeElement["id"]>(
    indicesToMove
      .filter((idx) => isFrameLikeElement(elements[idx]))
      .map((idx) => elements[idx].id),
  );
  const elementsMap = arrayToMap(elements);

  groupedIndices.forEach((indices, i) => {
    const leadingIndex = indices[0];
    const trailingIndex = indices[indices.length - 1];
    const boundaryIndex = direction === "left" ? leadingIndex : trailingIndex;

    // each element moves with the outermost selected frame containing it (if
    // any): the moved unit is in the frame that one is in
    const unitRoots = indices.map(
      (idx) =>
        getFrameAncestors(elements[idx], elementsMap)
          .filter((frame) => selectedFrames.has(frame.id))
          .at(-1) ?? elements[idx],
    );
    const boundaryRoot =
      direction === "left" ? unitRoots[0] : unitRoots[unitRoots.length - 1];
    const containingFrame = boundaryRoot?.frameId ?? null;
    const isMovingFrame =
      !!containingFrame &&
      unitRoots.some((element) => isFrameLikeElement(element));

    const targetIndex = getTargetIndex(
      appState,
      elements,
      boundaryIndex,
      direction,
      containingFrame,
      scene,
      isMovingFrame,
    );

    if (targetIndex === -1 || boundaryIndex === targetIndex) {
      return;
    }

    const leadingElements =
      direction === "left"
        ? elements.slice(0, targetIndex)
        : elements.slice(0, leadingIndex);
    const targetElements = elements.slice(leadingIndex, trailingIndex + 1);
    const displacedElements =
      direction === "left"
        ? elements.slice(targetIndex, leadingIndex)
        : elements.slice(trailingIndex + 1, targetIndex + 1);
    const trailingElements =
      direction === "left"
        ? elements.slice(trailingIndex + 1)
        : elements.slice(targetIndex + 1);

    elements =
      direction === "left"
        ? [
            ...leadingElements,
            ...targetElements,
            ...displacedElements,
            ...trailingElements,
          ]
        : [
            ...leadingElements,
            ...displacedElements,
            ...targetElements,
            ...trailingElements,
          ];
  });

  if (!hasSameElementIds(originalElements, elements)) {
    return originalElements;
  }

  syncMovedIndices(elements, targetElementsMap);

  return normalizeNestedFrameOrder(elements);
};

const shiftElementsToEnd = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  direction: "left" | "right",
  containingFrame: ExcalidrawFrameLikeElement["id"] | null,
  elementsToBeMoved?: readonly ExcalidrawElement[],
) => {
  const indicesToMove = getIndicesToMove(elements, appState, elementsToBeMoved);

  // Nothing to move (e.g. `elementsToBeMoved` is empty because all selected
  // elements were frame children handled in a prior pass). Bail out early —
  // otherwise `leadingIndex`/`trailingIndex` below resolve to `undefined` and
  // the resulting `slice()` calls overlap, duplicating elements.
  if (indicesToMove.length === 0) {
    return elements;
  }

  const targetElementsMap = getTargetElementsMap(elements, indicesToMove);
  const displacedElements: ExcalidrawElement[] = [];

  let leadingIndex: number | undefined;
  let trailingIndex: number | undefined;
  const elementsMap = arrayToMap(elements);
  if (direction === "left") {
    if (containingFrame) {
      leadingIndex = findIndex(elements, (el) =>
        isOfTargetFrame(el, containingFrame, elementsMap),
      );
    } else if (appState.editingGroupId) {
      const groupElements = getElementsInGroup(
        elements,
        appState.editingGroupId,
      );
      if (!groupElements.length) {
        return elements;
      }
      leadingIndex = elements.indexOf(groupElements[0]);
    } else {
      leadingIndex = 0;
    }

    trailingIndex = indicesToMove[indicesToMove.length - 1];
  } else {
    if (containingFrame) {
      trailingIndex = findLastIndex(elements, (el) =>
        isOfTargetFrame(el, containingFrame, elementsMap),
      );
    } else if (appState.editingGroupId) {
      const groupElements = getElementsInGroup(
        elements,
        appState.editingGroupId,
      );
      if (!groupElements.length) {
        return elements;
      }
      trailingIndex = elements.indexOf(groupElements[groupElements.length - 1]);
    } else {
      trailingIndex = elements.length - 1;
    }

    leadingIndex = indicesToMove[0];
  }

  if (leadingIndex === -1) {
    leadingIndex = 0;
  }

  const isValidIndex = (index: number | undefined): index is number => {
    return isFiniteNumber(index) && index >= 0;
  };

  if (
    !isValidIndex(leadingIndex) ||
    !isValidIndex(trailingIndex) ||
    leadingIndex > trailingIndex ||
    indicesToMove.some((index) => index < leadingIndex || index > trailingIndex)
  ) {
    return elements;
  }

  for (let index = leadingIndex; index < trailingIndex + 1; index++) {
    if (!indicesToMove.includes(index)) {
      displacedElements.push(elements[index]);
    }
  }

  const targetElements = Array.from(targetElementsMap.values());
  const leadingElements = elements.slice(0, leadingIndex);
  const trailingElements = elements.slice(trailingIndex + 1);
  const nextElements =
    direction === "left"
      ? [
          ...leadingElements,
          ...targetElements,
          ...displacedElements,
          ...trailingElements,
        ]
      : [
          ...leadingElements,
          ...displacedElements,
          ...targetElements,
          ...trailingElements,
        ];

  if (!hasSameElementIds(elements, nextElements)) {
    return elements;
  }

  syncMovedIndices(nextElements, targetElementsMap);

  return nextElements;
};

function shiftElementsAccountingForFrames(
  allElements: readonly ExcalidrawElement[],
  appState: AppState,
  direction: "left" | "right",
  shiftFunction: (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    direction: "left" | "right",
    containingFrame: ExcalidrawFrameLikeElement["id"] | null,
    elementsToBeMoved?: readonly ExcalidrawElement[],
  ) => ExcalidrawElement[] | readonly ExcalidrawElement[],
) {
  const elementsToMove = arrayToMap(
    getSelectedElements(allElements, appState, {
      includeBoundTextElement: true,
      includeElementsInFrames: true,
    }),
  );

  const frameAwareContiguousElementsToMove: {
    regularElements: ExcalidrawElement[];
    frameChildren: Map<ExcalidrawFrameLikeElement["id"], ExcalidrawElement[]>;
  } = { regularElements: [], frameChildren: new Map() };

  const fullySelectedFrames = new Set<ExcalidrawFrameLikeElement["id"]>();

  for (const element of allElements) {
    if (elementsToMove.has(element.id) && isFrameLikeElement(element)) {
      fullySelectedFrames.add(element.id);
    }
  }

  const allElementsMap = arrayToMap(allElements);

  for (const element of allElements) {
    if (elementsToMove.has(element.id)) {
      // moved with the outermost selected frame containing it (if any), within
      // the frame that one is in
      const unitRoot =
        getFrameAncestors(element, allElementsMap)
          .filter((frame) => fullySelectedFrames.has(frame.id))
          .at(-1) ?? element;
      const containingFrameId = unitRoot.frameId;

      if (!containingFrameId) {
        frameAwareContiguousElementsToMove.regularElements.push(element);
      } else {
        const frameChildren =
          frameAwareContiguousElementsToMove.frameChildren.get(
            containingFrameId,
          ) || [];
        frameChildren.push(element);
        frameAwareContiguousElementsToMove.frameChildren.set(
          containingFrameId,
          frameChildren,
        );
      }
    }
  }

  let nextElements = allElements;

  const frameChildrenSets = Array.from(
    frameAwareContiguousElementsToMove.frameChildren.entries(),
  );

  for (const [frameId, children] of frameChildrenSets) {
    nextElements = shiftFunction(
      nextElements,
      appState,
      direction,
      frameId,
      children,
    );
  }

  return normalizeNestedFrameOrder(
    shiftFunction(
      nextElements,
      appState,
      direction,
      null,
      frameAwareContiguousElementsToMove.regularElements,
    ),
  );
}

// public API
// -----------------------------------------------------------------------------

export const moveOneLeft = (
  allElements: readonly ExcalidrawElement[],
  appState: AppState,
  scene: Scene,
) => {
  return shiftElementsByOne(allElements, appState, "left", scene);
};

export const moveOneRight = (
  allElements: readonly ExcalidrawElement[],
  appState: AppState,
  scene: Scene,
) => {
  return shiftElementsByOne(allElements, appState, "right", scene);
};

export const moveAllLeft = (
  allElements: readonly ExcalidrawElement[],
  appState: AppState,
) => {
  return shiftElementsAccountingForFrames(
    allElements,
    appState,
    "left",
    shiftElementsToEnd,
  );
};

export const moveAllRight = (
  allElements: readonly ExcalidrawElement[],
  appState: AppState,
) => {
  return shiftElementsAccountingForFrames(
    allElements,
    appState,
    "right",
    shiftElementsToEnd,
  );
};
