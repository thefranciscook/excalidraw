import React from "react";

import {
  convertToExcalidrawElements,
  Excalidraw,
} from "@excalidraw/excalidraw";
import { arrayToMap, KEYS } from "@excalidraw/common";

import {
  actionBringToFront,
  actionDeleteSelected,
  actionDuplicateSelection,
  actionSendToBack,
} from "@excalidraw/excalidraw/actions";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { exportScene } from "@excalidraw/excalidraw/scene/export";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Keyboard, Pointer } from "@excalidraw/excalidraw/tests/helpers/ui";
import { act, render } from "@excalidraw/excalidraw/tests/test-utils";

import {
  getElementsOverlappingFrame,
  getFrameAncestors,
  getFrameDescendants,
  isFrameDescendantOf,
  normalizeNestedFrameOrder,
} from "../src/frame";
import { resolveElementRenderState } from "../src/renderElement";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "../src/types";

const { h } = window;
const mouse = new Pointer("mouse");

const ids = (elements: readonly ExcalidrawElement[] = h.elements) =>
  elements.filter((element) => !element.isDeleted).map((element) => element.id);

const getElement = (id: string) =>
  h.elements.find((el) => el.id === id)! as NonDeletedExcalidrawElement;

// P (0,0 400×400)
// ├─ C  (content, 20,20 50×50)
// └─ Q (frame, 200,200 150×150)
//    └─ R (content, 220,220 50×50)
const createNestedScene = () => {
  const P = API.createElement({
    type: "frame",
    id: "P",
    x: 0,
    y: 0,
    width: 400,
    height: 400,
  });
  const C = API.createElement({
    type: "rectangle",
    id: "C",
    x: 20,
    y: 20,
    width: 50,
    height: 50,
    frameId: "P",
  });
  const Q = API.createElement({
    type: "frame",
    id: "Q",
    x: 200,
    y: 200,
    width: 150,
    height: 150,
    frameId: "P",
  });
  const R = API.createElement({
    type: "rectangle",
    id: "R",
    x: 220,
    y: 220,
    width: 50,
    height: 50,
    frameId: "Q",
  });
  API.setElements([C, R, Q, P]);
  return { P, C, Q, R };
};

const dragFromTo = (
  from: { x: number; y: number },
  to: { x: number; y: number },
) => {
  mouse.downAt(from.x, from.y);
  mouse.moveTo((from.x + to.x) / 2, (from.y + to.y) / 2);
  mouse.moveTo(to.x, to.y);
  mouse.up();
};

