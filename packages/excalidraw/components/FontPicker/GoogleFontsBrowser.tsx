import clsx from "clsx";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
} from "react";

import {
  debounce,
  getFontFamilyString,
  getRuntimeFont,
  KEYS,
  type RuntimeFontCategory,
} from "@excalidraw/common";

import type { FontFamilyValues } from "@excalidraw/element/types";

import {
  loadGoogleFontsCatalog,
  type GoogleFontInfo,
} from "../../fonts/GoogleFonts";
import { loadGoogleFontPreview } from "../../fonts/GoogleFonts/preview";
import { t } from "../../i18n";
import { useExcalidrawContainer } from "../App";
import { QuickSearch } from "../QuickSearch";
import { ScrollableList } from "../ScrollableList";
import Spinner from "../Spinner";
import MenuItemContent from "../dropdownMenu/DropdownMenuItemContent";
import { getDropdownMenuItemClassName } from "../dropdownMenu/common";
import {
  chevronLeftIcon,
  FontFamilyCodeIcon,
  FontFamilyHeadingIcon,
  FontFamilyNormalIcon,
  FreedrawIcon,
} from "../icons";

const PAGE_SIZE = 60;

const CATEGORIES = [
  ["all", "fontList.category.all"],
  ["sans-serif", "fontList.category.sans-serif"],
  ["serif", "fontList.category.serif"],
  ["display", "fontList.category.display"],
  ["handwriting", "fontList.category.handwriting"],
  ["monospace", "fontList.category.monospace"],
] as const;

export const getFontCategoryIcon = (category: RuntimeFontCategory) => {
  switch (category) {
    case "handwriting":
      return FreedrawIcon;
    case "display":
      return FontFamilyHeadingIcon;
    case "monospace":
      return FontFamilyCodeIcon;
    default:
      return FontFamilyNormalIcon;
  }
};

/**
 * Lazily (once scrolled into view) loads a tiny preview font with just the
 * glyphs of the font name. Returns the CSS font-family to render it with.
 */
export const useGoogleFontPreview = (
  ref: React.RefObject<HTMLElement | null>,
  fontFamily: FontFamilyValues,
  name: string | undefined,
) => {
  const { container } = useExcalidrawContainer();
  const [previewFamily, setPreviewFamily] = useState<string | null>(null);

  useEffect(() => {
    const element = ref.current;

    if (!name || !element || typeof IntersectionObserver === "undefined") {
      return;
    }

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          loadGoogleFontPreview(
            name,
            container?.ownerDocument ?? document,
          ).then((family) => {
            if (!cancelled && family) {
              setPreviewFamily(family);
            }
          });
        }
      },
      { rootMargin: "100px" },
    );

    observer.observe(element);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [ref, name, container]);

  if (previewFamily) {
    return previewFamily;
  }

  // fall back to the full font (when already registered), or the generic family
  return getRuntimeFont(fontFamily)
    ? getFontFamilyString({ fontFamily })
    : undefined;
};

