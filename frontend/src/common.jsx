export const IN_COLOR = "#0f766e";
export const OUT_COLOR = "#c2410c";

export const pad = (n) => String(n).padStart(2, "0");

export function fmtBps(v) {
  if (v == null || isNaN(v)) return "-";
  const u = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 2)} ${u[i]}`;
}

export function fmtBytes(v) {
  if (v == null || isNaN(v)) return "-";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 2)} ${u[i]}`;
}

export function fmtClock(t, withSec) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${withSec ? ":" + pad(d.getSeconds()) : ""}`;
}

export function fmtDateTime(t) {
  const d = new Date(t);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${fmtClock(t, false)}`;
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map(([c, label, dashed]) => (
        <span key={label}>
          <i style={{
            background: dashed ? "transparent" : c,
            borderTop: dashed ? `2px dashed ${c}` : "none",
          }} />
          {label}
        </span>
      ))}
    </div>
  );
}