describe("nested frames", () => {
  beforeEach(async () => {
    localStorage.clear();
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    mouse.reset();
  });

  describe("hierarchy helpers", () => {
    it("walk the frames containing an element and those inside a frame", () => {
      const { P, C, Q, R } = createNestedScene();
      const elementsMap = arrayToMap(h.elements);

      expect(getFrameAncestors(R, elementsMap).map((el) => el.id)).toEqual([
        Q.id,
        P.id,
      ]);
      expect(ids(getFrameDescendants(h.elements, P.id))).toEqual([
        C.id,
        R.id,
        Q.id,
      ]);
      expect(isFrameDescendantOf(R, P.id, elementsMap)).toBe(true);
      expect(isFrameDescendantOf(P, R.id, elementsMap)).toBe(false);
    });

    it("are safe against frame cycles", () => {
      const A = API.createElement({ type: "frame", id: "A", frameId: "B" });
      const B = API.createElement({ type: "frame", id: "B", frameId: "A" });
      const elementsMap = arrayToMap([A, B]);

      expect(getFrameAncestors(A, elementsMap).map((el) => el.id)).toEqual([
        "B",
      ]);
      expect(ids(getFrameDescendants([A, B], "A"))).toEqual(["B"]);
    });

    it("normalizes a frame's block: content, then child frames, then it", () => {
      const { P, C, Q, R } = createNestedScene();

      expect(ids(normalizeNestedFrameOrder([Q, R, P, C]))).toEqual([
        C.id,
        R.id,
        Q.id,
        P.id,
      ]);
      // already normalized: same array
      const elements = [C, R, Q, P];
      expect(normalizeNestedFrameOrder(elements)).toBe(elements);
    });
  });

  describe("membership", () => {
    it("drags a frame (with its children) into another frame", () => {
      const P = API.createElement({
        type: "frame",
        id: "P",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
      });
      const C = API.createElement({
        type: "rectangle",
        id: "C",
        x: 20,
        y: 20,
        width: 50,
        height: 50,
        frameId: "P",
      });
      const Q = API.createElement({
        type: "frame",
        id: "Q",
        x: 600,
        y: 0,
        width: 100,
        height: 100,
      });
      const R = API.createElement({
        type: "rectangle",
        id: "R",
        x: 610,
        y: 10,
        width: 30,
        height: 30,
        frameId: "Q",
      });
      API.setElements([C, P, R, Q]);

      API.setSelectedElements([Q]);
      dragFromTo({ x: 650, y: 50 }, { x: 250, y: 250 });

      expect(getElement("Q").frameId).toBe(P.id);
      expect(getElement("R").frameId).toBe(Q.id);
      // its child moved along
      expect(getElement("R").x).toBe(210);
      // the nested frame's block is above the parent's other children
      expect(ids()).toEqual([C.id, R.id, Q.id, P.id]);
    });

    it("drags a nested frame out of its parent", () => {
      const { Q } = createNestedScene();

      API.setSelectedElements([Q]);
      dragFromTo({ x: 275, y: 275 }, { x: 775, y: 275 });

      expect(getElement("Q").frameId).toBe(null);
      expect(getElement("R").frameId).toBe(Q.id);
    });

    it("drags a nested frame from its parent to the parent's parent", () => {
      const { P, Q } = createNestedScene();
      const G = API.createElement({
        type: "frame",
        id: "G",
        x: -100,
        y: -100,
        width: 1000,
        height: 1000,
      });
      API.updateElement(P, { frameId: G.id });
      API.setElements(normalizeNestedFrameOrder([...h.elements, G]));

      API.setSelectedElements([Q]);
      dragFromTo({ x: 275, y: 275 }, { x: 675, y: 275 });

      expect(getElement("Q").frameId).toBe(G.id);
    });

    it("moves everything nested in a frame dragged", () => {
      const { P, C, Q, R } = createNestedScene();

      API.setSelectedElements([P]);
      dragFromTo({ x: 100, y: 100 }, { x: 150, y: 100 });

      expect(getElement(P.id).x).toBe(50);
      expect(getElement(C.id).x).toBe(70);
      expect(getElement(Q.id).x).toBe(250);
      expect(getElement(R.id).x).toBe(270);
      expect(getElement(Q.id).frameId).toBe(P.id);
      expect(getElement(R.id).frameId).toBe(Q.id);
    });

    it("adds an element drawn in a nested frame to it (not its parent)", () => {
      const { Q } = createNestedScene();

      act(() => h.app.setActiveTool({ type: "rectangle" }));
      mouse.downAt(300, 300);
      mouse.moveTo(330, 330);
      mouse.upAt(330, 330);

      const created = h.elements.find(
        (element) => !["P", "C", "Q", "R"].includes(element.id),
      )!;
      expect(created.frameId).toBe(Q.id);
      expect(ids()).toEqual(["C", "R", created.id, "Q", "P"]);
    });

    it("nests a frame drawn inside a frame", () => {
      const { P } = createNestedScene();

      act(() => h.app.setActiveTool({ type: "frame" }));
      mouse.downAt(100, 100);
      mouse.moveTo(180, 180);
      mouse.upAt(180, 180);

      const created = h.elements.find(
        (element) => !["P", "C", "Q", "R"].includes(element.id),
      )!;
      expect(created.type).toBe("frame");
      expect(created.frameId).toBe(P.id);
      // the new child frame is in the parent's child-frame layer
      expect(ids()).toEqual(["C", "R", "Q", created.id, "P"]);
    });

    it("captures the frames (and siblings) fully inside a frame drawn", () => {
      const { P, C, Q } = createNestedScene();

      act(() => h.app.setActiveTool({ type: "frame" }));
      mouse.downAt(10, 10);
      mouse.moveTo(390, 390);
      mouse.upAt(390, 390);

      const created = h.elements.find(
        (element) => !["P", "C", "Q", "R"].includes(element.id),
      )!;
      expect(created.frameId).toBe(P.id);
      expect(getElement(C.id).frameId).toBe(created.id);
      expect(getElement(Q.id).frameId).toBe(created.id);
      expect(getElement("R").frameId).toBe(Q.id);
      expect(ids()).toEqual(["C", "R", "Q", created.id, "P"]);
    });

    it("wraps a nested frame's children in a frame nested in it", () => {
      const { Q, R } = createNestedScene();
      // (selecting all of its children would unwrap it instead)
      const R2 = API.createElement({
        type: "rectangle",
        id: "R2",
        x: 300,
        y: 300,
        width: 20,
        height: 20,
        frameId: Q.id,
      });
      API.setElements(normalizeNestedFrameOrder([...h.elements, R2]));

      API.setSelectedElements([R]);
      Keyboard.keyPress(KEYS.W);

      const wrapper = getElement(R.id).frameId!;
      expect(wrapper).not.toBe(Q.id);
      expect(getElement(wrapper).frameId).toBe(Q.id);
    });
  });

  describe("selection", () => {
    it("moves a box-selected nested tree once", () => {
      createNestedScene();

      // (box selection takes frames along with their children, as for flat
      // frames)
      mouse.downAt(-10, -10);
      mouse.move(-1000, -1000);
      mouse.moveTo(450, 450);
      mouse.up();
      expect(h.state.selectedElementIds.P).toBe(true);

      dragFromTo({ x: 100, y: 100 }, { x: 150, y: 100 });

      expect(getElement("P").x).toBe(50);
      expect(getElement("C").x).toBe(70);
      expect(getElement("Q").x).toBe(250);
      expect(getElement("R").x).toBe(270);
      expect(ids()).toEqual(["C", "R", "Q", "P"]);
    });

    it("deselects the frames containing an element shift-clicked", () => {
      const { R } = createNestedScene();

      API.setSelectedElements([getElement("P")]);
      Keyboard.withModifierKeys({ shift: true }, () => {
        mouse.clickAt(R.x + 5, R.y + 5);
      });

      expect(Object.keys(h.state.selectedElementIds)).toEqual(["R"]);
    });
  });

  describe("z-order", () => {
    it("keeps a parent's content below its child frames", () => {
      const { C } = createNestedScene();

      API.setSelectedElements([C]);
      API.executeAction(actionBringToFront);
      expect(ids()).toEqual(["C", "R", "Q", "P"]);
    });

    it("keeps child frames above their parent's content", () => {
      const { Q } = createNestedScene();

      API.setSelectedElements([Q]);
      API.executeAction(actionSendToBack);
      expect(ids()).toEqual(["C", "R", "Q", "P"]);
    });

    it("reorders child frames among themselves", () => {
      const { P } = createNestedScene();
      const Q2 = API.createElement({
        type: "frame",
        id: "Q2",
        x: 20,
        y: 200,
        width: 100,
        height: 100,
        frameId: P.id,
      });
      API.setElements(normalizeNestedFrameOrder([...h.elements, Q2]));
      expect(ids()).toEqual(["C", "R", "Q", "Q2", "P"]);

      API.setSelectedElements([getElement("Q2")]);
      API.executeAction(actionSendToBack);
      expect(ids()).toEqual(["C", "Q2", "R", "Q", "P"]);

      API.setSelectedElements([getElement("Q2")]);
      API.executeAction(actionBringToFront);
      expect(ids()).toEqual(["C", "R", "Q", "Q2", "P"]);
    });
  });

  describe("delete & duplicate", () => {
    it("moves a deleted nested frame's children to its parent", () => {
      const { P, Q, R } = createNestedScene();

      API.setSelectedElements([Q]);
      API.executeAction(actionDeleteSelected);

      expect(getElement(Q.id).isDeleted).toBe(true);
      expect(getElement(R.id).isDeleted).toBe(false);
      expect(getElement(R.id).frameId).toBe(P.id);
    });

    it("deletes everything nested in a frame deleted with its children", () => {
      const { P } = createNestedScene();

      API.setSelectedElements([P]);
      act(() => {
        h.app.actionManager.executeAction(actionDeleteSelected, "api", {
          withFrameChildren: true,
        });
      });

      expect(ids()).toEqual([]);
    });

    it("duplicates a frame with everything nested in it", () => {
      createNestedScene();

      API.setSelectedElements([getElement("P")]);
      API.executeAction(actionDuplicateSelection);

      const elements = h.elements.filter((element) => !element.isDeleted);
      expect(elements.length).toBe(8);
      const elementsMap = arrayToMap(elements);
      const [, , , , C2, R2, Q2, P2] = elements;
      expect(ids([C2, R2, Q2, P2])).not.toContain("P");
      expect(P2.type).toBe("frame");
      expect(Q2.frameId).toBe(P2.id);
      expect(R2.frameId).toBe(Q2.id);
      expect(C2.frameId).toBe(P2.id);
      expect(getFrameAncestors(R2, elementsMap).map((el) => el.id)).toEqual([
        Q2.id,
        P2.id,
      ]);
    });
  });

  describe("rendering & hit testing", () => {
    it("multiplies the opacity of the frames containing an element", () => {
      const { P, Q, R } = createNestedScene();
      API.updateElement(P, { opacity: 50 });
      API.updateElement(Q, { opacity: 50 });

      const { opacity } = resolveElementRenderState(R, arrayToMap(h.elements), {
        elementRenderOverrides: undefined,
        elementsPendingErasure: new Set(),
        pendingFlowchartNodes: null,
      });
      expect(opacity).toBe(0.25);
    });

    it("clips hit testing to every frame containing an element", () => {
      const { R } = createNestedScene();
      // R sticks out of Q (and P) on the right
      API.updateElement(getElement("Q"), { x: 0, width: 100 });
      API.updateElement(R, { x: 50, width: 400 });

      // inside R and P, outside Q
      expect(h.app.isClippedByFrameAt(300, 240, getElement("R"))).toBe(true);
      // inside R and Q
      expect(h.app.isClippedByFrameAt(60, 240, getElement("R"))).toBe(false);
    });
  });

  describe("export", () => {
    it("exports what's nested in a frame, with the nested frames' decorations", async () => {
      const { P, Q } = createNestedScene();
      API.updateElement(Q, { name: "Inner" });
      API.updateElement(P, { name: "Outer" });

      expect(
        ids(getElementsOverlappingFrame(h.elements, P, arrayToMap(h.elements))),
      ).toEqual(["C", "R", "Q", "P"]);

      const svg = await exportScene({
        type: "svg",
        data: {
          elements: h.elements as readonly NonDeletedExcalidrawElement[],
          appState: {},
          files: null,
        },
        config: {
          exportingFrame: getElement("P") as NonDeleted<ExcalidrawFrameElement>,
        },
      });

      // the nested frame's children are clipped to it
      expect(svg.querySelector('[clip-path="url(#Q)"]')).not.toBeNull();
      // its name is shown, the exported frame's isn't
      expect(svg.textContent).toContain("Inner");
      expect(svg.textContent).not.toContain("Outer");
    });
  });

  describe("restore & API", () => {
    it("cuts frame cycles and frameIds of non-frames on restore", () => {
      const A = API.createElement({ type: "frame", id: "A", frameId: "B" });
      const B = API.createElement({ type: "frame", id: "B", frameId: "A" });
      const rect = API.createElement({ type: "rectangle", id: "rect" });
      const D = API.createElement({
        type: "rectangle",
        id: "D",
        frameId: "rect",
      });

      const restored = arrayToMap(
        restoreElements([A, B, rect, D], null, { repairBindings: true }),
      );

      const frameIds = [restored.get("A")!.frameId, restored.get("B")!.frameId];
      // one of the two is cut, the other kept
      expect(frameIds.filter((id) => id === null).length).toBe(1);
      expect(restored.get("D")!.frameId).toBe(null);
    });

    it("converts skeleton frames listing frames as children", () => {
      const elements = convertToExcalidrawElements([
        {
          type: "rectangle",
          id: "rect",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        },
        { type: "frame", id: "outer", children: ["inner"] },
        { type: "frame", id: "inner", children: ["rect"] },
      ]);
      const byId = arrayToMap(elements);
      const inner = elements.find(
        (element) => element.type === "frame" && element.frameId,
      )!;
      const outer = byId.get(inner.frameId!)!;
      const rect = elements.find((element) => element.type === "rectangle")!;

      expect(rect.frameId).toBe(inner.id);
      // sized around the inner frame, which is sized around the rectangle
      expect(inner.width).toBe(120);
      expect(outer.width).toBe(140);
      expect(ids(elements)).toEqual([rect.id, inner.id, outer.id]);
    });
  });
});
