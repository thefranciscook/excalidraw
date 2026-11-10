// SVG -> editable Excalidraw element skeletons, for the ops page (ops.ts).
// The SVG is laid out (hidden) in the page, so the browser resolves CSS,
// transforms, units and text boxes; each shape becomes a rectangle, ellipse,
// line, polygon (a closed line) or text. Curves are flattened (vector.ts).
import {
  ellipsePath,
  flattenPath,
  isAxisAligned,
  lineSkeleton,
  matrixScale,
  rectPath,
  applyMatrix,
} from "./vector";

import type { Matrix, Pt, Subpath } from "./vector";

type Json = Record<string, any>;

export class SvgError extends Error {}

export const MAX_SVG_ELEMENTS = 1500;
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const NOT_DRAWN =
  "defs, clipPath, mask, symbol, marker, pattern, linearGradient, radialGradient, filter";
const UNSAFE = "script, foreignObject, iframe, object, embed, audio, video";

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

/** a computed CSS color -> {hex, alpha}, or null for none/transparent */
const parseColor = (value: string): { hex: string; alpha: number } | null => {
  const m = value.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/,
  );
  if (!m) {
    return null;
  }
  let alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (m[4]?.endsWith("%")) {
    alpha /= 100;
  }
  if (!alpha) {
    return null;
  }
  return { hex: `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}`, alpha };
};

const toMatrix = (m: DOMMatrix | SVGMatrix): Matrix => ({
  a: m.a,
  b: m.b,
  c: m.c,
  d: m.d,
  e: m.e,
  f: m.f,
});

const multiply = (m: Matrix, n: Matrix): Matrix => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});

const fontFamilyFor = (css: string) => {
  const f = css.toLowerCase();
  if (/mono|courier|consol|code/.test(f)) {
    return 3; // Cascadia
  }
  if (/comic/.test(f)) {
    return 8; // Comic Shanns
  }
  if (/nunito/.test(f)) {
    return 6;
  }
  if (/lilita/.test(f)) {
    return 7;
  }
  if (/virgil|excalifont|hand/.test(f)) {
    return 5;
  }
  return 9; // Liberation Sans, metric-compatible with Arial/Helvetica
};

// does one outline lie inside another (a hole, as in the letter O)?
const hasNested = (subpaths: Subpath[]) => {
  const boxes = subpaths.map(({ points }) => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  return boxes.some((a, i) =>
    boxes.some(
      (b, j) =>
        i !== j && a[0] > b[0] && a[1] > b[1] && a[2] < b[2] && a[3] < b[3],
    ),
  );
};

/** the viewBox (or size) of an <svg> root, from its attributes */
const viewBoxOf = (root: Element) => {
  const vb = (root.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    return { x: vb[0], y: vb[1], width: vb[2], height: vb[3] };
  }
  const len = (name: string) => {
    const v = root.getAttribute(name) || "";
    return /^\s*[\d.]+(px)?\s*$/.test(v) ? parseFloat(v) : NaN;
  };
  const width = len("width");
  const height = len("height");
  return Number.isFinite(width) && Number.isFinite(height)
    ? { x: 0, y: 0, width, height }
    : null;
};

const hrefOf = (el: Element) =>
  el.getAttribute("href") || el.getAttributeNS(XLINK_NS, "href") || "";

/** <use> elements replaced by copies of what they show, so they get drawn */
const expandUses = (svg: SVGSVGElement, warnings: Set<string>) => {
  for (let round = 0; round < 6; round++) {
    const uses = [...svg.querySelectorAll("use")];
    if (!uses.length) {
      return;
    }
    for (const use of uses) {
      const href = hrefOf(use);
      const target = href.startsWith("#")
        ? svg.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)
        : null;
      const g = svg.ownerDocument.createElementNS(SVG_NS, "g");
      for (const attr of [...use.attributes]) {
        if (
          !["href", "x", "y", "width", "height", "id"].includes(attr.localName)
        ) {
          g.setAttribute(attr.name, attr.value);
        }
      }
      const x = parseFloat(use.getAttribute("x") || "0") || 0;
      const y = parseFloat(use.getAttribute("y") || "0") || 0;
      g.setAttribute(
        "transform",
        `${use.getAttribute("transform") || ""} translate(${x} ${y})`,
      );
      if (target && !target.contains(use)) {
        if (target.localName === "symbol") {
          const inner = svg.ownerDocument.createElementNS(SVG_NS, "svg");
          for (const name of ["viewBox", "preserveAspectRatio"]) {
            const v = target.getAttribute(name);
            if (v) {
              inner.setAttribute(name, v);
            }
          }
          inner.setAttribute("width", use.getAttribute("width") || "100%");
          inner.setAttribute("height", use.getAttribute("height") || "100%");
          inner.setAttribute("overflow", "visible");
          for (const child of [...target.childNodes]) {
            inner.appendChild(child.cloneNode(true));
          }
          g.appendChild(inner);
        } else {
          const copy = target.cloneNode(true) as Element;
          copy.removeAttribute("id");
          g.appendChild(copy);
        }
      } else if (href) {
        warnings.add(`A <use> pointing at "${href.slice(0, 60)}" was skipped.`);
      }
      use.replaceWith(g);
    }
  }
};

