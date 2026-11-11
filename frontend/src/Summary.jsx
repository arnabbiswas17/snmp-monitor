import { useEffect, useMemo, useState } from "react";
import {
  Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { IN_COLOR, OUT_COLOR, Legend, fmtBps, fmtBytes, fmtClock, fmtDateTime } from "./common.jsx";

const CACHE_COLOR = "#7c3aed";
const RANGES = [
  { label: "6 h", hours: 6 },
  { label: "24 h", hours: 24 },
  { label: "7 d", hours: 168 },
  { label: "30 d", hours: 720 },
];
const ACTIVE_BPS = 1e6; // "not counted" interfaces above this are highlighted

const val = (ifaces, n, key) => ifaces[n]?.[key] || 0;
const total = (ifaces, names, key) => names.reduce((s, n) => s + val(ifaces, n, key), 0);

function Card({ color, label, value, sub }) {
  return (
    <div className="card">
      <span className="card-label"><span className="dot" style={{ background: color }} />{label}</span>
      <strong>{fmtBps(value)}</strong>
      {sub && <span className="muted">{sub}</span>}
    </div>
  );
}

// one list (getting / providing / cache): the counted direction is bold, with its share of the group total
function GroupTable({ title, hint, names, ifaces, dir, color, onOpen }) {
  const [showIdle, setShowIdle] = useState(false);
  const key = dir === "in" ? "in_avg_bps" : "out_avg_bps";
  const other = dir === "in" ? "out_avg_bps" : "in_avg_bps";
  const sorted = [...names].sort((a, b) => val(ifaces, b, key) - val(ifaces, a, key));
  const idle = sorted.filter((n) => val(ifaces, n, key) < ACTIVE_BPS).length;
  const rows = showIdle ? sorted : sorted.filter((n) => val(ifaces, n, key) >= ACTIVE_BPS || !ifaces[n]);
  const sum = total(ifaces, names, key);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">{hint}</p>
        </div>
        <span className="count">{names.length - idle} active / {names.length}</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Interface</th><th>Description</th>
              <th className="num">{dir === "in" ? "In (counted)" : "Out (counted)"}</th>
              <th className="num">{dir === "in" ? "Out" : "In"}</th>
              <th className="share-col">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => {
              const found = !!ifaces[n];
              const v = val(ifaces, n, key);
              const pct = sum > 0 ? (v / sum) * 100 : 0;
              return (
                <tr key={n} className={v < ACTIVE_BPS ? "idle" : ""}>
                  <td>
                    {found
                      ? <button className="link" onClick={() => onOpen(n)}>{n}</button>
                      : <span className="bad" title="Not found on the device">{n} ?</span>}
                  </td>
                  <td className="desc">{ifaces[n]?.desc || ""}</td>
                  <td className="num strong">{fmtBps(v)}</td>
                  <td className="num">{fmtBps(val(ifaces, n, other))}</td>
                  <td className="share-col">
                    <div className="share"><i style={{ width: `${pct}%`, background: color }} /></div>
                    <span>{pct >= 0.5 ? `${pct.toFixed(0)}%` : ""}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {idle > 0 && (
              <tr className="more">
                <td colSpan={5}>
                  <button className="link" onClick={() => setShowIdle(!showIdle)}>
                    {showIdle ? "Hide idle interfaces" : `Show ${idle} idle interface${idle > 1 ? "s" : ""} (under 1 Mbps)`}
                  </button>
                </td>
              </tr>
            )}
            <tr>
              <td colSpan={2}>Total</td>
              <td className="num strong">{fmtBps(sum)}</td>
              <td className="num">{fmtBps(total(ifaces, names, other))}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function History() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => fetch(`/api/summary?hours=${hours}`).then((r) => r.json())
      .then((d) => alive && setData(d)).catch(() => {});
    setData(null);
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [hours]);

  const pts = data?.points || [];
  const stats = useMemo(() => {
    if (!pts.length) return null;
    const avg = (k) => pts.reduce((s, p) => s + p[k], 0) / pts.length;
    const max = (k) => Math.max(...pts.map((p) => p[k]));
    return { gAvg: avg("getting_in"), gMax: max("getting_in"), pAvg: avg("providing_out"), pMax: max("providing_out") };
  }, [pts]);
  const long = hours > 24;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>History</h2>
          <p className="muted">Getting (in from providers) vs Providing (out to downstream), from the stored 5-minute data</p>
        </div>
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.hours} className={r.hours === hours ? "on" : ""} onClick={() => setHours(r.hours)}>{r.label}</button>
          ))}
        </div>
      </div>
      <Legend items={[[IN_COLOR, "Getting"], [OUT_COLOR, "Providing"], [CACHE_COLOR, "Cache", true]]} />
      <div className="chart">
        {pts.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={pts} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
              <CartesianGrid stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => (long ? fmtDateTime(t) : fmtClock(t))} stroke="#64748b" fontSize={12} minTickGap={50} />
              <YAxis tickFormatter={fmtBps} stroke="#64748b" fontSize={12} width={96} />
              <Tooltip labelFormatter={(t) => fmtDateTime(t)} formatter={(v, n) => [fmtBps(v), n]} />
              <Area type="monotone" dataKey="getting_in" name="Getting" stroke={IN_COLOR} strokeWidth={2}
                fill={IN_COLOR} fillOpacity={0.12} isAnimationActive={false} dot={false} />
              <Area type="monotone" dataKey="providing_out" name="Providing" stroke={OUT_COLOR} strokeWidth={2}
                fill={OUT_COLOR} fillOpacity={0.08} isAnimationActive={false} dot={false} />
              <Line type="monotone" dataKey="cache_in" name="Cache" stroke={CACHE_COLOR} strokeWidth={1.5}
                strokeDasharray="5 4" isAnimationActive={false} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty">{data ? "No stored data for this range yet" : "Loading..."}</div>
        )}
      </div>
      {stats && (
        <div className="totals">
          <span>Getting: avg <b>{fmtBps(stats.gAvg)}</b> · peak <b>{fmtBps(stats.gMax)}</b> · data <b>{fmtBytes(data.total_bytes.getting.in)}</b></span>
          <span>Providing: avg <b>{fmtBps(stats.pAvg)}</b> · peak <b>{fmtBps(stats.pMax)}</b> · data <b>{fmtBytes(data.total_bytes.providing.out)}</b></span>
        </div>
      )}
    </section>
  );
}

