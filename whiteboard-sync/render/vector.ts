// Vector geometry for the ops page (render/ops.ts): SVG path data flattened
// into polylines, which Excalidraw draws as `line` elements (closed ones as
// filled polygons). No DOM here, so it's tested on its own (test/vector.test.ts).

export type Pt = [number, number];
export type Subpath = { points: Pt[]; closed: boolean };
// an affine transform, as in SVG: x' = a*x + c*y + e, y' = b*x + d*y + f
export type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const applyMatrix = (m: Matrix, [x, y]: Pt): Pt => [
  m.a * x + m.c * y + m.e,
  m.b * x + m.d * y + m.f,
];

/** how much the transform scales lengths, on average */
export const matrixScale = (m: Matrix) =>
  Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;

/** only scales (positively) and translates: boxes stay boxes */
export const isAxisAligned = (m: Matrix) =>
  Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && m.a > 0 && m.d > 0;

export class PathError extends Error {}

const ARITY: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};
const NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

export type PathCommand = { cmd: string; args: number[] };

/** SVG path data -> its commands, as written (relative ones stay relative) */
export const parsePath = (d: string): PathCommand[] => {
  const out: PathCommand[] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) {
      i++;
    }
  };
  const number = () => {
    skip();
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(d);
    if (!m) {
      return null;
    }
    i = NUMBER_RE.lastIndex;
    return parseFloat(m[0]);
  };
  // arc flags may be written without separators: "a5 5 0 015 5"
  const flag = () => {
    skip();
    if (d[i] === "0" || d[i] === "1") {
      return Number(d[i++]);
    }
    return null;
  };
  let cmd: string | null = null;
  for (;;) {
    skip();
    if (i >= d.length) {
      break;
    }
    if (/[a-zA-Z]/.test(d[i])) {
      cmd = d[i++];
      if (!(cmd.toLowerCase() in ARITY)) {
        throw new PathError(`Unknown path command "${cmd}".`);
      }
      if (cmd === "z" || cmd === "Z") {
        out.push({ cmd, args: [] });
        continue;
      }
    } else if (!cmd || cmd === "z" || cmd === "Z") {
      throw new PathError(
        `Path data must start with a command (M, L, C, …), at "${d
          .slice(i, i + 12)
          .trim()}".`,
      );
    }
    const lower = cmd.toLowerCase();
    const args: number[] = [];
    for (let k = 0; k < ARITY[lower]; k++) {
      const v = lower === "a" && (k === 3 || k === 4) ? flag() : number();
      if (v === null || !Number.isFinite(v)) {
        throw new PathError(
          `Path command "${cmd}" needs ${ARITY[lower]} numbers${
            i < d.length ? `, at "${d.slice(i, i + 12).trim()}"` : ""
          }.`,
        );
      }
      args.push(v);
    }
    out.push({ cmd, args });
    // more coordinates after a move are line-tos
    if (cmd === "M") {
      cmd = "L";
    } else if (cmd === "m") {
      cmd = "l";
    }
  }
  if (out.length && out[0].cmd.toLowerCase() !== "m") {
    throw new PathError("Path data must start with M (move to).");
  }
  return out;
};

const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);

// segments per curve: about one every 3px at the size it's drawn
const steps = (length: number, scale: number) =>
  Math.max(2, Math.min(96, Math.ceil((length * scale) / 3)));

const cubic = (p0: Pt, c1: Pt, c2: Pt, p: Pt, scale: number): Pt[] => {
  const n = steps(dist(p0, c1) + dist(c1, c2) + dist(c2, p), scale);
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] +
        3 * u * u * t * c1[0] +
        3 * u * t * t * c2[0] +
        t * t * t * p[0],
      u * u * u * p0[1] +
        3 * u * u * t * c1[1] +
        3 * u * t * t * c2[1] +
        t * t * t * p[1],
    ]);
  }
  return out;
};

const quadratic = (p0: Pt, c: Pt, p: Pt, scale: number): Pt[] => {
  const n = steps(dist(p0, c) + dist(c, p), scale);
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * c[0] + t * t * p[0],
      u * u * p0[1] + 2 * u * t * c[1] + t * t * p[1],
    ]);
  }
  return out;
};