/**
 * SVG markup -> element skeletons in board units, with (0,0) at the top-left
 * of the SVG's viewBox. `width`/`height` scale it to fit (aspect kept).
 */
export const svgToSkeletons = (
  markup: string,
  opts: { width?: number; height?: number; roughness?: number },
  doc: Document = document,
): { skeletons: Json[]; warnings: string[]; width: number; height: number } => {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const error = parsed.querySelector("parsererror");
  const root = parsed.documentElement;
  if (error || !root || root.localName !== "svg") {
    // Chromium wraps the parser's message in words about "this page"
    const detail = (error?.textContent || "").match(
      /error on line.*?(?=Below is a rendering|$)/i,
    );
    throw new SvgError(
      `That isn't valid SVG${
        detail ? ` (${detail[0].trim().slice(0, 160)})` : ""
      }.`,
    );
  }
  const warnings = new Set<string>();

  // nothing in it may run or load anything
  const images = root.querySelectorAll("image").length;
  if (images) {
    warnings.add(
      `${images} embedded bitmap image(s) in the SVG were left out; add them as image elements.`,
    );
  }
  root.querySelectorAll(`${UNSAFE}, image`).forEach((el) => el.remove());
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      const value = attr.value.trim().toLowerCase();
      if (
        attr.localName.startsWith("on") ||
        (attr.localName === "href" && !value.startsWith("#")) ||
        /^\s*(?:java|vb)script\s*:/.test(value)
      ) {
        el.removeAttributeNode(attr);
      }
    }
  }

  const host = doc.createElement("div");
  host.setAttribute(
    "style",
    "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none",
  );
  const svg = doc.importNode(root, true) as unknown as SVGSVGElement;
  host.appendChild(svg);
  doc.body.appendChild(host);
  try {
    let box = viewBoxOf(root);
    if (box) {
      svg.setAttribute("width", String(box.width));
      svg.setAttribute("height", String(box.height));
    }
    expandUses(svg, warnings);
    if (!box) {
      const b = svg.getBBox();
      box = { x: b.x, y: b.y, width: b.width || 1, height: b.height || 1 };
    }

    // root user units -> board units, (0,0) at the viewBox's top-left
    let scale = 1;
    if (opts.width && opts.height) {
      scale = Math.min(opts.width / box.width, opts.height / box.height);
    } else if (opts.width) {
      scale = opts.width / box.width;
    } else if (opts.height) {
      scale = opts.height / box.height;
    }
    const place: Matrix = {
      a: scale,
      b: 0,
      c: 0,
      d: scale,
      e: -box.x * scale,
      f: -box.y * scale,
    };
    const rootScreen = svg.getScreenCTM();
    if (!rootScreen) {
      throw new SvgError("The SVG couldn't be laid out.");
    }
    const toRoot = toMatrix(rootScreen.inverse());
    const matrixOf = (el: SVGGraphicsElement) => {
      const m = el.getScreenCTM();
      return m ? multiply(place, multiply(toRoot, toMatrix(m))) : null;
    };

    const view = doc.defaultView!;
    const shown = (el: Element) => {
      for (let e: Element | null = el; e && e !== host; e = e.parentElement) {
        const cs = view.getComputedStyle(e);
        if (cs.display === "none") {
          return false;
        }
      }
      return view.getComputedStyle(el).visibility !== "hidden";
    };
    const opacityOf = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e && e !== host; e = e.parentElement) {
        o *= parseFloat(view.getComputedStyle(e).opacity) || 0;
      }
      return o;
    };
    // a gradient stands in as the average of its colors
    const paint = (value: string) => {
      const url = value.match(/url\(\s*["']?#([^"')]+)["']?\s*\)/);
      if (url) {
        const target = svg.querySelector(`[id="${CSS.escape(url[1])}"]`);
        const stops = target ? [...target.querySelectorAll("stop")] : [];
        if (!stops.length) {
          const fallback = value.replace(/url\([^)]*\)/, "").trim();
          return fallback ? parseColor(fallback) : null;
        }
        warnings.add(
          "Gradients are drawn in one solid color, the average of their colors.",
        );
        let [r, g, b, a, count] = [0, 0, 0, 0, 0];
        for (const stop of stops) {
          const cs = view.getComputedStyle(stop);
          const c = parseColor(cs.stopColor);
          if (c) {
            r += parseInt(c.hex.slice(1, 3), 16);
            g += parseInt(c.hex.slice(3, 5), 16);
            b += parseInt(c.hex.slice(5, 7), 16);
            a += c.alpha * (parseFloat(cs.stopOpacity) || 0);
            count++;
          }
        }
        return count
          ? {
              hex: `#${hex2(r / count)}${hex2(g / count)}${hex2(b / count)}`,
              alpha: a / count,
            }
          : null;
      }
      return parseColor(value);
    };

    const skeletons: Json[] = [];
    let holes = false;
    const shapes = svg.querySelectorAll<SVGGraphicsElement>(
      "rect, circle, ellipse, line, polyline, polygon, path, text",
    );
    for (const el of shapes) {
      if (skeletons.length >= MAX_SVG_ELEMENTS) {
        warnings.add(
          `The SVG has more than ${MAX_SVG_ELEMENTS} shapes; only the first ${MAX_SVG_ELEMENTS} were imported.`,
        );
        break;
      }
      if (el.closest(NOT_DRAWN) || !shown(el)) {
        continue;
      }
      const m = matrixOf(el);
      if (!m) {
        continue;
      }
      const cs = view.getComputedStyle(el);
      const opacity = opacityOf(el);
      const k = matrixScale(m);

      if (el.localName === "text") {
        const fill = paint(cs.fill);
        const content = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!content || !fill) {
          continue;
        }
        const tspans = [...el.querySelectorAll("tspan[y], tspan[dy]")];
        const text =
          tspans.length > 1
            ? tspans
                .map((t) => (t.textContent || "").replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .join("\n")
            : content;
        const b = el.getBBox();
        const corners = [
          applyMatrix(m, [b.x, b.y]),
          applyMatrix(m, [b.x + b.width, b.y]),
          applyMatrix(m, [b.x, b.y + b.height]),
          applyMatrix(m, [b.x + b.width, b.y + b.height]),
        ];
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        const anchor = cs.textAnchor;
        const textAlign =
          anchor === "middle" ? "center" : anchor === "end" ? "right" : "left";
        const angle = Math.atan2(m.b, m.a);
        const rotated = Math.abs(angle) > 1e-3;
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const cx = (left + right) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const fontSize = Math.max(1, (parseFloat(cs.fontSize) || 16) * k);
        const weight = parseInt(cs.fontWeight, 10) || 400;
        skeletons.push({
          type: "text",
          text,
          fontSize: Math.round(fontSize * 10) / 10,
          fontFamily: fontFamilyFor(cs.fontFamily),
          textAlign: rotated ? "center" : textAlign,
          verticalAlign: rotated ? "middle" : "top",
          x: rotated
            ? cx
            : textAlign === "center"
            ? cx
            : textAlign === "right"
            ? right
            : left,
          y: rotated ? cy : Math.min(...ys),
          ...(rotated ? { angle: (angle + 2 * Math.PI) % (2 * Math.PI) } : {}),
          strokeColor: fill.hex,
          opacity: Math.round(
            opacity * fill.alpha * (parseFloat(cs.fillOpacity) || 0) * 100,
          ),
          ...(weight >= 600 ? { bold: true } : {}),
          ...(/italic|oblique/.test(cs.fontStyle) ? { italic: true } : {}),
          ...(/underline/.test(cs.textDecorationLine)
            ? { underline: true }
            : {}),
        });
        continue;
      }

      const fill = el.localName === "line" ? null : paint(cs.fill);
      const stroke = paint(cs.stroke);
      if (!fill && !stroke) {
        continue;
      }
      const fillOpacity = fill
        ? fill.alpha * (parseFloat(cs.fillOpacity) || 0)
        : 0;
      const strokeOpacity = stroke
        ? stroke.alpha * (parseFloat(cs.strokeOpacity) || 0)
        : 0;
      const strokeWidth = stroke
        ? Math.max(0.1, (parseFloat(cs.strokeWidth) || 1) * k)
        : 1;
      const dash = (cs.strokeDasharray || "none")
        .split(/[\s,]+/)
        .map(parseFloat)
        .filter((n) => n > 0);
      const style: Json = {
        strokeColor: stroke ? stroke.hex : "transparent",
        backgroundColor: fill ? fill.hex : "transparent",
        fillStyle: "solid",
        strokeWidth: Math.round(strokeWidth * 100) / 100,
        strokeStyle:
          !stroke || !dash.length
            ? "solid"
            : dash[0] * k <= strokeWidth * 1.5
            ? "dotted"
            : "dashed",
        roughness: opts.roughness ?? 0,
        opacity: Math.round(
          opacity * (fill ? fillOpacity : strokeOpacity) * 100,
        ),
      };
      if (style.opacity <= 0) {
        continue;
      }

      const len = (v: SVGAnimatedLength) => v.baseVal.value;
      let pathData: string | null = null;
      let polyline: { points: Pt[]; closed: boolean } | null = null;
      switch (el.localName) {
        case "rect": {
          const r = el as SVGRectElement;
          const [x, y, w, h] = [
            len(r.x),
            len(r.y),
            len(r.width),
            len(r.height),
          ];
          if (w <= 0 || h <= 0) {
            break;
          }
          const rx = len(r.rx) || len(r.ry);
          // Excalidraw rounds corners up to a quarter of the shorter side
          if (
            isAxisAligned(m) &&
            rx * m.a <= Math.min(w * m.a, h * m.d) / 4 + 0.5
          ) {
            const [x0, y0] = applyMatrix(m, [x, y]);
            skeletons.push({
              type: "rectangle",
              x: x0,
              y: y0,
              width: w * m.a,
              height: h * m.d,
              ...(rx ? { cornerRadius: rx * m.a } : { roundness: "sharp" }),
              ...style,
            });
          } else {
            pathData = rectPath(x, y, w, h, len(r.rx), len(r.ry));
          }
          break;
        }
        case "circle":
        case "ellipse": {
          const e = el as SVGCircleElement & SVGEllipseElement;
          const cx = len(e.cx);
          const cy = len(e.cy);
          const rx = el.localName === "circle" ? len(e.r) : len(e.rx);
          const ry = el.localName === "circle" ? len(e.r) : len(e.ry);
          if (rx <= 0 || ry <= 0) {
            break;
          }
          if (isAxisAligned(m)) {
            const [x0, y0] = applyMatrix(m, [cx - rx, cy - ry]);
            skeletons.push({
              type: "ellipse",
              x: x0,
              y: y0,
              width: 2 * rx * m.a,
              height: 2 * ry * m.d,
              ...style,
            });
          } else {
            pathData = ellipsePath(cx, cy, rx, ry);
          }
          break;
        }
        case "line": {
          const l = el as SVGLineElement;
          polyline = {
            points: [
              [len(l.x1), len(l.y1)],
              [len(l.x2), len(l.y2)],
            ],
            closed: false,
          };
          break;
        }
        case "polyline":
        case "polygon": {
          const p = el as SVGPolygonElement;
          polyline = {
            points: [...p.points].map((pt): Pt => [pt.x, pt.y]),
            closed: el.localName === "polygon" || !!fill,
          };
          break;
        }
        case "path":
          pathData = el.getAttribute("d");
          break;
      }

      const subpaths: Subpath[] = polyline ? [polyline] : [];
      if (pathData) {
        try {
          subpaths.push(...flattenPath(pathData, k));
        } catch (e) {
          warnings.add(
            `A path was skipped: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (fill && subpaths.length > 1 && hasNested(subpaths)) {
        holes = true;
      }
      for (const sub of subpaths) {
        const line = lineSkeleton(
          sub.points.map((p) => applyMatrix(m, p)),
          sub.closed || !!fill,
        );
        if (line) {
          skeletons.push({ ...line, ...style });
        }
      }
    }
    if (holes) {
      warnings.add(
        "Shapes made of several outlines (letters like O, rings, cut-outs) are drawn with each outline filled, so holes come out filled.",
      );
    }
    if (!skeletons.length) {
      warnings.add("The SVG has nothing that could be drawn.");
    }
    return {
      skeletons,
      warnings: [...warnings],
      width: box.width * scale,
      height: box.height * scale,
    };
  } finally {
    host.remove();
  }
};
