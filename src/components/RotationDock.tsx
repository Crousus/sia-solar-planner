// ────────────────────────────────────────────────────────────────────────────
// RotationDock — bottom-right floating control strip with rotate-left,
// rotate-right, and reset buttons.
//
// Extracted from KonvaOverlay (Phase 3). Pure presentational; holds no state.
//
// Contract:
//   - `onRotate(deltaDeg)` is called for the ±15° buttons; parent applies the
//     delta to its Stage rotation.
//   - `onReset()` is called for the Reset button. We don't just pass `-rotation`
//     as a delta because the parent may want to null things out differently
//     (e.g. reset also snapping a residual fraction). Let the parent decide.
// ────────────────────────────────────────────────────────────────────────────

interface Props {
  /** Apply a relative rotation in degrees (e.g. -15, +15). */
  onRotate: (deltaDeg: number) => void;
  /** Reset rotation to 0. */
  onReset: () => void;
}

export default function RotationDock({ onRotate, onReset }: Props) {
  return (
    <div className="absolute bottom-6 right-6 z-[600]">
      <div
        className="surface rounded-full px-2 py-1.5 flex items-center gap-1"
        style={{ fontSize: 11 }}
      >
        <span
          className="font-mono uppercase tracking-wider px-2"
          style={{ fontSize: 9.5, color: 'var(--ink-400)' }}
        >
          Rotate
        </span>
        <button
          className="btn btn-tool"
          style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', fontSize: 14 }}
          onClick={() => onRotate(-15)}
          title="Rotate Left 15°"
        >
          ↺
        </button>
        <button
          className="btn btn-tool"
          style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', fontSize: 14 }}
          onClick={() => onRotate(15)}
          title="Rotate Right 15°"
        >
          ↻
        </button>
        <div className="divider-v mx-0.5" style={{ height: 14 }} />
        <button
          className="btn btn-tool"
          style={{ padding: '4px 8px', fontSize: 11 }}
          onClick={onReset}
          title="Reset Rotation"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