const GoogleFontRow = ({
  font,
  isHovered,
  isSelected,
  isLoading,
  onSelect,
  onHover,
}: {
  font: GoogleFontInfo;
  isHovered: boolean;
  isSelected: boolean;
  isLoading: boolean;
  onSelect: (font: GoogleFontInfo) => void;
  onHover: (font: GoogleFontInfo) => void;
}) => {
  const ref = useRef<HTMLButtonElement>(null);
  const previewFamily = useGoogleFontPreview(ref, font.id, font.name);

  useEffect(() => {
    if (isHovered) {
      ref.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [isHovered]);

  return (
    <button
      ref={ref}
      type="button"
      className={getDropdownMenuItemClassName("", isSelected, isHovered)}
      title={font.name}
      tabIndex={isSelected ? 0 : -1}
      onClick={() => onSelect(font)}
      onMouseMove={() => {
        if (!isHovered) {
          onHover(font);
        }
      }}
      data-testid={`google-font-${font.id}`}
    >
      <MenuItemContent
        icon={getFontCategoryIcon(font.category)}
        textStyle={previewFamily ? { fontFamily: previewFamily } : undefined}
        badge={isLoading ? <Spinner size="1rem" /> : undefined}
      >
        {font.name}
      </MenuItemContent>
    </button>
  );
};

/** ranks exact, prefix & word-start matches first, then by popularity */
const searchFonts = (
  fonts: readonly GoogleFontInfo[],
  searchTerm: string,
  category: RuntimeFontCategory | "all",
) => {
  const results: { font: GoogleFontInfo; rank: number }[] = [];

  for (const font of fonts) {
    if (font.removed || (category !== "all" && font.category !== category)) {
      continue;
    }

    if (!searchTerm) {
      results.push({ font, rank: 0 });
      continue;
    }

    const name = font.name.toLowerCase();
    const index = name.indexOf(searchTerm);

    if (index === -1) {
      continue;
    }

    const rank =
      name === searchTerm
        ? -1
        : index === 0
        ? 0
        : name[index - 1] === " "
        ? 1
        : 2;
    results.push({ font, rank });
  }

  return results
    .sort((a, b) => a.rank - b.rank || a.font.popularity - b.font.popularity)
    .map(({ font }) => font);
};

export const GoogleFontsBrowser = ({
  selectedFontFamily,
  onSelect,
  onBack,
}: {
  selectedFontFamily: FontFamilyValues | null;
  /** resolves once the font got registered & picked, rejects on failure */
  onSelect: (fontFamily: FontFamilyValues) => Promise<void>;
  onBack: () => void;
}) => {
  const [catalog, setCatalog] = useState<GoogleFontInfo[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [category, setCategory] = useState<RuntimeFontCategory | "all">("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [failedFont, setFailedFont] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const showMoreRef = useRef<HTMLButtonElement>(null);

  const fetchCatalog = useCallback(() => {
    setCatalogError(false);
    loadGoogleFontsCatalog()
      .then(setCatalog)
      .catch((error) => {
        console.error(error);
        setCatalogError(true);
      });
  }, []);

  useEffect(() => {
    fetchCatalog();
    inputRef.current?.focus();
  }, [fetchCatalog]);

  const results = useMemo(
    () => (catalog ? searchFonts(catalog, searchTerm, category) : []),
    [catalog, searchTerm, category],
  );

  const visibleResults = useMemo(
    () => results.slice(0, limit),
    [results, limit],
  );

  // reset paging & hover on a new query
  useEffect(() => {
    setLimit(PAGE_SIZE);
    setHoveredId(null);
  }, [searchTerm, category]);

  // load the next page once the "show more" button scrolls into view
  useEffect(() => {
    const element = showMoreRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setLimit((limit) => limit + PAGE_SIZE);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visibleResults.length, results.length]);

  const select = useCallback(
    (font: GoogleFontInfo) => {
      if (loadingId !== null) {
        return;
      }
      setFailedFont(null);
      setLoadingId(font.id);
      onSelect(font.id).catch(() => {
        setLoadingId(null);
        setFailedFont(font.name);
      });
    },
    [loadingId, onSelect],
  );

  const onKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      const index = visibleResults.findIndex((font) => font.id === hoveredId);
      let handled = true;

      if (event.key === KEYS.ESCAPE) {
        onBack();
      } else if (event.key === KEYS.ARROW_DOWN) {
        const next = visibleResults[index + 1] ?? visibleResults[0];
        if (next) {
          setHoveredId(next.id);
        }
        if (index + 1 >= visibleResults.length - 1) {
          setLimit((limit) => limit + PAGE_SIZE);
        }
      } else if (event.key === KEYS.ARROW_UP) {
        const prev =
          visibleResults[index - 1] ??
          visibleResults[visibleResults.length - 1];
        if (prev) {
          setHoveredId(prev.id);
        }
      } else if (event.key === KEYS.ENTER) {
        const font = visibleResults[index] ?? visibleResults[0];
        if (font) {
          select(font);
        }
      } else {
        handled = false;
      }

      // keep the keys away from the font list (and the canvas)
      event.stopPropagation();
      if (handled) {
        event.preventDefault();
      }
    },
    [visibleResults, hoveredId, onBack, select],
  );

  let content: React.ReactNode = null;

  if (catalogError) {
    content = (
      <div className="GoogleFontsBrowser__status">
        <span>{t("fontList.loadError")}</span>
        <button type="button" onClick={fetchCatalog}>
          {t("fontList.retry")}
        </button>
      </div>
    );
  } else if (!catalog) {
    content = (
      <div className="GoogleFontsBrowser__status">
        <Spinner size="1rem" />
        <span>{t("fontList.loading")}</span>
      </div>
    );
  } else {
    content = (
      <ScrollableList
        className="dropdown-menu fonts manual-hover GoogleFontsBrowser__list"
        placeholder={t("fontList.empty")}
      >
        {visibleResults.length
          ? [
              ...visibleResults.map((font) => (
                <GoogleFontRow
                  key={font.id}
                  font={font}
                  isHovered={font.id === hoveredId}
                  isSelected={font.id === selectedFontFamily}
                  isLoading={font.id === loadingId}
                  onSelect={select}
                  onHover={(font) => setHoveredId(font.id)}
                />
              )),
              results.length > visibleResults.length && (
                <button
                  key="show-more"
                  ref={showMoreRef}
                  type="button"
                  className="GoogleFontsBrowser__show-more"
                  onClick={() => setLimit((limit) => limit + PAGE_SIZE)}
                >
                  {t("fontList.showMore")}
                </button>
              ),
            ]
          : null}
      </ScrollableList>
    );
  }

  return (
    <div
      className="GoogleFontsBrowser"
      onKeyDown={onKeyDown}
      data-testid="google-fonts-browser"
    >
      <div className="GoogleFontsBrowser__header">
        <button
          type="button"
          className="GoogleFontsBrowser__back"
          onClick={onBack}
          title={t("fontList.back")}
          aria-label={t("fontList.back")}
        >
          {chevronLeftIcon}
        </button>
        <span>{t("fontList.googleFonts")}</span>
        {catalog && (
          <span className="GoogleFontsBrowser__count">{results.length}</span>
        )}
      </div>
      <QuickSearch
        ref={inputRef}
        placeholder={t("quickSearch.placeholder")}
        onChange={debounce(setSearchTerm, 50)}
      />
      <div className="GoogleFontsBrowser__categories" role="radiogroup">
        {CATEGORIES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={category === value}
            className={clsx("GoogleFontsBrowser__category", {
              active: category === value,
            })}
            onClick={() => setCategory(value)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {failedFont && (
        <div className="GoogleFontsBrowser__error" role="alert">
          {t("fontList.fontLoadError", { name: failedFont })}
        </div>
      )}
      {content}
    </div>
  );
};
