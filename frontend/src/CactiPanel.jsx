import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDateTime, pad } from "./common.jsx";

const BUCKET_MS = 300000;            // 5 minutes
const MIN_SPAN = 900;                // max zoom-in: 15 minutes (seconds)
const MAX_SPAN = 800 * 86400;
const GRAPH_H = 150;
const PRESETS = [
  { label: "Last 30 minutes", sec: 1800 },
  { label: "Last 1 hour", sec: 3600 },
  { label: "Last 2 hours", sec: 7200 },
  { label: "Last 4 hours", sec: 14400 },
  { label: "Last 6 hours", sec: 21600 },
  { label: "Last 12 hours", sec: 43200 },
  { label: "Last 1 day", sec: 86400 },
  { label: "Last 2 days", sec: 172800 },
  { label: "Last 1 week", sec: 604800 },
  { label: "Last 1 month", sec: 2592000 },
  { label: "Last 1 year", sec: 31536000 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function toInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Message({ err, loading }) {
  if (err === "rrdtool_missing") {
    return (
      <div className="cacti-msg">
        <b>rrdtool is not installed.</b> Run in a terminal: <code>sudo apt install rrdtool</code><br />
        Then restart the backend. The data collected so far will be imported into the RRD files automatically.
      </div>
    );
  }
  if (err === "no_rrd") return <div className="cacti-msg">Creating the RRD file, please wait a few seconds...</div>;
  if (err) return <div className="cacti-msg bad">Problem drawing the graph: {err}</div>;
  return <div className="cacti-msg">{loading ? "Loading graph..." : ""}</div>;
}

export default function CactiPanel({ iface, tick }) {
  const [span, setSpan] = useState(86400);   // visible time span (seconds)
  const [endMs, setEndMs] = useState(null);  // null = follow the latest data
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [plotW, setPlotW] = useState(620);
  const [sel, setSel] = useState(null);      // part selected by dragging {x0,x1}
  const [draft, setDraft] = useState({ from: "", to: "" });
  const [draftErr, setDraftErr] = useState("");
  const draftDirty = useRef(false);
  const wrapRef = useRef(null);
  const boxRef = useRef(null);
  const selDrag = useRef(null);
  const selRef = useRef(null);

  // end time of the last completed 5-minute bucket (changes once every 5 minutes)
  const followEnd = Math.floor(tick / BUCKET_MS) * BUCKET_MS;
  const end = endMs ?? followEnd;
  const start = end - span * 1000;
  const following = endMs === null;
  const startSec = Math.floor(start / 1000);
  const endSec = Math.floor(end / 1000);

  const viewRef = useRef({});
  viewRef.current = { span, end, followEnd, dataFirst: data?.data_first ?? null };
  const geomRef = useRef(null);
  geomRef.current = data ? {
    left: data.graph_left, top: data.graph_top, w: data.graph_width, h: data.graph_height,
    t0: data.graph_start, t1: data.graph_end,
  } : null;
  selRef.current = sel;

  // ---- graph width follows the screen width ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setPlotW(clamp(Math.floor(el.clientWidth) - 100, 300, 2000));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- load graph ----
  useEffect(() => { setData(null); setErr(""); }, [iface]);
  useEffect(() => {
    if (!iface) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/graph?iface=${encodeURIComponent(iface)}&start=${startSec}&end=${endSec}&width=${plotW}&height=${GRAPH_H}`);
        const d = await r.json();
        if (!alive) return;
        if (!r.ok) { setErr(d.error || "Unknown error"); return; }
        setErr("");
        setData(d);
      } catch {
        if (alive) setErr("Cannot reach the backend");
      }
    };
    const t1 = setTimeout(load, 150);     // debounce while dragging/zooming
    const t2 = setTimeout(load, 4000);    // after new 5-minute data enters the RRD
    const id = setInterval(load, 20000);
    return () => { alive = false; clearTimeout(t1); clearTimeout(t2); clearInterval(id); };
  }, [iface, startSec, endSec, plotW]);

  // ---- view changes ----
  const applyView = useCallback((newSpanSec, newEndMs) => {
    const v = viewRef.current;
    const sp = clamp(newSpanSec, MIN_SPAN, MAX_SPAN);
    let en = newEndMs;
    if (en >= v.followEnd - 1000) {
      en = null;                                         // reached the latest: switch to follow mode
    } else if (v.dataFirst != null) {
      en = Math.max(en, v.dataFirst + sp * 1000 * 0.15); // prevents going far to the left of the data
    }
    setSpan(sp);
    setEndMs(en);
  }, []);

  const zoomAt = useCallback((f, factor) => {
    const v = viewRef.current;
    const tc = v.end - v.span * 1000 + f * v.span * 1000;
    const ns = clamp(v.span * factor, MIN_SPAN, MAX_SPAN);
    applyView(ns, tc + (1 - f) * ns * 1000);
  }, [applyView]);

  const hasData = !!data;
  // mouse wheel = zoom (around the cursor)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e) => {
      const g = geomRef.current;
      if (!g) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const f = clamp((e.clientX - rect.left - g.left) / g.w, 0, 1);
      zoomAt(f, e.deltaY > 0 ? 1.25 : 0.8);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, hasData]);

  // ---- drag to select a range and zoom (like Cacti) ----
  const rel = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e) => {
    const g = geomRef.current;
    if (!g || e.button !== 0) return;
    const { x, y } = rel(e);
    if (x < g.left || x > g.left + g.w || y < g.top || y > g.top + g.h) return;
    selDrag.current = { x0: x };
    setSel({ x0: x, x1: x });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!selDrag.current) return;
    const g = geomRef.current;
    const x = clamp(rel(e).x, g.left, g.left + g.w);
    setSel({ x0: selDrag.current.x0, x1: x });
  };
  const onPointerUp = () => {
    const d = selDrag.current;
    const s = selRef.current;
    selDrag.current = null;
    setSel(null);
    const g = geomRef.current;
    if (!d || !s || !g) return;
    const a = Math.min(s.x0, s.x1), b = Math.max(s.x0, s.x1);
    if (b - a < 8) return;                     // ignore tiny clicks
    const sp = g.t1 - g.t0;
    const tA = g.t0 + ((a - g.left) / g.w) * sp;
    const tB = g.t0 + ((b - g.left) / g.w) * sp;
    applyView(tB - tA, tB * 1000);
  };

  // ---- view a specific time range ----
  useEffect(() => {
    if (draftDirty.current) return;
    setDraft({ from: toInput(start), to: toInput(end) });
  }, [start, end]);

  const applyDraft = () => {
    const f = new Date(draft.from).getTime();
    const t = new Date(draft.to).getTime();
    if (isNaN(f) || isNaN(t) || t <= f) { setDraftErr("Invalid range (start must be before end)"); return; }
    setDraftErr("");
    draftDirty.current = false;
    applyView((t - f) / 1000, t);
  };
  const setDraftField = (k, v) => { draftDirty.current = true; setDraft((d) => ({ ...d, [k]: v })); };

  const presetValue = following && PRESETS.some((p) => p.sec === span) ? String(span) : "custom";
  const nextSave = 300 - ((tick / 1000) % 300);
  const g = geomRef.current;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Traffic graph (RRD • Cacti style)</h2>
          <p className="muted">
            Stored 5-minute data (RRD) • next data enters from the right in {Math.floor(nextSave / 60)}:{pad(Math.floor(nextSave % 60))}
          </p>
        </div>
        <label className="preset">
          <span>Time range</span>
          <select value={presetValue}
            onChange={(e) => {
              if (e.target.value === "custom") return;
              setSpan(Number(e.target.value)); setEndMs(null); draftDirty.current = false;
            }}>
            {presetValue === "custom" && <option value="custom">Custom</option>}
            {PRESETS.map((p) => <option key={p.sec} value={p.sec}>{p.label}</option>)}
          </select>
        </label>
      </div>

      <div className="toolbar">
        <div className="seg">
          <button title="Go back in time" onClick={() => applyView(span, end - span * 500)}>◀</button>
          <button title="Go forward in time" onClick={() => applyView(span, end + span * 500)}>▶</button>
        </div>
        <div className="seg">
          <button title="Zoom out" onClick={() => zoomAt(0.5, 2)}>−</button>
          <button title="Zoom in" onClick={() => zoomAt(0.5, 0.5)}>+</button>
        </div>
        <button className={following ? "chip on" : "chip"}
          onClick={() => { setEndMs(null); draftDirty.current = false; }}>
          {following ? "● Following latest" : "Back to latest"}
        </button>
        <span className="muted">Drag on the graph to select a range = zoom • Scroll = zoom in/out</span>
      </div>

      <div className="range-row">
        <label>From
          <input type="datetime-local" value={draft.from} onChange={(e) => setDraftField("from", e.target.value)} />
        </label>
        <label>To
          <input type="datetime-local" value={draft.to} onChange={(e) => setDraftField("to", e.target.value)} />
        </label>
        <button className="chip on" onClick={applyDraft}>Show</button>
        {draftErr && <span className="bad">{draftErr}</span>}
      </div>

      <div ref={wrapRef} className="cacti-wrap">
        {data ? (
          <div ref={boxRef} className="cacti-box"
            style={{ width: data.image_width, height: data.image_height }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <img src={data.image} width={data.image_width} height={data.image_height}
              draggable={false} alt={`${iface} traffic graph`} />
            {sel && g && (
              <div className="sel" style={{
                left: Math.min(sel.x0, sel.x1), width: Math.abs(sel.x1 - sel.x0),
                top: g.top, height: g.h,
              }} />
            )}
          </div>
        ) : (
          <Message err={err} loading={!!iface} />
        )}
        {data && err && <Message err={err} />}
      </div>

      <div className="totals">
        <span>{fmtDateTime(start)} → {fmtDateTime(end)}</span>
        {data?.data_first && <span className="muted">Data since {fmtDateTime(data.data_first)}</span>}
      </div>
    </section>
  );
}
