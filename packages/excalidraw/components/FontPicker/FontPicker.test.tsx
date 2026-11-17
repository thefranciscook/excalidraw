import { FONT_FAMILY, GOOGLE_FONTS_ID_OFFSET, KEYS } from "@excalidraw/common";

import { Excalidraw } from "../..";
import { API } from "../../tests/helpers/api";
import { Keyboard } from "../../tests/helpers/ui";
import { act, fireEvent, render, waitFor } from "../../tests/test-utils";

const { h } = window;

(global as any).ResizeObserver =
  (global as any).ResizeObserver ||
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

describe("FontPicker", () => {
  it("should be able to open font picker", async () => {
    const { queryByTestId } = await render(
      <Excalidraw handleKeyboardGlobally={true} />,
    );

    Keyboard.keyPress(KEYS.T);

    const fontPickerTrigger = queryByTestId("font-family-show-fonts");

    expect(fontPickerTrigger).not.toBeNull();

    act(() => {
      fontPickerTrigger!.click();
    });
  });

  describe("top picks drag & drop", () => {
    const SLOT_SIZE = 32;
    const SLOT_SPAN = 40;

    // jsdom has no layout — lay the strip slots out horizontally, and
    // everything else (the list rows) well below the strip
    beforeEach(() => {
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        const index = this.dataset.topPickIndex;
        if (index != null) {
          return new DOMRect(
            Number(index) * SLOT_SPAN,
            0,
            SLOT_SIZE,
            SLOT_SIZE,
          );
        }
        if (this.classList.contains("top-picks-dnd")) {
          return new DOMRect(0, 0, SLOT_SPAN * 2 + SLOT_SIZE, SLOT_SIZE);
        }
        return new DOMRect(0, 300, SLOT_SIZE, SLOT_SIZE);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const slotCenter = (index: number) => ({
      clientX: index * SLOT_SPAN + SLOT_SIZE / 2,
      clientY: SLOT_SIZE / 2,
    });

    const drag = async (
      source: HTMLElement,
      from: { clientX: number; clientY: number },
      to: { clientX: number; clientY: number },
    ) => {
      fireEvent.pointerDown(source, { pointerId: 1, button: 0, ...from });
      // wait out the sloppy-click grace period
      await new Promise((resolve) => setTimeout(resolve, 120));
      fireEvent.pointerMove(window, { pointerId: 1, ...to });
      fireEvent.pointerUp(window, { pointerId: 1, ...to });
      // let the post-drop click suppression lapse
      await new Promise((resolve) => setTimeout(resolve, 120));
    };

    const getStripFamilies = (container: HTMLElement) =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          ".FontPicker__top-picks [data-top-pick-index]",
        ),
      ).map((button) => button.title);

    const openFontPicker = async () => {
      const utils = await render(<Excalidraw handleKeyboardGlobally={true} />);
      Keyboard.keyPress(KEYS.T);
      act(() => {
        utils.queryByTestId("font-family-show-fonts")!.click();
      });
      await waitFor(() =>
        expect(
          document.querySelector('.dropdown-menu.fonts [title="Lilita One"]'),
        ).not.toBeNull(),
      );
      return utils;
    };

    it("pins a font dragged from the list, replacing the hovered slot", async () => {
      const { container } = await openFontPicker();

      const row = document.querySelector<HTMLElement>(
        '.dropdown-menu.fonts [title="Lilita One"]',
      )!;
      await drag(row, { clientX: 16, clientY: 316 }, slotCenter(1));

      await waitFor(() =>
        expect(h.state.fontTopPicks).toEqual([
          FONT_FAMILY.Excalifont,
          FONT_FAMILY["Lilita One"],
          FONT_FAMILY["Comic Shanns"],
        ]),
      );
      expect(getStripFamilies(container)).toEqual([
        "Hand-drawn",
        "Lilita One",
        "Code",
      ]);
      // pinning doesn't pick the font
      expect(h.state.currentItemFontFamily).not.toBe(FONT_FAMILY["Lilita One"]);
    });

    it("refuses pinning an already pinned font", async () => {
      await openFontPicker();

      const row = document.querySelector<HTMLElement>(
        '.dropdown-menu.fonts [title="Nunito"]',
      )!;
      await drag(row, { clientX: 16, clientY: 316 }, slotCenter(0));

      expect(h.state.fontTopPicks).toBe(null);
    });

    it("reorders picks dragged within the strip", async () => {
      const { container } = await openFontPicker();

      const firstPick = container.querySelector<HTMLElement>(
        '.FontPicker__top-picks [data-top-pick-index="0"]',
      )!;
      await drag(firstPick, slotCenter(0), slotCenter(2));

      await waitFor(() =>
        expect(h.state.fontTopPicks).toEqual([
          FONT_FAMILY.Nunito,
          FONT_FAMILY["Comic Shanns"],
          FONT_FAMILY.Excalifont,
        ]),
      );
      expect(getStripFamilies(container)).toEqual([
        "Normal",
        "Code",
        "Hand-drawn",
      ]);
    });

    it("pads a short customized list with unpicked defaults", async () => {
      const { container } = await openFontPicker();

      act(() => {
        API.setAppState({ fontTopPicks: [FONT_FAMILY["Lilita One"]] });
      });
      await waitFor(() =>
        expect(getStripFamilies(container)).toEqual([
          "Lilita One",
          "Hand-drawn",
          "Normal",
        ]),
      );

      // padded defaults count as pinned
      const row = document.querySelector<HTMLElement>(
        '.dropdown-menu.fonts [title="Nunito"]',
      )!;
      await drag(row, { clientX: 16, clientY: 316 }, slotCenter(0));
      expect(h.state.fontTopPicks).toEqual([FONT_FAMILY["Lilita One"]]);

      // dropping on a padded slot persists the full strip
      const code = document.querySelector<HTMLElement>(
        '.dropdown-menu.fonts [title="Comic Shanns"]',
      )!;
      await drag(code, { clientX: 16, clientY: 316 }, slotCenter(1));
      await waitFor(() =>
        expect(h.state.fontTopPicks).toEqual([
          FONT_FAMILY["Lilita One"],
          FONT_FAMILY["Comic Shanns"],
          FONT_FAMILY.Nunito,
        ]),
      );
    });

    it("resets customized picks from the tip's reset link", async () => {
      await openFontPicker();

      const getResetLink = () =>
        document.querySelector<HTMLElement>(
          ".FontPicker__tip .top-picks-dnd__tip-reset",
        );
      // nothing to reset while the picks are the defaults
      expect(getResetLink()).toBe(null);

      act(() => {
        API.setAppState({
          fontTopPicks: [FONT_FAMILY["Lilita One"], FONT_FAMILY.Nunito],
        });
      });
      await waitFor(() => expect(getResetLink()).not.toBe(null));

      act(() => {
        getResetLink()!.click();
      });

      expect(h.state.fontTopPicks).toBe(null);
      expect(h.state.openPopup).toBe("fontFamily");
      await waitFor(() => expect(getResetLink()).toBe(null));
    });
  });

  describe("Google Fonts", () => {
    // "Roboto Mono" in the catalog
    const ROBOTO_MONO = GOOGLE_FONTS_ID_OFFSET + 5;

    const CSS2 = `@font-face {
  font-family: 'Roboto Mono';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/robotomono/v1/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`;

    beforeEach(() => {
      // re-arm the global `document.fonts` mocks (reset by `restoreAllMocks`)
      vi.mocked(document.fonts.load).mockResolvedValue([]);
      vi.mocked(document.fonts.check).mockReturnValue(true);

      vi.spyOn(window, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/css2?family=")) {
          return new Response(CSS2, { status: 200 });
        }
        throw new Error(`unexpected fetch ${input}`);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const openPickerWithText = async (googleFonts: boolean) => {
      const utils = await render(
        <Excalidraw handleKeyboardGlobally={true} googleFonts={googleFonts} />,
      );
      const text = API.createElement({ type: "text", text: "hello" });
      API.setElements([text]);
      API.setSelectedElements([text]);

      act(() => {
        utils.getByTestId("font-family-show-fonts").click();
      });

      return { ...utils, text };
    };

    it("hides the Google Fonts browser when disabled", async () => {
      const { queryByTestId } = await openPickerWithText(false);

      expect(h.state.openPopup).toBe("fontFamily");
      expect(queryByTestId("font-picker-more-fonts")).toBe(null);
    });

    it("picks a Google font from the browser & keeps it as recently used", async () => {
      const { getByTestId, findByTestId, container, text } =
        await openPickerWithText(true);

      act(() => {
        getByTestId("font-picker-more-fonts").click();
      });

      const input = container.querySelector(
        ".GoogleFontsBrowser .QuickSearch__input",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "roboto mono" } });

      const row = await findByTestId(`google-font-${ROBOTO_MONO}`);
      expect(row.textContent).toContain("Roboto Mono");

      act(() => {
        row.click();
      });

      await waitFor(() =>
        expect(API.getElement(text).fontFamily).toBe(ROBOTO_MONO),
      );
      expect(h.state.recentFontFamilies).toEqual([ROBOTO_MONO]);
      expect(window.fetch).toHaveBeenCalledWith(
        "https://fonts.googleapis.com/css2?family=Roboto+Mono&display=swap",
      );
    });
  });

  describe("web-safe fonts", () => {
    const WEB_SAFE_FONTS = [
      "Arial",
      "Comic Sans MS",
      "Courier New",
      "Georgia",
      "Impact",
      "Times New Roman",
      "Verdana",
    ];

    // hovering or picking a font checks whether it's loaded
    beforeEach(() => {
      vi.mocked(document.fonts.check).mockReturnValue(true);
    });

    const openPickerWithText = async (
      fontFamily: number = FONT_FAMILY.Excalifont,
    ) => {
      const utils = await render(<Excalidraw handleKeyboardGlobally={true} />);
      const text = API.createElement({ type: "text", text: "hello" });
      API.updateElement(text, { fontFamily });
      API.setElements([text]);
      API.setSelectedElements([text]);

      act(() => {
        utils.getByTestId("font-family-show-fonts").click();
      });

      return { ...utils, text };
    };

    /** the font names listed in the group with the passed title */
    const getGroupFonts = (title: string) => {
      const group = Array.from(
        document.querySelectorAll(".dropdown-menu-group"),
      ).find(
        (element) =>
          element.querySelector(".dropdown-menu-group-title")?.textContent ===
          title,
      );

      return group
        ? Array.from(group.querySelectorAll("button")).map(
            (button) => button.title,
          )
        : null;
    };

    it("lists them in a group of their own, after the bundled fonts", async () => {
      await openPickerWithText();

      expect(getGroupFonts("Web-safe fonts")).toEqual(WEB_SAFE_FONTS);

      const availableFonts = getGroupFonts("Available fonts")!;

      expect(availableFonts).toContain("Nunito");
      for (const font of WEB_SAFE_FONTS) {
        expect(availableFonts).not.toContain(font);
      }

      // the bundled look-alikes aren't offered on their own
      for (const font of ["Tinos", "Cousine", "Gelasio", "Liberation Sans"]) {
        expect(document.querySelector(`button[title="${font}"]`)).toBe(null);
      }

      // the groups are listed in the order the keyboard walks them
      const titles = Array.from(
        document.querySelectorAll(".dropdown-menu-group-title"),
      ).map((title) => title.textContent);

      expect(titles).toEqual([
        "In this scene",
        "Available fonts",
        "Web-safe fonts",
      ]);
    });

    it("moves a font used on the board into the scene group", async () => {
      await openPickerWithText(FONT_FAMILY.Georgia);

      expect(getGroupFonts("In this scene")).toEqual(["Georgia"]);
      expect(getGroupFonts("Web-safe fonts")).toEqual(
        WEB_SAFE_FONTS.filter((font) => font !== "Georgia"),
      );
    });

    it("applies the picked font with its own line height", async () => {
      const { text } = await openPickerWithText();

      act(() => {
        (
          document.querySelector('button[title="Georgia"]') as HTMLElement
        ).click();
      });

      await waitFor(() =>
        expect(API.getElement(text).fontFamily).toBe(FONT_FAMILY.Georgia),
      );
      expect(API.getElement(text).lineHeight).toBe(1.15);
    });

    it("finds them by name", async () => {
      const { container } = await openPickerWithText();

      const input = (container.querySelector(".QuickSearch__input") ??
        document.querySelector(".QuickSearch__input")) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "times" } });

      await waitFor(() =>
        expect(getGroupFonts("Web-safe fonts")).toEqual(["Times New Roman"]),
      );
      expect(getGroupFonts("Available fonts")).toBe(null);
    });
  });
});
