import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from "react";

interface PanelResizerProps {
  /** Announced to assistive technology, e.g. "Resize explorer". */
  label: string;
  width: number;
  min: number;
  max: number;
  /** "leading" when the panel being sized sits before the handle. */
  edge: "leading" | "trailing";
  className?: string;
  onResize: (width: number) => void;
  onReset: () => void;
}

const STEP = 16;
const FINE_STEP = 4;

/**
 * A draggable column divider. Pointer capture keeps the drag alive when the
 * cursor outruns the handle, which is easy to do on a 5px target.
 */
export function PanelResizer({ label, width, min, max, edge, className, onResize, onReset }: PanelResizerProps) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const clamp = useCallback(
    (value: number) => Math.round(Math.min(max, Math.max(min, value))),
    [min, max],
  );

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-columns");
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const delta = event.clientX - state.startX;
    onResize(clamp(edge === "leading" ? state.startWidth + delta : state.startWidth - delta));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-columns");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Left always makes the divider travel left, whichever panel it sizes.
    const step = event.shiftKey ? FINE_STEP : STEP;
    const towardLeading = edge === "leading" ? -1 : 1;
    if (event.key === "ArrowLeft") onResize(clamp(width + step * towardLeading));
    else if (event.key === "ArrowRight") onResize(clamp(width - step * towardLeading));
    else if (event.key === "Home") onResize(min);
    else if (event.key === "End") onResize(max);
    else if (event.key === "Enter" || event.key === " ") onReset();
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={`panel-resizer${className ? ` ${className}` : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} — drag, or double-click to reset`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    >
      <span className="panel-resizer-grip" aria-hidden="true" />
    </div>
  );
}
