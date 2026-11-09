// part of the repo's vitest suite (yarn test)
import assert from "node:assert/strict";

import createBoards from "../mcp/boards";
import { foldChanges } from "../scene";

const board = {
  id: "abcdefghij",
  name: "Test",
  elements: [
    {
      id: "f",
      type: "frame",
      name: "Flow",
      x: 100,
      y: 100,
      width: 500,
      height: 300,
    },
    {
      id: "a",
      type: "rectangle",
      x: 140,
      y: 150,
      width: 120,
      height: 60,
      frameId: "f",
      backgroundColor: "#a5d8ff",
      boundElements: [{ type: "text", id: "a-label" }],
    },
    {
      id: "a-label",
      type: "text",
      text: "API",
      originalText: "API",
      containerId: "a",
      x: 180,
      y: 170,
      width: 30,
      height: 20,
      frameId: "f",
    },
    {
      id: "gone",
      type: "ellipse",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      isDeleted: true,
    },
  ],
};
const boards = createBoards({
  readBoard: () => board,
  listBoardIds: () => [board.id],
  publicUrl: "https://wb.test",
});

test("changes are described with ids, frame-relative positions and authors", () => {
  const folded = foldChanges([
    {
      rev: 2,
      author: "human",
      changes: [
        { id: "a-label", type: "text", op: "update" },
        { id: "gone", type: "ellipse", op: "delete" },
      ],
    },
    {
      rev: 3,
      author: "claude",
      changes: [{ id: "a", type: "rectangle", op: "update" }],
    },
  ]);
  const { lines, ids } = boards.changesText(board, folded);
  // a label's change is reported as its box's
  assert.deepEqual(lines, [
    '- changed box "API" (id a, at 40,50, 120×60, in frame "Flow", fill #a5d8ff), by the user and Claude, in another chat',
    "- deleted ellipse (id gone), by the user",
  ]);
  assert.deepEqual(ids, ["a"]);
});

test("frame summaries list shapes with ids for editing", () => {
  const found = boards.getFrame("abcdefghij", "Flow");
  const text = boards.summaryText({
    ...found,
    render: { error: "no browser" },
  });
  assert.match(
    text,
    /- box "API" \(id a, at 40,50, 120×60, in frame "Flow", fill #a5d8ff\)/,
  );
  assert.match(
    text,
    /- "API" \(id a-label, at 80,70, 30×20, 0px, label of a\)/,
  );
});
