import type { KeyEvent, MouseEvent, Selection } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback, useEffect } from "react";
import type { CopyResult, CopyText } from "../clipboard.ts";
import { selectionText } from "./chatCopy.ts";

/**
 * A press on text always starts a selection, so a plain click leaves one
 * too: still at its start, in "cell" mode, with no text.
 */
function isEmpty(selection: Selection): boolean {
  return selection.isStart && selection.behavior === "cell";
}

/**
 * Copies selected text, as opencode and Claude Code do:
 *
 * - Releasing a drag, a double-click, or a triple-click copies what it
 *   selected. Give the returned handler to the `onMouseUp` of a box that holds
 *   the whole screen: mouse events bubble up to it.
 * - Ctrl+C copies when text is selected and clears the selection, so a second
 *   Ctrl+C does its normal job. With nothing selected, it does its normal job.
 * - Esc clears the selection. Any other key clears it and then does its normal job.
 *
 * The selection stays on screen after a copy on release: clearing it would
 * also reset OpenTUI's click count, and double-click and triple-click would
 * stop working.
 */
export function useSelectionCopy(
  copyText: CopyText,
  onCopied: (result: CopyResult) => void,
): (event: MouseEvent) => void {
  const renderer = useRenderer();

  const copySelection = useCallback((): boolean => {
    const selection = renderer.getSelection();
    if (!selection || isEmpty(selection)) return false;
    const text = selectionText(selection);
    if (!text) return false;
    void copyText(text).then(onCopied);
    return true;
  }, [renderer, copyText, onCopied]);

  // This listener goes before the ones from useKeyboard, so it can stop
  // Ctrl+C from quitting and Esc from closing things.
  useEffect(() => {
    const onKey = (key: KeyEvent) => {
      const selection = renderer.getSelection();
      if (!selection) return;
      const handled =
        key.ctrl && key.name === "c"
          ? copySelection()
          : key.name === "escape" && !isEmpty(selection) && selection.getSelectedText() !== "";
      renderer.clearSelection();
      if (handled) {
        key.preventDefault();
        key.stopPropagation();
      }
    };
    renderer.keyInput.prependListener("keypress", onKey);
    return () => {
      renderer.keyInput.off("keypress", onKey);
    };
  }, [renderer, copySelection]);

  return useCallback(
    (event: MouseEvent) => {
      if (event.isDragging) copySelection();
    },
    [copySelection],
  );
}
