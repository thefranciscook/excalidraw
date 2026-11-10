// part of the repo's vitest suite (yarn test)
import {
  flattenPath,
  lineSkeleton,
  parsePath,
  PathError,
  rectPath,
  simplify,
} from "../render/vector";

import type { Pt } from "../render/vector";

const close = (p: Pt, q: Pt) => {
  expect(p[0]).toBeCloseTo(q[0], 6);
  expect(p[1]).toBeCloseTo(q[1], 6);
};

describe("parsePath", () => {
  it("reads commands, compact numbers and arc flags", () => {
    expect(parsePath("M0,0L10-5.5.5e1 3a5 5 0 015 5z")).toEqual([
      { cmd: "M", args: [0, 0] },
      { cmd: "L", args: [10, -5.5] },
      { cmd: "L", args: [5, 3] },
      { cmd: "a", args: [5, 5, 0, 0, 1, 5, 5] },
      { cmd: "z", args: [] },
    ]);
  });

  it("says what's wrong with bad path data", () => {
    expect(() => parsePath("L 1 2")).toThrow(PathError);
    expect(() => parsePath("M 1")).toThrow(/needs 2 numbers/);
    expect(() => parsePath("M 0 0 X 3")).toThrow(/Unknown path command/);
  });
});

describe("flattenPath", () => {
  it("keeps straight segments as they are, relative ones too", () => {
    const [sub] = flattenPath("m10 10 h20 v20 l-20 0 z");
    expect(sub.closed).toBe(true);
    expect(sub.points).toEqual([
      [10, 10],
      [30, 10],
      [30, 30],
      [10, 30],
    ]);
  });

  it("splits subpaths at M and after Z", () => {
    const subs = flattenPath("M0 0 L10 0 L10 10 Z L0 10 M50 50 L60 60");
    expect(subs.map((s) => s.closed)).toEqual([true, false, false]);
    // drawing on after Z starts where the closed subpath began
    expect(subs[1].points).toEqual([
      [0, 0],
      [0, 10],
    ]);
  });

  it("ends curves exactly at their end points, smoothly in between", () => {
    const [sub] = flattenPath("M0 0 C 0 100, 100 100, 100 0 S 200 -100, 200 0");
    close(sub.points[sub.points.length - 1], [200, 0]);
    expect(sub.points.length).toBeGreaterThan(20);
    // the curve's top: a cubic with both controls at y=100 peaks at 75
    const top = Math.max(...sub.points.map((p) => p[1]));
    expect(top).toBeCloseTo(75, 0);
    // S mirrors the last control point: the second half dips as far
    const bottom = Math.min(...sub.points.map((p) => p[1]));
    expect(bottom).toBeCloseTo(-75, 0);
  });

  it("draws arcs on their circle", () => {
    const [sub] = flattenPath("M0 50 A 50 50 0 0 1 100 50");
    close(sub.points[sub.points.length - 1], [100, 50]);
    for (const [x, y] of sub.points) {
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50, 6);
      expect(y).toBeLessThanOrEqual(50 + 1e-9); // sweep 1: over the top
    }
  });

  it("samples more finely when drawn larger", () => {
    const d = "M0 0 Q 50 50 100 0";
    expect(flattenPath(d, 4)[0].points.length).toBeGreaterThan(
      flattenPath(d, 1)[0].points.length,
    );
  });

  it("outlines rounded rectangles", () => {
    const [sub] = flattenPath(rectPath(0, 0, 100, 40, 10));
    expect(sub.closed).toBe(true);
    const xs = sub.points.map((p) => p[0]);
    const ys = sub.points.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 100]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([0, 40]);
  });
});

describe("lineSkeleton", () => {
  it("is a polygon when closed, starting at its first point", () => {
    const line = lineSkeleton(
      [
        [10, 20],
        [110, 20],
        [60, 100],
      ],
      true,
    )!;
    expect(line).toMatchObject({
      type: "line",
      x: 10,
      y: 20,
      polygon: true,
      width: 100,
      height: 80,
    });
    expect(line.points).toEqual([
      [0, 0],
      [100, 0],
      [50, 80],
      [0, 0],
    ]);
  });

  it("drops repeated and collinear points, and is null for a dot", () => {
    const line = lineSkeleton(
      [
        [0, 0],
        [0, 0],
        [5, 0],
        [10, 0],
      ],
      false,
    )!;
    expect(line.points).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(line.polygon).toBe(false);
    expect(lineSkeleton([[3, 3]], false)).toBeNull();
  });
});

it("simplify keeps corners", () => {
  expect(
    simplify(
      [
        [0, 0],
        [5, 0.1],
        [10, 0],
        [10, 10],
      ],
      0.25,
    ),
  ).toEqual([
    [0, 0],
    [10, 0],
    [10, 10],
  ]);
});