// sub-interfaces on the same parents that are in no list, plus the excluded ones
function NotCounted({ groups, ifaces, onOpen }) {
  const [all, setAll] = useState(false);
  const excluded = new Set(groups.excluded);
  const rows = [...groups.excluded, ...groups.others]
    .map((n) => ({ n, v: val(ifaces, n, "in_avg_bps") + val(ifaces, n, "out_avg_bps") }))
    .sort((a, b) => b.v - a.v);
  const active = rows.filter((r) => r.v >= ACTIVE_BPS && !excluded.has(r.n));
  const shown = all ? rows : rows.filter((r) => r.v >= ACTIVE_BPS);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Not counted</h2>
          <p className="muted">
            Other sub-interfaces on the same links. Excluded = internal links. Anything else with traffic here
            should be added to a list in config.env.
          </p>
        </div>
        <button className="chip" onClick={() => setAll(!all)}>{all ? "Only with traffic" : `Show all (${rows.length})`}</button>
      </div>
      {active.length > 0 && (
        <div className="warn">{active.length} interface(s) carry traffic but are in no list: {active.map((r) => r.n).join(", ")}</div>
      )}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Interface</th><th>Description</th><th className="num">In</th><th className="num">Out</th><th /></tr></thead>
          <tbody>
            {shown.map(({ n }) => (
              <tr key={n} className={excluded.has(n) ? "idle" : ""}>
                <td><button className="link" onClick={() => onOpen(n)}>{n}</button></td>
                <td className="desc">{ifaces[n]?.desc || ""}</td>
                <td className="num">{fmtBps(val(ifaces, n, "in_avg_bps"))}</td>
                <td className="num">{fmtBps(val(ifaces, n, "out_avg_bps"))}</td>
                <td>{excluded.has(n) && <span className="badge">excluded</span>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={5} className="muted">Nothing with traffic</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Summary({ ifaces, groups, onOpen }) {
  if (!groups) return <div className="panel"><p className="muted">Loading...</p></div>;
  const configured = groups.getting.length || groups.providing.length;
  if (!configured) {
    return (
      <section className="panel">
        <h2>Getting &amp; Providing is not configured</h2>
        <p className="muted">
          Set <code>GETTING_IFACES</code> and <code>PROVIDING_IFACES</code> (and optionally <code>CACHE_IFACES</code>,{" "}
          <code>EXCLUDED_IFACES</code>) in config.env, then restart the app. See config.env.example.
        </p>
      </section>
    );
  }
  const g = groups;
  return (
    <>
      {g.warnings.map((w) => <div key={w} className="warn">{w}</div>)}

      <p className="muted">Live figures are 60-second averages per interface, refreshed every 10 seconds.</p>

      <section className="cards">
        <Card color={IN_COLOR} label="Getting (in from providers)" value={total(ifaces, g.getting, "in_avg_bps")}
          sub={`Upload to providers: ${fmtBps(total(ifaces, g.getting, "out_avg_bps"))}`} />
        <Card color={OUT_COLOR} label="Providing (out to downstream)" value={total(ifaces, g.providing, "out_avg_bps")}
          sub={`Received from downstream: ${fmtBps(total(ifaces, g.providing, "in_avg_bps"))}`} />
        {g.cache.length > 0 && (
          <Card color={CACHE_COLOR} label="Cache (in from GGC / CDN)" value={total(ifaces, g.cache, "in_avg_bps")}
            sub={`${g.cache.length} interfaces`} />
        )}
      </section>

      <History />

      <div className="grid">
        <div className="stack">
          <GroupTable title="Getting" hint="Provider links - inbound traffic is counted" names={g.getting}
            ifaces={ifaces} dir="in" color={IN_COLOR} onOpen={onOpen} />
          {g.cache.length > 0 && (
            <GroupTable title="Cache" hint="Cache / CDN links - inbound traffic, shown separately" names={g.cache}
              ifaces={ifaces} dir="in" color={CACHE_COLOR} onOpen={onOpen} />
          )}
        </div>
        <GroupTable title="Providing" hint="Downstream / customer links - outbound traffic is counted" names={g.providing}
          ifaces={ifaces} dir="out" color={OUT_COLOR} onOpen={onOpen} />
      </div>

      <NotCounted groups={g} ifaces={ifaces} onOpen={onOpen} />
    </>
  );
}