// SVG's endpoint arc, through its center parametrization (SVG 1.1, F.6.5)
const arc = (
  p0: Pt,
  rxIn: number,
  ryIn: number,
  rotation: number,
  largeArc: number,
  sweep: number,
  p: Pt,
  scale: number,
): Pt[] => {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry || (p0[0] === p[0] && p0[1] === p[1])) {
    return [p];
  }
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p[0]) / 2;
  const dy = (p0[1] - p[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef =
    (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angle(
    (x1 - cx1) / rx,
    (y1 - cy1) / ry,
    (-x1 - cx1) / rx,
    (-y1 - cy1) / ry,
  );
  if (!sweep && dt > 0) {
    dt -= 2 * Math.PI;
  } else if (sweep && dt < 0) {
    dt += 2 * Math.PI;
  }
  const n = steps(Math.abs(dt) * Math.max(rx, ry), scale);
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    out.push([
      cos * rx * Math.cos(t) - sin * ry * Math.sin(t) + cx,
      sin * rx * Math.cos(t) + cos * ry * Math.sin(t) + cy,
    ]);
  }
  out[out.length - 1] = p;
  return out;
};

/**
 * SVG path data -> polylines, one per subpath, in the path's own units.
 * `scale` is how large it will be drawn (px per unit), for curve smoothness.
 */
export const flattenPath = (d: string, scale = 1): Subpath[] => {
  const subpaths: Subpath[] = [];
  let current: Pt[] = [];
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  // the last control point, for the smooth curves (S and T)
  let lastCubic: Pt | null = null;
  let lastQuad: Pt | null = null;
  const finish = (closed: boolean) => {
    if (current.length > 1) {
      subpaths.push({ points: current, closed });
    }
    current = [];
  };

  for (const { cmd, args } of parsePath(d)) {
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cur[0] : 0;
    const oy = rel ? cur[1] : 0;
    const at = (i: number): Pt => [args[i] + ox, args[i + 1] + oy];
    const upper = cmd.toUpperCase();
    // drawing after a Z (without an M) starts again where the subpath began
    if (upper !== "M" && upper !== "Z" && !current.length) {
      current = [cur];
    }
    let nextCubic: Pt | null = null;
    let nextQuad: Pt | null = null;
    switch (upper) {
      case "M":
        finish(false);
        cur = at(0);
        start = cur;
        current = [cur];
        break;
      case "L":
        cur = at(0);
        current.push(cur);
        break;
      case "H":
        cur = [args[0] + ox, cur[1]];
        current.push(cur);
        break;
      case "V":
        cur = [cur[0], args[0] + oy];
        current.push(cur);
        break;
      case "C": {
        const c1 = at(0);
        const c2 = at(2);
        const p = at(4);
        current.push(...cubic(cur, c1, c2, p, scale));
        nextCubic = c2;
        cur = p;
        break;
      }
      case "S": {
        const c1: Pt = lastCubic
          ? [2 * cur[0] - lastCubic[0], 2 * cur[1] - lastCubic[1]]
          : cur;
        const c2 = at(0);
        const p = at(2);
        current.push(...cubic(cur, c1, c2, p, scale));
        nextCubic = c2;
        cur = p;
        break;
      }
      case "Q": {
        const c = at(0);
        const p = at(2);
        current.push(...quadratic(cur, c, p, scale));
        nextQuad = c;
        cur = p;
        break;
      }
      case "T": {
        const c: Pt = lastQuad
          ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]]
          : cur;
        const p = at(0);
        current.push(...quadratic(cur, c, p, scale));
        nextQuad = c;
        cur = p;
        break;
      }
      case "A": {
        const p = at(5);
        current.push(
          ...arc(cur, args[0], args[1], args[2], args[3], args[4], p, scale),
        );
        cur = p;
        break;
      }
      case "Z":
        if (current.length) {
          finish(true);
        }
        cur = start;
        break;
    }
    lastCubic = nextCubic;
    lastQuad = nextQuad;
  }
  finish(false);
  return subpaths;
};

/** a rectangle's outline as path data, with SVG's rx/ry rounding */
export const rectPath = (
  x: number,
  y: number,
  w: number,
  h: number,
  rxIn = 0,
  ryIn = 0,
) => {
  const rx = Math.min(Math.abs(rxIn || ryIn), w / 2);
  const ry = Math.min(Math.abs(ryIn || rxIn), h / 2);
  if (!rx || !ry) {
    return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  }
  return [
    `M${x + rx} ${y}H${x + w - rx}`,
    `A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}`,
    `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}`,
    `A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}`,
    `A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`,
  ].join("");
};

export const ellipsePath = (cx: number, cy: number, rx: number, ry: number) =>
  `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${
    cx - rx
  } ${cy}Z`;

// Ramer–Douglas–Peucker: drops points within `epsilon` of the line
export const simplify = (points: Pt[], epsilon: number): Pt[] => {
  if (points.length < 3) {
    return points;
  }
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = points[s];
    const [x2, y2] = points[e];
    const len = Math.hypot(x2 - x1, y2 - y1);
    let worst = -1;
    let worstDist = epsilon;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = points[i];
      const dd = len
        ? Math.abs((x2 - x1) * (y1 - y) - (x1 - x) * (y2 - y1)) / len
        : Math.hypot(x - x1, y - y1);
      if (dd > worstDist) {
        worst = i;
        worstDist = dd;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([s, worst], [worst, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
};

export const MAX_POINTS = 2000;

/**
 * A polyline in board coordinates as an Excalidraw `line` skeleton: x/y at
 * its first point, points relative to it; closed ones end where they start
 * and are polygons (filled with the background color).
 */
export const lineSkeleton = (pointsIn: Pt[], closed: boolean) => {
  let points = simplify(
    pointsIn.filter(
      (p, i) =>
        i === 0 || p[0] !== pointsIn[i - 1][0] || p[1] !== pointsIn[i - 1][1],
    ),
    0.25,
  );
  if (points.length > MAX_POINTS) {
    const every = Math.ceil(points.length / MAX_POINTS);
    points = points.filter(
      (_, i) => i % every === 0 || i === points.length - 1,
    );
  }
  if (points.length < 2) {
    return null;
  }
  const [x0, y0] = points[0];
  const last = points[points.length - 1];
  if (closed && (last[0] !== x0 || last[1] !== y0)) {
    points.push([x0, y0]);
  }
  const rel = points.map(([x, y]): Pt => [x - x0, y - y0]);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  return {
    type: "line",
    x: x0,
    y: y0,
    points: rel,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    polygon: closed && rel.length > 3,
    roundness: null,
  };
};
