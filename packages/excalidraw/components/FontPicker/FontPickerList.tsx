import React, {
  useMemo,
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEventHandler,
} from "react";

import { type FontFamilyValues } from "@excalidraw/element/types";

import {
  arrayToList,
  debounce,
  FONT_FAMILY,
  getFontFamilyString,
  getRuntimeFont,
  isGoogleFontFamily,
} from "@excalidraw/common";

import type { ValueOf } from "@excalidraw/common/utility-types";

import { Fonts } from "../../fonts";
import {
  getGoogleFontInfo,
  getGoogleFontsConfig,
  loadGoogleFontsCatalog,
} from "../../fonts/GoogleFonts";
import { t } from "../../i18n";
import {
  useApp,
  useAppProps,
  useExcalidrawContainer,
  useStylesPanelMode,
} from "../App";
import { PropertiesPopover } from "../PropertiesPopover";
import { QuickSearch } from "../QuickSearch";
import { ScrollableList } from "../ScrollableList";
import { TopPicksTip } from "../TopPicksDnD/TopPicksTip";
import DropdownMenuGroup from "../dropdownMenu/DropdownMenuGroup";
import {
  DropDownMenuItemBadgeType,
  DropDownMenuItemBadge,
} from "../dropdownMenu/DropdownMenuItem";
import MenuItemContent from "../dropdownMenu/DropdownMenuItemContent";
import { getDropdownMenuItemClassName } from "../dropdownMenu/common";
import {
  FontFamilyCodeIcon,
  FontFamilyHeadingIcon,
  FontFamilyNormalIcon,
  FreedrawIcon,
} from "../icons";

import { useFontPickerDnD } from "./fontTopPicksDnD";
import {
  getFontCategoryIcon,
  GoogleFontsBrowser,
  useGoogleFontPreview,
} from "./GoogleFontsBrowser";
import { fontPickerKeyHandler } from "./keyboardNavHandlers";

import type { JSX } from "react";
import type { ExcalidrawFontFace } from "../../fonts/ExcalidrawFontFace";

export interface FontDescriptor {
  value: number;
  icon: JSX.Element;
  text: string;
  deprecated?: true;
  /** runtime (Google) font */
  google?: true;
  badge?: {
    type: ValueOf<typeof DropDownMenuItemBadgeType>;
    placeholder: string;
  };
}

interface FontPickerListProps {
  selectedFontFamily: FontFamilyValues | null;
  hoveredFontFamily: FontFamilyValues | null;
  onSelect: (value: number) => void;
  onHover: (value: number) => void;
  onLeave: () => void;
  onOpen: () => void;
  onClose: () => void;
  /** present only while the top picks are customized */
  onResetTopPicks?: () => void;
}

export const getFontFamilyIcon = (
  fontFamily: FontFamilyValues,
): JSX.Element => {
  const category =
    getRuntimeFont(fontFamily)?.category ??
    getGoogleFontInfo(fontFamily)?.category;

  if (category) {
    return getFontCategoryIcon(category);
  }

  switch (fontFamily) {
    case FONT_FAMILY.Excalifont:
    case FONT_FAMILY.Virgil:
      return FreedrawIcon;
    case FONT_FAMILY.Nunito:
    case FONT_FAMILY.Helvetica:
      return FontFamilyNormalIcon;
    case FONT_FAMILY["Lilita One"]:
      return FontFamilyHeadingIcon;
    case FONT_FAMILY["Comic Shanns"]:
    case FONT_FAMILY.Cascadia:
      return FontFamilyCodeIcon;
    default:
      return FontFamilyNormalIcon;
  }
};

export const getFontFamilyLabel = (
  fontFamily: FontFamilyValues,
  fontFaces: ExcalidrawFontFace[],
) =>
  // prefer our config as the browser resolved names may be wrapped in quotes and such
  Object.entries(FONT_FAMILY).find(([, id]) => id === fontFamily)?.[0] ??
  getRuntimeFont(fontFamily)?.name ??
  getGoogleFontInfo(fontFamily)?.name ??
  fontFaces[0]?.fontFace?.family ??
  "Unknown";

