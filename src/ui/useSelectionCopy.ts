import { EditBufferRenderable, type KeyEvent, type MouseEvent, type Selection } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCallback, useEffect } from "react";
import { withoutBidiControls } from "../bidi.ts";
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
 * True for text selected inside an input, with Shift+arrows or the mouse. The
 * input keeps that selection in the renderer too, and handles its own keys.
 */
function inEditor(selection: Selection): boolean {
  return selection.selectedRenderables.some((r) => r instanceof EditBufferRenderable);
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
 *
 * A key that this handles (the Ctrl+C that copies, the Esc that clears) gets
 * `preventDefault()`, and the app's own key handlers skip such a key. Other
 * listeners still see it, such as the one that notes the user is active.
 * Inside an input with selected text, only Ctrl+C is handled here (it copies);
 * the input handles the other keys itself.
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
    // Other programs show text with bidi, and the text comes from other people.
    void copyText(withoutBidiControls(text)).then(onCopied);
    return true;
  }, [renderer, copyText, onCopied]);

  // This listener goes before the ones from useKeyboard, so they can see that
  // it handled the key.
  useEffect(() => {
    const onKey = (key: KeyEvent) => {
      const selection = renderer.getSelection();
      if (!selection) return;
      const ctrlC = key.ctrl && key.name === "c";
      if (inEditor(selection)) {
        if (ctrlC && copySelection()) key.preventDefault();
        return;
      }
      const handled = ctrlC
          ? copySelection()
          : key.name === "escape" && !isEmpty(selection) && selection.getSelectedText() !== "";
      renderer.clearSelection();
      if (handled) key.preventDefault();
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
