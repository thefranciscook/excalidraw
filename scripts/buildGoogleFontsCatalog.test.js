const { mergeCatalog } = require("./buildGoogleFontsCatalog");

const meta = (family, category, popularity, extra = {}) => ({
  family,
  category,
  popularity,
  fonts: { 400: { lineHeight: 1.2 } },
  ...extra,
});

describe("buildGoogleFontsCatalog", () => {
  it("keeps existing indices, appends new families and flags removed ones", () => {
    const existing = [
      ["Roboto", "s", 1, 1.2],
      ["Gone Font", "h", 5, 1.3],
      ["Lobster", "d", 3, 1.2],
    ];

    const fonts = mergeCatalog(existing, [
      // reordered & with new entries
      meta("Brand New", "Serif", 2),
      meta("Lobster", "Display", 4),
      meta("Material Symbols Outlined", "Sans Serif", 1),
      meta("No Regular", "Serif", 6, { fonts: { 700: {} } }),
      meta("Roboto", "Sans Serif", 1, { fonts: { 400: { lineHeight: 3 } } }),
    ]);

    expect(fonts).toEqual([
      ["Roboto", "s", 1, 1.5],
      ["Gone Font", "h", 0, 1.3, 1],
      ["Lobster", "d", 3, 1.2],
      ["Brand New", "r", 2, 1.2],
    ]);
  });

  it("is idempotent", () => {
    const list = [meta("A", "Serif", 2), meta("B", "Monospace", 1)];
    const first = mergeCatalog([], list);

    expect(first.map(([family]) => family)).toEqual(["B", "A"]);
    expect(mergeCatalog(first, list)).toEqual(first);
  });
});