export const FontPickerList = React.memo(
  ({
    selectedFontFamily,
    hoveredFontFamily,
    onSelect,
    onHover,
    onLeave,
    onOpen,
    onClose,
    onResetTopPicks,
  }: FontPickerListProps) => {
    const { container } = useExcalidrawContainer();
    const app = useApp();
    const { fonts } = app;
    const { showDeprecatedFonts } = useAppProps();
    const stylesPanelMode = useStylesPanelMode();
    // present only when the top picks are customizable
    const dnd = useFontPickerDnD();

    const [searchTerm, setSearchTerm] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const allFonts = useMemo(
      () =>
        Array.from(Fonts.registered.entries())
          .filter(
            ([_, { metadata }]) =>
              !metadata.private && !metadata.fallback && !metadata.dynamic,
          )
          .map(([familyId, { metadata, fontFaces }]) => {
            const fontDescriptor = {
              value: familyId,
              icon: getFontFamilyIcon(familyId),
              text: getFontFamilyLabel(familyId, fontFaces),
            };

            if (metadata.deprecated) {
              Object.assign(fontDescriptor, {
                deprecated: metadata.deprecated,
                badge: {
                  type: DropDownMenuItemBadgeType.RED,
                  placeholder: t("fontList.badge.old"),
                },
              });
            }

            return fontDescriptor as FontDescriptor;
          })
          .sort((a, b) =>
            a.text.toLowerCase() > b.text.toLowerCase() ? 1 : -1,
          ),
      [],
    );

    const sceneFamilies = useMemo(
      () => new Set(fonts.getSceneFamilies()),
      // cache per selected font family, so hover re-render won't mess it up
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [selectedFontFamily],
    );

    const isGoogleFontsEnabled = getGoogleFontsConfig().enabled;
    const [isBrowsing, setIsBrowsing] = useState(false);
    // bumped once the catalog loads, so that google font labels resolve
    const [catalogVersion, setCatalogVersion] = useState(0);
    const recentFontFamilies = app.state.recentFontFamilies;

    // google fonts in the scene & recently used ones (in this order)
    const googleFamilies = useMemo(
      () =>
        Array.from(
          new Set([
            ...Array.from(sceneFamilies).filter(isGoogleFontFamily),
            ...(isGoogleFontsEnabled ? recentFontFamilies ?? [] : []),
          ]),
        ),
      [sceneFamilies, recentFontFamilies, isGoogleFontsEnabled],
    );

    useEffect(() => {
      if (
        isGoogleFontsEnabled &&
        googleFamilies.some(
          (fontFamily) =>
            !getRuntimeFont(fontFamily) && !getGoogleFontInfo(fontFamily),
        )
      ) {
        loadGoogleFontsCatalog()
          .then(() => setCatalogVersion((version) => version + 1))
          .catch(console.error);
      }
    }, [googleFamilies, isGoogleFontsEnabled]);

    const googleFonts = useMemo(
      () =>
        googleFamilies
          .filter(
            (fontFamily) =>
              getRuntimeFont(fontFamily) || getGoogleFontInfo(fontFamily),
          )
          .map(
            (fontFamily): FontDescriptor => ({
              value: fontFamily,
              icon: getFontFamilyIcon(fontFamily),
              text: getFontFamilyLabel(fontFamily, []),
              google: true,
            }),
          ),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [googleFamilies, catalogVersion],
    );

    const sceneFonts = useMemo(
      () => [
        ...allFonts.filter((font) => sceneFamilies.has(font.value)), // always show all the fonts in the scene, even those that were deprecated
        ...googleFonts.filter((font) => sceneFamilies.has(font.value)),
      ],
      [allFonts, googleFonts, sceneFamilies],
    );

    const recentFonts = useMemo(
      () => googleFonts.filter((font) => !sceneFamilies.has(font.value)),
      [googleFonts, sceneFamilies],
    );

    const availableFonts = useMemo(
      () =>
        allFonts.filter(
          (font) =>
            !sceneFamilies.has(font.value) &&
            (showDeprecatedFonts || !font.deprecated), // skip deprecated fonts
        ),
      [allFonts, sceneFamilies, showDeprecatedFonts],
    );

    const filteredFonts = useMemo(
      () =>
        arrayToList(
          [...sceneFonts, ...recentFonts, ...availableFonts].filter((font) =>
            font.text?.toLowerCase().includes(searchTerm),
          ),
        ),
      [sceneFonts, recentFonts, availableFonts, searchTerm],
    );

    const ownerDocument = container?.ownerDocument ?? document;

    // runtime (Google) fonts need to be registered before they're applied,
    // so that the text gets measured with the right font
    const hoverTargetRef = useRef<number | null>(null);
    const handleHover = useCallback(
      (fontFamily: FontFamilyValues) => {
        hoverTargetRef.current = fontFamily;

        if (
          !isGoogleFontFamily(fontFamily) ||
          Fonts.registered.has(fontFamily)
        ) {
          onHover(fontFamily);
          return;
        }

        Fonts.ensureDynamicFonts([fontFamily], ownerDocument).then(
          (isAvailable) => {
            if (isAvailable && hoverTargetRef.current === fontFamily) {
              onHover(fontFamily);
            }
          },
        );
      },
      [onHover, ownerDocument],
    );

    const handleLeave = useCallback(() => {
      hoverTargetRef.current = null;
      onLeave();
    }, [onLeave]);

    const hoveredFont = useMemo(() => {
      let font;

      if (hoveredFontFamily) {
        font = filteredFonts.find((font) => font.value === hoveredFontFamily);
      } else if (selectedFontFamily) {
        font = filteredFonts.find((font) => font.value === selectedFontFamily);
      }

      if (!font && searchTerm) {
        if (filteredFonts[0]?.value) {
          // hover first element on search
          handleHover(filteredFonts[0].value);
        } else {
          // re-render cache on no results
          handleLeave();
        }
      }

      return font;
    }, [
      hoveredFontFamily,
      selectedFontFamily,
      searchTerm,
      filteredFonts,
      handleHover,
      handleLeave,
    ]);

    // Create a wrapped onSelect function that preserves caret position
    const selectFont = useCallback(
      (fontFamily: FontFamilyValues) => {
        // Save caret position before font selection if editing text
        let savedSelection: { start: number; end: number } | null = null;
        if (app.state.editingTextElement) {
          const textEditor = document.querySelector(
            ".excalidraw-wysiwyg",
          ) as HTMLTextAreaElement;
          if (textEditor) {
            savedSelection = {
              start: textEditor.selectionStart,
              end: textEditor.selectionEnd,
            };
          }
        }

        onSelect(fontFamily);

        // Restore caret position after font selection if editing text
        if (app.state.editingTextElement && savedSelection) {
          setTimeout(() => {
            const textEditor = document.querySelector(
              ".excalidraw-wysiwyg",
            ) as HTMLTextAreaElement;
            if (textEditor && savedSelection) {
              textEditor.focus();
              textEditor.selectionStart = savedSelection.start;
              textEditor.selectionEnd = savedSelection.end;
            }
          }, 0);
        }
      },
      [onSelect, app.state.editingTextElement],
    );

    /** registers runtime (Google) fonts first, rejects if unavailable */
    const selectFontAsync = useCallback(
      async (fontFamily: FontFamilyValues) => {
        if (
          isGoogleFontFamily(fontFamily) &&
          !(await Fonts.ensureDynamicFonts([fontFamily], ownerDocument))
        ) {
          throw new Error(`Font family "${fontFamily}" is not available`);
        }
        selectFont(fontFamily);
      },
      [selectFont, ownerDocument],
    );

    const wrappedOnSelect = useCallback(
      (fontFamily: FontFamilyValues) => {
        if (
          isGoogleFontFamily(fontFamily) &&
          !Fonts.registered.has(fontFamily)
        ) {
          selectFontAsync(fontFamily).catch(console.error);
        } else {
          selectFont(fontFamily);
        }
      },
      [selectFont, selectFontAsync],
    );

    const onKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>(
      (event) => {
        if (isBrowsing) {
          // handled by the google fonts browser
          return;
        }

        const handled = fontPickerKeyHandler({
          event,
          inputRef,
          hoveredFont,
          filteredFonts,
          onSelect: wrappedOnSelect,
          onHover: handleHover,
          onClose,
        });

        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      [
        isBrowsing,
        hoveredFont,
        filteredFonts,
        wrappedOnSelect,
        handleHover,
        onClose,
      ],
    );

    useEffect(() => {
      onOpen();

      return () => {
        onClose();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const sceneFilteredFonts = useMemo(
      () => filteredFonts.filter((font) => sceneFamilies.has(font.value)),
      [filteredFonts, sceneFamilies],
    );

    const recentFilteredFonts = useMemo(
      () =>
        filteredFonts.filter(
          (font) => font.google && !sceneFamilies.has(font.value),
        ),
      [filteredFonts, sceneFamilies],
    );

    const availableFilteredFonts = useMemo(
      () =>
        filteredFonts.filter(
          (font) => !font.google && !sceneFamilies.has(font.value),
        ),
      [filteredFonts, sceneFamilies],
    );

    const FontPickerListItem = ({
      font,
      order,
    }: {
      font: FontDescriptor;
      order: number;
    }) => {
      const ref = useRef<HTMLButtonElement>(null);
      const isHovered = font.value === hoveredFont?.value;
      const previewFamily = useGoogleFontPreview(
        ref,
        font.value,
        font.google ? font.text : undefined,
      );
      const isSelected = font.value === selectedFontFamily;

      useEffect(() => {
        if (!isHovered) {
          return;
        }
        if (order === 0) {
          // scroll into the first item differently, so it's visible what is above (i.e. group title)
          ref.current?.scrollIntoView?.({ block: "end" });
        } else {
          ref.current?.scrollIntoView?.({ block: "nearest" });
        }
      }, [isHovered, order]);

      return (
        <button
          ref={ref}
          type="button"
          value={font.value}
          className={getDropdownMenuItemClassName("", isSelected, isHovered)}
          title={font.text}
          // allow to tab between search and selected font
          tabIndex={isSelected ? 0 : -1}
          onClick={(e) => {
            wrappedOnSelect(Number(e.currentTarget.value));
          }}
          onMouseMove={() => {
            // don't live-preview fonts the dragged one merely passes over
            if (!dnd?.dragState && hoveredFont?.value !== font.value) {
              handleHover(font.value);
            }
          }}
          onPointerDown={
            dnd ? (event) => dnd.startSourceDrag(event, font.value) : undefined
          }
        >
          <MenuItemContent
            icon={font.icon}
            badge={
              font.badge && (
                <DropDownMenuItemBadge type={font.badge.type}>
                  {font.badge.placeholder}
                </DropDownMenuItemBadge>
              )
            }
            textStyle={{
              fontFamily: font.google
                ? previewFamily
                : getFontFamilyString({ fontFamily: font.value }),
            }}
          >
            {font.text}
          </MenuItemContent>
        </button>
      );
    };

    const groups = [];

    if (sceneFilteredFonts.length) {
      groups.push(
        <DropdownMenuGroup title={t("fontList.sceneFonts")} key="group_1">
          {sceneFilteredFonts.map((font, index) => (
            <FontPickerListItem key={font.value} font={font} order={index} />
          ))}
        </DropdownMenuGroup>,
      );
    }

    if (recentFilteredFonts.length) {
      groups.push(
        <DropdownMenuGroup title={t("fontList.recentFonts")} key="group_recent">
          {recentFilteredFonts.map((font, index) => (
            <FontPickerListItem
              key={font.value}
              font={font}
              order={index + sceneFilteredFonts.length}
            />
          ))}
        </DropdownMenuGroup>,
      );
    }

    if (availableFilteredFonts.length) {
      groups.push(
        <DropdownMenuGroup title={t("fontList.availableFonts")} key="group_2">
          {availableFilteredFonts.map((font, index) => (
            <FontPickerListItem
              key={font.value}
              font={font}
              order={
                index + sceneFilteredFonts.length + recentFilteredFonts.length
              }
            />
          ))}
        </DropdownMenuGroup>,
      );
    }

    if (isGoogleFontsEnabled) {
      groups.push(
        <button
          key="more_fonts"
          type="button"
          className="FontPicker__more-fonts"
          data-testid="font-picker-more-fonts"
          tabIndex={-1}
          onClick={() => {
            handleLeave();
            setIsBrowsing(true);
          }}
        >
          {t("fontList.moreFonts")}
        </button>,
      );
    }

    return (
      <PropertiesPopover
        className="properties-content"
        container={container}
        style={{ width: isBrowsing ? "18rem" : "15rem" }}
        onClose={() => {
          onClose();

          // Refocus text editor when font picker closes if we were editing text
          if (app.state.editingTextElement) {
            setTimeout(() => {
              const textEditor = document.querySelector(
                ".excalidraw-wysiwyg",
              ) as HTMLTextAreaElement;
              if (textEditor) {
                textEditor.focus();
              }
            }, 0);
          }
        }}
        onPointerLeave={handleLeave}
        onKeyDown={onKeyDown}
        preventAutoFocusOnTouch={!!app.state.editingTextElement}
      >
        {isBrowsing ? (
          <GoogleFontsBrowser
            selectedFontFamily={selectedFontFamily}
            onSelect={selectFontAsync}
            onBack={() => {
              setIsBrowsing(false);
              inputRef.current?.focus();
            }}
          />
        ) : (
          <>
            {stylesPanelMode === "full" && (
              <QuickSearch
                ref={inputRef}
                placeholder={t("quickSearch.placeholder")}
                onChange={debounce(setSearchTerm, 20)}
              />
            )}
            <ScrollableList
              className="dropdown-menu fonts manual-hover"
              placeholder={t("fontList.empty")}
            >
              {groups.length ? groups : null}
            </ScrollableList>
          </>
        )}
        {dnd && !isBrowsing && (
          <TopPicksTip
            className="FontPicker__tip"
            tip={t("fontList.topPicksTip")}
            onReset={onResetTopPicks}
            resetTitle={t("fontList.resetTopPicks")}
          />
        )}
      </PropertiesPopover>
    );
  },
  (prev, next) =>
    prev.selectedFontFamily === next.selectedFontFamily &&
    prev.hoveredFontFamily === next.hoveredFontFamily &&
    !!prev.onResetTopPicks === !!next.onResetTopPicks,
);
