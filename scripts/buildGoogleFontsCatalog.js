/**
 * Generates `packages/excalidraw/fonts/GoogleFonts/catalog.json`, the list of
 * Google Fonts families offered in the font picker.
 *
 * Font family ids stored in drawings are derived from the index in this
 * catalog (`GOOGLE_FONTS_ID_OFFSET + index`), so the catalog is APPEND-ONLY:
 * existing entries never move, new families get appended, and families
 * removed from Google Fonts stay in the list (flagged as removed) so that
 * existing drawings keep resolving.
 *
 * Run manually (not part of the build):
 *   node scripts/buildGoogleFontsCatalog.js
 */
const fs = require("fs");
const path = require("path");

const METADATA_URL = "https://fonts.google.com/metadata/fonts";

const CATALOG_PATH = path.resolve(
  __dirname,
  "../packages/excalidraw/fonts/GoogleFonts/catalog.json",
);

/** Google Fonts category -> compact catalog code */
const CATEGORY_CODES = {
  "Sans Serif": "s",
  Serif: "r",
  Display: "d",
  Handwriting: "h",
  Monospace: "m",
};

/** families that aren't meant for text (icon fonts and such) */
const isExcludedFamily = (family) =>
  /^Material (Icons|Symbols)/.test(family) ||
  /^Noto (Color )?Emoji/.test(family);

const clampLineHeight = (lineHeight) => {
  if (typeof lineHeight !== "number" || !Number.isFinite(lineHeight)) {
    return 1.25;
  }
  return Math.round(Math.min(Math.max(lineHeight, 1.15), 1.5) * 100) / 100;
};

/**
 * Merges the latest Google Fonts metadata into the existing catalog,
 * preserving the index of every existing entry.
 *
 * Entry format: [family, categoryCode, popularityRank, lineHeight, removed?]
 *
 * @param {Array} existingFonts entries of the current catalog
 * @param {Array} familyMetadataList `familyMetadataList` from the metadata endpoint
 */
const mergeCatalog = (existingFonts, familyMetadataList) => {
  const available = familyMetadataList.filter(
    (meta) =>
      meta &&
      typeof meta.family === "string" &&
      CATEGORY_CODES[meta.category] &&
      meta.fonts &&
      meta.fonts["400"] &&
      !isExcludedFamily(meta.family),
  );

  // popularity is 1-based, lower is more popular
  const byPopularity = [...available].sort(
    (a, b) => (a.popularity ?? Infinity) - (b.popularity ?? Infinity),
  );
  const popularityRank = new Map(
    byPopularity.map((meta, index) => [meta.family, index + 1]),
  );

  const toEntry = (meta) => [
    meta.family,
    CATEGORY_CODES[meta.category],
    popularityRank.get(meta.family),
    clampLineHeight(meta.fonts["400"].lineHeight),
  ];

  const availableByFamily = new Map(
    available.map((meta) => [meta.family, meta]),
  );
  const seen = new Set();

  const fonts = existingFonts.map((entry) => {
    const [family] = entry;
    seen.add(family);
    const meta = availableByFamily.get(family);
    if (meta) {
      return toEntry(meta);
    }
    // keep removed families (with their last known data) so ids stay stable
    return [entry[0], entry[1], 0, entry[3], 1];
  });

  // append new families, most popular first, for a deterministic order
  for (const meta of byPopularity) {
    if (!seen.has(meta.family)) {
      seen.add(meta.family);
      fonts.push(toEntry(meta));
    }
  }

  return fonts;
};

const run = async () => {
  const existing = fs.existsSync(CATALOG_PATH)
    ? JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"))
    : { version: 1, fonts: [] };

  const response = await fetch(METADATA_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${METADATA_URL}: ${response.status}`);
  }
  // the endpoint may prefix the payload with an XSSI guard
  const text = (await response.text()).replace(/^\)\]\}'\s*/, "");
  const { familyMetadataList } = JSON.parse(text);

  const fonts = mergeCatalog(existing.fonts, familyMetadataList);

  // one entry per line, to keep diffs readable
  const json = `{\n  "version": 1,\n  "fonts": [\n${fonts
    .map((entry) => `    [${entry.map((v) => JSON.stringify(v)).join(", ")}]`)
    .join(",\n")}\n  ]\n}\n`;

  fs.writeFileSync(CATALOG_PATH, json);

  const added = fonts.length - existing.fonts.length;
  const removed = fonts.filter((entry) => entry[4]).length;
  console.info(
    `Wrote ${fonts.length} families to ${path.relative(
      process.cwd(),
      CATALOG_PATH,
    )} (${added} added, ${removed} flagged as removed).`,
  );
};

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { mergeCatalog };
