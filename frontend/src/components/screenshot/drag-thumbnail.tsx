/**
 * Shared drag-thumbnail component used by the screenshot-ring overlay.
 *
 * Renders a captured PNG via the `asset://` protocol and initiates a native
 * OS drag-out on mouse-down.  The `onDragDone` callback fires after either a
 * successful drop or a cancellation so the parent can dismiss the window.
 *
 * `onMouseDown` (not `onClick`) is required: AppKit's `beginDraggingSession`
 * needs a live mouse-down event in the queue; a click arrives after mouse-up.
 *
 * `accept_first_mouse(true)` on the Rust window ensures the first click is not
 * swallowed by window activation.
 */

import { useState, type ReactElement } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";

interface DragThumbnailProps {
  /** Absolute path to the PNG in `$TMPDIR/codenest-shots/`. */
  path: string;
  /** Called after the drag ends (dropped or cancelled). */
  onDragDone: () => void;
  /** Optional inline padding around the image. Defaults to 6. */
  padding?: number;
  /** Optional hint text shown below the image. */
  hint?: string;
}

/** Shared dismiss button style — reused from the ring overlay. */
const DISMISS_BTN_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 6,
  right: 6,
  width: 20,
  height: 20,
  borderRadius: "50%",
  border: "none",
  background: "rgba(255,255,255,0.15)",
  color: "var(--fg-0, #fff)",
  fontSize: 12,
  lineHeight: 1,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

export function DragThumbnail({
  path,
  onDragDone,
  padding = 6,
  hint = "Drag into a terminal",
}: DragThumbnailProps): ReactElement {
  const [dragging, setDragging] = useState(false);

  function handleMouseDown(e: React.MouseEvent): void {
    if (e.button !== 0 || dragging) return;
    setDragging(true);
    // TODO: pass a downscaled thumbnail as the drag icon rather than the
    // full-res PNG — better visual during the drag.
    void startDrag({ item: [path], icon: path }, () => {
      setDragging(false);
      onDragDone();
    }).catch(() => {
      setDragging(false);
    });
  }

  return (
    <>
      {/* Drag target */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding,
          boxSizing: "border-box",
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
        }}
      >
        <img
          src={convertFileSrc(path)}
          alt="Captured screenshot"
          draggable={false}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            borderRadius: 4,
            boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
            pointerEvents: "none",
          }}
        />
      </div>

      {/* Dismiss (×) button */}
      <button
        type="button"
        onClick={onDragDone}
        aria-label="Dismiss preview"
        style={DISMISS_BTN_STYLE}
      >
        ×
      </button>

      {/* Hint label */}
      <div
        style={{
          position: "absolute",
          bottom: 5,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 9,
          color: "var(--fg-4, #555)",
          pointerEvents: "none",
        }}
      >
        {dragging ? "Dragging…" : hint}
      </div>
    </>
  );
}
