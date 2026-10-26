import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatBytes } from "./lib/format";
import type { IslandState } from "./types";

/**
 * The notch — the strip stuck to the top edge of the screen.
 *
 * It owns no download state of its own and asks the backend for nothing: the
 * figures arrive as `island-state` events pushed by the main window, which is
 * where the job list lives. A readout that re-derived progress here could
 * disagree with the window behind it, and two different numbers for one
 * download is worse than no notch at all.
 *
 * The same goes for which mode it is in: expanding sends a request to the main
 * window and waits for the state that comes back, because the mode decides the
 * *window size*, and only Rust can change that. Flipping a local flag would
 * paint a 400px panel inside a 56px window.
 */
export default function Island() {
  const [state, setState] = useState<IslandState | null>(null);

  useEffect(() => {
    const unlisten = listen<IslandState>("island-state", (event) => setState(event.payload));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  /*
   * The theme arrives with the figures rather than being read from the OS
   * here. This window has no settings of its own, and a notch that asked the
   * OS directly would ignore an explicit Light or Dark choice made in the app
   * — ending up pale over a dark window, or the reverse.
   */
  useEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    root.classList.toggle("dark", state.theme === "dark");
    root.dataset.accent = state.accent;
  }, [state?.theme, state?.accent]);

  const drag = useDrag();

  if (!state) return null;

  const expanded = state.mode === "expanded";
  const percent = Math.max(0, Math.min(100, state.percent));

  return (
    <div className="notch" {...drag.handlers}>
      <div className="notch-grip" aria-hidden title="Tarik untuk memindahkan" />

      {expanded ? (
        <ExpandedPanel state={state} />
      ) : state.phase === "done" ? (
        <DoneRow state={state} />
      ) : state.phase === "downloading" ? (
        <ActiveRow state={state} percent={percent} />
      ) : (
        <IdleRow state={state} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ rows */

function IdleRow({ state }: { state: IslandState }) {
  return (
    <div className="notch-row">
      <Mark />
      <span className="notch-title">Download Engine</span>
      <div className="notch-spacer" />
      {state.active_count > 0 && <span className="notch-badge">{state.active_count}</span>}
      <IconButton icon="fa-chevron-down" label="Buka panel" onClick={() => send("expand")} />
    </div>
  );
}

function ActiveRow({ state, percent }: { state: IslandState; percent: number }) {
  return (
    <div className="notch-row">
      <Mark />

      <div className="notch-main">
        <div className="notch-line">
          <span className="notch-name" title={state.name}>
            {state.name}
          </span>
          {/* Only ever shown when it is true, so the notch never implies it is
              accounting for everything that is running. */}
          {state.active_count > 1 && <span className="notch-more">+{state.active_count - 1} lagi</span>}
        </div>

        <div className="notch-track">
          {/* An unknown total gives percent 0; the bar then sits empty rather
              than animating a figure nobody can stand behind. */}
          <div className="notch-fill" style={{ width: `${percent}%` }} />
        </div>

        <div className="notch-figures">
          <span className="notch-percent">{state.total_bytes > 0 ? `${percent.toFixed(0)}%` : "…"}</span>
          <Dot />
          <span>{formatBytes(state.speed_bytes)}/s</span>
          {state.eta && (
            <>
              <Dot />
              <span>{state.eta}</span>
            </>
          )}
        </div>
      </div>

      <IconButton icon="fa-pause" label="Jeda semua" onClick={() => send("pause-all")} />
      <IconButton icon="fa-ellipsis" label="Buka panel" onClick={() => send("expand")} />
    </div>
  );
}

function DoneRow({ state }: { state: IslandState }) {
  return (
    <div className="notch-row">
      <Mark />
      <i className="fa-solid fa-circle-check notch-done" />

      <div className="notch-main">
        <div className="notch-title">Download selesai</div>
        <div className="notch-sub" title={state.name}>
          {state.name}
        </div>
      </div>

      {/*
        The mock-up had "Buka File" beside this. Launching a downloaded file
        would need `opener:allow-open-path`, which this app deliberately
        refuses — it would let any page in any window start any executable on
        disk. Revealing it in Explorer is one click further and gives up
        nothing.
      */}
      <button type="button" data-no-drag className="notch-btn notch-btn-accent" onClick={() => send("reveal")}>
        <i className="fa-solid fa-folder-open" /> Buka Folder
      </button>
      <IconButton icon="fa-xmark" label="Tutup" onClick={() => send("dismiss")} />
    </div>
  );
}

function ExpandedPanel({ state }: { state: IslandState }) {
  return (
    <div className="notch-panel">
      <div className="notch-panel-head">
        <Mark />
        <span className="notch-title">Download Engine</span>
        <div className="notch-spacer" />
        <IconButton icon="fa-up-right-from-square" label="Buka aplikasi" onClick={() => reveal()} />
        <IconButton icon="fa-xmark" label="Tutup panel" onClick={() => send("collapse")} />
      </div>

      <div className="notch-list">
        {state.items.length === 0 ? (
          <p className="notch-empty">Belum ada download yang berjalan.</p>
        ) : (
          state.items.map((item) => (
            <div key={item.id} className="notch-item">
              <div className="notch-line">
                <span className="notch-name" title={item.name}>
                  {item.name}
                </span>
                <span className="notch-item-status">{STATUS_LABEL[item.status] ?? item.status}</span>
              </div>
              <div className="notch-track">
                <div
                  className={`notch-fill${item.status === "completed" ? " is-done" : ""}`}
                  style={{ width: `${Math.max(0, Math.min(100, item.percent))}%` }}
                />
              </div>
              <div className="notch-figures">
                <span className="notch-percent">{item.percent.toFixed(0)}%</span>
                {item.status === "downloading" && (
                  <>
                    <Dot />
                    <span>{formatBytes(item.speed_bytes)}/s</span>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="notch-panel-foot">
        {/*
          The mock-up's second tab was a media browser that lists what a page is
          playing. That needs the extension to report media per tab — a feature
          of its own, not a part of this panel — so the tab is left out rather
          than shipped empty.
        */}
        <span>{state.active_count} download aktif</span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- pieces */

const STATUS_LABEL: Record<string, string> = {
  downloading: "Berjalan",
  queued: "Antrean",
  paused: "Dijeda",
  completed: "Selesai",
  error: "Gagal",
  interrupted: "Terputus",
  cancelled: "Dibatalkan",
};

function Mark() {
  return (
    <div className="notch-mark">
      <i className="fa-solid fa-bolt" />
    </div>
  );
}

function Dot() {
  return <span className="notch-dot">·</span>;
}

function IconButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" data-no-drag className="notch-icon-btn" title={label} aria-label={label} onClick={onClick}>
      <i className={`fa-solid ${icon}`} />
    </button>
  );
}

function send(action: string) {
  void invoke("island_action", { action, jobId: null }).catch(() => {});
}

function reveal() {
  void invoke("island_reveal_main").catch(() => {});
}

/* ----------------------------------------------------------------- drag */

/** Movement, in CSS pixels, before a press counts as a drag and not a click. */
const DRAG_SLOP = 4;

/**
 * Pointer-driven dragging for the whole notch.
 *
 * Pointer capture is what makes this work across monitors: once the pointer is
 * captured the events keep arriving even when the cursor has left the window
 * entirely, which it does the moment the drag starts moving faster than the
 * window follows.
 *
 * Buttons opt out via `data-no-drag`, so pressing one never nudges the notch.
 */
function useDrag() {
  const pressed = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);

  const flush = () => {
    frame.current = 0;
    const point = pending.current;
    if (!point) return;
    pending.current = null;
    // `screenX`/`screenY` are CSS pixels; Rust works in physical ones. On a
    // mixed-DPI desk this is the *source* window's ratio, so the cursor and
    // the notch can drift apart over a differently scaled screen — the notch
    // still lands on the right monitor, which is what the drag is for.
    const ratio = window.devicePixelRatio || 1;
    void invoke("island_drag", { screenX: point.x * ratio, screenY: point.y * ratio }).catch(() => {});
  };

  return {
    handlers: {
      onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pressed.current = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
      },

      onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
        const press = pressed.current;
        if (!press || press.id !== event.pointerId) return;

        if (!press.moved) {
          const far = Math.abs(event.screenX - press.x) + Math.abs(event.screenY - press.y);
          if (far < DRAG_SLOP) return;
          press.moved = true;
        }

        // One move per frame: a drag across a wide desktop fires far more
        // pointer events than the window can be repositioned for, and the
        // extra calls only queue up behind the ones that matter.
        pending.current = { x: event.screenX, y: event.screenY };
        if (!frame.current) frame.current = requestAnimationFrame(flush);
      },

      onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
        const press = pressed.current;
        pressed.current = null;
        if (!press || press.id !== event.pointerId) return;

        if (press.moved) {
          if (frame.current) {
            cancelAnimationFrame(frame.current);
            flush();
          }
          void invoke("island_drag_end").catch(() => {});
        }
      },

      onPointerCancel() {
        pressed.current = null;
      },
    },
  };
}
