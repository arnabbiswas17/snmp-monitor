import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import CactiPanel from "./CactiPanel.jsx";
import Summary from "./Summary.jsx";
import { IN_COLOR, OUT_COLOR, Legend, fmtBps, fmtClock, pad } from "./common.jsx";

const LIVE_KEEP = 900; // seconds (same as the backend ring buffer)
const LIVE_WINDOWS = [
  { label: "1 min", sec: 60 },
  { label: "5 min", sec: 300 },
  { label: "15 min", sec: 900 },
];

// natural order: ae2.17 before ae2.100, et-0/0/2 before et-0/0/10
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export default function App() {
  const [ifaces, setIfaces] = useState({});
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState(location.hash === "#interfaces" ? "interfaces" : "summary");
  const [groups, setGroups] = useState(null);
  const [live, setLive] = useState([]);
  const [liveWin, setLiveWin] = useState(300);
  const [wsOk, setWsOk] = useState(false);
  const [status, setStatus] = useState(null);
  const [netError, setNetError] = useState(null);
  const [tick, setTick] = useState(Date.now());
  const selRef = useRef("");

  useEffect(() => { selRef.current = selected; }, [selected]);
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // interface list + status
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [list, st, grp] = await Promise.all([
          fetch("/api/interfaces").then((r) => r.json()),
          fetch("/api/status").then((r) => r.json()),
          fetch("/api/groups").then((r) => r.json()),
        ]);
        if (!alive) return;
        setNetError(null);
        setStatus(st);
        setGroups(grp);
        setIfaces((prev) => {
          const next = {};
          for (const i of list) next[i.name] = { ...prev[i.name], ...i };
          return next;
        });
        setSelected((cur) => cur || (list.find((x) => x.name !== "lo") ?? list[0])?.name || "");
      } catch {
        if (alive) setNetError("Cannot reach the backend (port 8000)");
      }
    }
    load();
    const id = setInterval(load, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // WebSocket: per-second live data
  useEffect(() => {
    let ws, timer, closed = false;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => setWsOk(true);
      ws.onclose = () => {
        setWsOk(false);
        if (!closed) timer = setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        setIfaces((prev) => {
          const next = { ...prev };
          for (const [n, [i, o]] of Object.entries(m.rates)) {
            next[n] = { ...(next[n] || { name: n }), in_bps: i, out_bps: o };
          }
          return next;
        });
        const r = selRef.current && m.rates[selRef.current];
        if (r) {
          setLive((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.t >= m.ts) return prev;
            const cutoff = m.ts - LIVE_KEEP * 1000;
            const arr = prev.filter((p) => p.t >= cutoff);
            arr.push({ t: m.ts, in: r[0], out: r[1] });
            return arr;
          });
        }
      };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws && ws.close(); };
  }, []);

  // load live history when the interface changes
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLive([]);
    fetch(`/api/realtime?iface=${encodeURIComponent(selected)}&seconds=${LIVE_KEEP}`)
      .then((r) => r.json())
      .then((hist) => {
        if (!alive) return;
        setLive((cur) => {
          const lastT = hist.length ? hist[hist.length - 1].t : 0;
          return [...hist, ...cur.filter((p) => p.t > lastT)];
        });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [selected]);

  const liveVisible = useMemo(() => {
    if (!live.length) return live;
    const cutoff = live[live.length - 1].t - liveWin * 1000;
    return live.filter((p) => p.t >= cutoff);
  }, [live, liveWin]);

  const cur = ifaces[selected];
  const names = useMemo(() => Object.keys(ifaces).sort(byName), [ifaces]);
  const error = netError || status?.error;

  const label = (n) => `${n}${ifaces[n]?.desc ? `  (${ifaces[n].desc})` : ""}`
    + (ifaces[n]?.speed_mbps ? `  –  ${ifaces[n].speed_mbps} Mbps` : "");

  function showTab(t) {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  }
  // from the Getting / Providing lists: open that interface's graphs
  function openIface(n) {
    setSelected(n);
    showTab("interfaces");
    window.scrollTo(0, 0);
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Interface traffic</h1>
          <p className="muted">
            {status ? `${status.host} • polling every ${status.interval}s` : "Loading..."}
            {" • "}
            <span className={wsOk ? "ok" : "bad"}>{wsOk ? "Live connected" : "Live disconnected"}</span>
            {status?.demo && <span className="demo-badge">DEMO • simulated data</span>}
          </p>
        </div>

        {tab === "interfaces" && (
          <label className="picker">
            <span>Interface</span>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {!names.length && <option value="">Waiting for data...</option>}
              {names.map((n) => <option key={n} value={n}>{label(n)}</option>)}
            </select>
          </label>
        )}
      </header>

      <nav className="tabs">
        <button className={tab === "summary" ? "on" : ""} onClick={() => showTab("summary")}>Getting &amp; Providing</button>
        <button className={tab === "interfaces" ? "on" : ""} onClick={() => showTab("interfaces")}>
          All interfaces <span className="count">{names.length}</span>
        </button>      </nav>

      {error && <div className="error">{error}</div>}

      {tab === "summary" && <Summary ifaces={ifaces} groups={groups} onOpen={openIface} />}
      {tab === "interfaces" && selected && (
        <>
          <section className="now">
            <div>
              <span className="dot" style={{ background: IN_COLOR }} /> Incoming
              <strong>{fmtBps(cur?.in_bps)}</strong>
            </div>
            <div>
              <span className="dot" style={{ background: OUT_COLOR }} /> Outgoing
              <strong>{fmtBps(cur?.out_bps)}</strong>
            </div>
          </section>

          <div className="grid">
            {/* ---------- live ---------- */}
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Live traffic</h2>
                  <p className="muted">Updates every second</p>
                </div>
                <div className="seg">
                  {LIVE_WINDOWS.map((w) => (
                    <button key={w.sec} className={w.sec === liveWin ? "on" : ""}
                      onClick={() => setLiveWin(w.sec)}>{w.label}</button>
                  ))}
                </div>
              </div>
              <Legend items={[[IN_COLOR, "Incoming"], [OUT_COLOR, "Outgoing"]]} />
              <div className="chart">
                {liveVisible.length > 1 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={liveVisible} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                      <defs>
                        <linearGradient id="gin" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={IN_COLOR} stopOpacity={0.3} />
                          <stop offset="100%" stopColor={IN_COLOR} stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="gout" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={OUT_COLOR} stopOpacity={0.28} />
                          <stop offset="100%" stopColor={OUT_COLOR} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                        tickFormatter={(t) => fmtClock(t, true)} stroke="#64748b" fontSize={12} minTickGap={40} />
                      <YAxis tickFormatter={fmtBps} stroke="#64748b" fontSize={12} width={96} />
                      <Tooltip labelFormatter={(t) => new Date(t).toLocaleTimeString()}
                        formatter={(v, n) => [fmtBps(v), n]} />
                      <Area type="monotone" dataKey="in" name="Incoming" stroke={IN_COLOR} strokeWidth={2}
                        fill="url(#gin)" isAnimationActive={false} dot={false} />
                      <Area type="monotone" dataKey="out" name="Outgoing" stroke={OUT_COLOR} strokeWidth={2}
                        fill="url(#gout)" isAnimationActive={false} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="empty">Waiting for live data...</div>
                )}
              </div>
            </section>

            {/* ---------- 5 minutes (stored) ---------- */}
            <CactiPanel iface={selected} tick={tick} />
          </div>
        </>
      )}
    </div>
  );
}
