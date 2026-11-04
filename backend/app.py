"""SNMP interface bandwidth monitor - backend.

Design (why no data is missed):
  * Every second only ifHCInOctets / ifHCOutOctets are read (one snmpget request).
  * Counters only ever grow, so even if a poll fails, the next poll still captures the
    total bytes. The bytes of a gap are spread over the gap into 5-minute buckets.
  * Every raw counter sample is saved to SQLite (WAL). Even if the app was stopped,
    the gap is recovered from the last counter after a restart.
  * A 5-minute bucket stores total bytes + time coverage + peak;
    average rate = total bytes x 8 / coverage (not an average of rates, so it is exact).
  * The real-time graph comes from an in-memory ring buffer and is pushed over WebSocket.
"""
import asyncio
import base64
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import sqlite3
import tempfile
import time
from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

HOST = os.getenv("SNMP_HOST", "127.0.0.1")
DEMO = os.getenv("DEMO", "") == "1"      # demo mode: simulated data, no SNMP device needed
if DEMO:
    HOST = "demo-router"
PORT = os.getenv("SNMP_PORT", "161")
VERSION = os.getenv("SNMP_VERSION", "2c")
COMMUNITY = os.getenv("SNMP_COMMUNITY", "public")
EXTRA_ARGS = os.getenv("SNMP_EXTRA_ARGS", "")
INTERVAL = float(os.getenv("POLL_INTERVAL", "1"))
RAW_RETENTION_HOURS = int(os.getenv("RAW_RETENTION_HOURS", "48"))
AGG_RETENTION_DAYS = int(os.getenv("AGG_RETENTION_DAYS", "800"))

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "traffic-demo.db" if DEMO else "traffic.db")
RRD_BIN = shutil.which("rrdtool")
RRD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "rrd-demo" if DEMO else "rrd")
os.makedirs(RRD_DIR, exist_ok=True)
BUCKET = 300                 # 5 minutes (same as the RRD step)
RT_SECONDS = 900             # 15 minutes of live data kept in memory
RT_POINTS = int(RT_SECONDS / INTERVAL) + 10
DISCOVERY_EVERY = 60         # interface list refresh (seconds)
MAX_OIDS = 40                # max OIDs per snmpget
MAX_AGG_POINTS = 800
MAX_GAP = 30 * 86400         # gaps longer than this are not spread over buckets
# snmpd caches counters itself (default ~3 s). If the counters do not change for longer
# than this, the interface is treated as idle.
STALE_SECONDS = float(os.getenv("STALE_SECONDS", "10"))
POINT_GAP = max(5 * INTERVAL, 2 * STALE_SECONDS + 1)   # no live point is plotted for gaps longer than this

OID_IFX = "1.3.6.1.2.1.31.1.1.1"   # ifXTable

# ---------------------------------------------------------------- database
wdb = sqlite3.connect(DB_PATH, check_same_thread=False)
wdb.execute("PRAGMA journal_mode=WAL")
wdb.execute("PRAGMA synchronous=NORMAL")
wdb.executescript(
    """
    CREATE TABLE IF NOT EXISTS raw (
        ts REAL NOT NULL, iface TEXT NOT NULL,
        in_oct INTEGER NOT NULL, out_oct INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_raw ON raw (iface, ts);
    CREATE TABLE IF NOT EXISTS agg5m (
        iface TEXT NOT NULL, bucket INTEGER NOT NULL,
        in_bytes REAL NOT NULL, out_bytes REAL NOT NULL, covered REAL NOT NULL,
        peak_in REAL NOT NULL, peak_out REAL NOT NULL,
        PRIMARY KEY (iface, bucket)
    ) WITHOUT ROWID;
    """
)
wdb.commit()

UPSERT = (
    "INSERT INTO agg5m(iface,bucket,in_bytes,out_bytes,covered,peak_in,peak_out) "
    "VALUES (?,?,?,?,?,?,?) ON CONFLICT(iface,bucket) DO UPDATE SET "
    "in_bytes=excluded.in_bytes, out_bytes=excluded.out_bytes, "
    "covered=excluded.covered, peak_in=excluded.peak_in, peak_out=excluded.peak_out"
)

# ---------------------------------------------------------------- state
class Iface:
    __slots__ = ("idx", "speed", "desc", "prev", "rt")

    def __init__(self, idx, speed, desc=""):
        self.idx = idx
        self.speed = speed
        self.desc = desc                      # ifAlias (interface description on the device)
        self.prev = None                      # (ts, in_octets, out_octets)
        self.rt = deque(maxlen=RT_POINTS)     # (ts_ms, in_bps, out_bps)


ifaces: dict[str, Iface] = {}
buckets: dict[tuple, list] = {}   # (name, bucket_start) -> [in_B, out_B, covered, peak_in, peak_out]
dirty: set = set()
pending_raw: list = []
clients: set = set()
status = {"last_poll": None, "error": None, "rrd_error": None, "polls": 0}


def get_bucket(name, b):
    key = (name, b)
    bk = buckets.get(key)
    if bk is None:
        row = wdb.execute(
            "SELECT in_bytes,out_bytes,covered,peak_in,peak_out FROM agg5m "
            "WHERE iface=? AND bucket=?", key).fetchone()
        bk = list(row) if row else [0.0, 0.0, 0.0, 0.0, 0.0]
        buckets[key] = bk
    return bk


def calc(prev, cur):
    dt = cur[0] - prev[0]
    if dt <= 0:
        return None
    din, dout = cur[1] - prev[1], cur[2] - prev[2]
    if din < 0 or dout < 0:      # counter reset (reboot / interface recreated)
        return None
    return dt, din, dout, din * 8 / dt, dout * 8 / dt


def add_interval(name, t0, t1, din, dout, in_bps, out_bps):
    """Spread the bytes of the interval [t0,t1] over the 5-minute buckets."""
    total = t1 - t0
    if total > MAX_GAP:
        return
    short = total <= max(3 * INTERVAL + 1, STALE_SECONDS)
    b = int(t0 // BUCKET) * BUCKET
    while b < t1:
        lo, hi = max(t0, b), min(t1, b + BUCKET)
        if hi > lo:
            frac = (hi - lo) / total
            bk = get_bucket(name, b)
            bk[0] += din * frac
            bk[1] += dout * frac
            bk[2] += hi - lo
            if short:
                bk[3] = max(bk[3], in_bps)
                bk[4] = max(bk[4], out_bps)
            dirty.add((name, b))
        b += BUCKET


def advance(name, st, cur, record=True):
    """Process a new counter sample. Returns a live point (ts, in_bps, out_bps) or None.

    * If the counters did not change (snmpd cache) nothing happens; the next new value
      yields the average rate over the whole period.
    * If they stay unchanged for longer than STALE_SECONDS the interface is truly idle (rate 0).
    """
    prev = st.prev
    if prev is None:
        st.prev = cur
        return None
    if cur[1] == prev[1] and cur[2] == prev[2]:
        gap = cur[0] - prev[0]
        if gap >= STALE_SECONDS:
            if record and gap <= MAX_GAP:
                add_interval(name, prev[0], cur[0], 0, 0, 0.0, 0.0)
            st.prev = cur
            return (cur[0], 0.0, 0.0)
        return None
    r = calc(prev, cur)
    st.prev = cur
    if r is None:                       # counter reset
        return None
    dt, din, dout, ib, ob = r
    if record:
        add_interval(name, prev[0], cur[0], din, dout, ib, ob)
    return (cur[0], ib, ob) if dt <= POINT_GAP else None


def restore(name, st):
    """After a restart: restore the last counters and 15 minutes of live data from the DB."""
    rows = wdb.execute(
        "SELECT ts,in_oct,out_oct FROM raw WHERE iface=? AND ts>=? ORDER BY ts",
        (name, time.time() - RT_SECONDS)).fetchall()
    if not rows:
        st.prev = wdb.execute(
            "SELECT ts,in_oct,out_oct FROM raw WHERE iface=? ORDER BY ts DESC LIMIT 1",
            (name,)).fetchone()     # the gap is recovered at the next new value
        return
    st.prev = rows[0]
    for row in rows[1:]:
        pt = advance(name, st, row, record=False)
        if pt:
            st.rt.append((int(pt[0] * 1000), pt[1], pt[2]))


# ---------------------------------------------------------------- DEMO (simulated traffic)
# (name, link speed in Mbps, peak incoming bps, peak outgoing bps)
DEMO_IFACES = [
    ("ether1-WAN", 1000, 420e6, 90e6),
    ("ether2-LAN", 1000, 70e6, 300e6),
    ("ether5-Office", 1000, 120e6, 35e6),
    ("wlan1-WiFi", 300, 60e6, 18e6),
    ("vlan10-Guest", 1000, 25e6, 8e6),
]
_demo_cnt: dict = {}
_demo_last = [None]


def _bump(h, c, w):
    return math.exp(-(((h - c) / w) ** 2))


def demo_rate(i, t):
    """Realistic (in_bps, out_bps) by time of day: rises in the daytime, falls at night, occasional bursts."""
    import random
    _name, speed, pin, pout = DEMO_IFACES[i]
    lt = time.localtime(t)
    hour = lt.tm_hour + lt.tm_min / 60
    day = 0.10 + 0.60 * _bump(hour, 13, 4.5) + 0.35 * _bump(hour, 21, 2.5)
    if lt.tm_wday >= 4:           # Fri-Sun are lower
        day *= 0.65
    def smooth(seed):
        # smooth interpolation between 30-second random values + a little jitter
        k, fr = divmod(t, 30)
        a = random.Random(int(k) * 7919 + i * 104729 + seed).random()
        b = random.Random(int(k + 1) * 7919 + i * 104729 + seed).random()
        j = random.Random(int(t) * 31 + i + seed).random()
        return 0.82 + 0.36 * (a + (b - a) * fr / 30) + 0.04 * (j - 0.5)

    f_in = day * smooth(0)
    f_out = day * smooth(1)
    blk = random.Random(int(t // 1200) * 31337 + i * 7)
    if blk.random() < 0.12 and (t % 1200) < 240:      # 4-minute burst
        f_in *= 1.9
        f_out *= 1.6
    cap = speed * 1e6 * 0.95
    return min(pin * f_in, cap), min(pout * f_out, cap)


def demo_values(ts):
    """Return counters like a real SNMP reply (by integrating the rate)."""
    last = _demo_last[0]
    dt = ts - last if last else 0.0
    out = {}
    for i in range(len(DEMO_IFACES)):
        ri, ro = demo_rate(i, ts)
        c = _demo_cnt.setdefault(i, [5e12 + i * 1e12, 2e12 + i * 5e11])
        c[0] += ri * dt / 8
        c[1] += ro * dt / 8
        out[f"{OID_IFX}.6.{i + 1}"] = str(int(c[0]))
        out[f"{OID_IFX}.10.{i + 1}"] = str(int(c[1]))
    _demo_last[0] = ts
    return out


def seed_demo(days=3):
    """On first run, fill in 3 days of 5-minute history so the graph is populated from the start."""
    now_b = int(time.time() // BUCKET) * BUCKET
    rows = []
    for i, (name, *_rest) in enumerate(DEMO_IFACES):
        if wdb.execute("SELECT COUNT(*) FROM agg5m WHERE iface=?", (name,)).fetchone()[0]:
            continue
        for b in range(now_b - days * 86400, now_b, BUCKET):
            rs = [demo_rate(i, b + BUCKET * (k + 0.5) / 5) for k in range(5)]
            ri = sum(r[0] for r in rs) / 5
            ro = sum(r[1] for r in rs) / 5
            rows.append((name, b, ri * BUCKET / 8, ro * BUCKET / 8, float(BUCKET),
                         max(r[0] for r in rs) * 1.3, max(r[1] for r in rs) * 1.3))
    if rows:
        with wdb:
            wdb.executemany("INSERT OR REPLACE INTO agg5m VALUES (?,?,?,?,?,?,?)", rows)


def demo_prefill(i, st):
    """Pre-fill the last 15 minutes of data for the live graph."""
    now = time.time()
    step = max(1, int(INTERVAL))
    for k in range(RT_SECONDS, 0, -step):
        t = now - k
        ri, ro = demo_rate(i, t)
        st.rt.append((int(t * 1000), ri, ro))


# ---------------------------------------------------------------- SNMP
def snmp_cmd(tool):
    cmd = [tool, "-v", VERSION]
    if VERSION == "3":
        cmd += shlex.split(EXTRA_ARGS)
    else:
        cmd += ["-c", COMMUNITY]
    return cmd + ["-Oqn", "-t", "2", "-r", "1"]


async def run(cmd, cwd=None, timeout=10):
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("SNMP command timed out")
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


def parse(out):
    res = {}
    for line in out.splitlines():
        p = line.split(None, 1)
        if len(p) == 2:
            res[p[0].lstrip(".")] = p[1].strip().strip('"')
    return res


async def _snmp_discover():
    rc, out, err = await run(snmp_cmd("snmpbulkwalk") + [f"{HOST}:{PORT}", OID_IFX])
    if rc != 0 and not out.strip():
        raise RuntimeError(err.strip() or "snmpbulkwalk failed")
    found, prefix = {}, OID_IFX + "."
    for oid, val in parse(out).items():
        if not oid.startswith(prefix):
            continue
        col, _, idx = oid[len(prefix):].partition(".")
        d = found.setdefault(idx, {})
        if col == "1":
            d["name"] = val
        elif col == "6":
            d["hc"] = True
        elif col == "15":
            try:
                d["speed"] = int(val)
            except ValueError:
                pass
        elif col == "18":
            d["desc"] = val.strip("* ")       # Junos descriptions are often wrapped in ***
    current = {}
    for idx, d in found.items():
        if d.get("hc"):
            current[d.get("name") or f"if{idx}"] = (idx, d.get("speed", 0), d.get("desc", ""))
    if not current:
        raise RuntimeError(
            "No interface data found (check the community/view, or that ifHCInOctets is supported)")
    return current


async def discover():
    if DEMO:
        current = {n: (str(i + 1), spd, "") for i, (n, spd, _p, _q) in enumerate(DEMO_IFACES)}
    else:
        current = await _snmp_discover()
    for name, (idx, speed, desc) in current.items():
        st = ifaces.get(name)
        if st is None:
            st = ifaces[name] = Iface(idx, speed, desc)
            restore(name, st)
            if DEMO:
                demo_prefill(int(idx) - 1, st)
        st.idx, st.speed, st.desc = idx, speed, desc
    for name in list(ifaces):
        if name not in current:
            del ifaces[name]


async def fast_poll():
    items = list(ifaces.items())
    oids = []
    for _, st in items:
        oids += [f"{OID_IFX}.6.{st.idx}", f"{OID_IFX}.10.{st.idx}"]
    t_start = time.time()
    values = {}
    for i in range(0, 0 if DEMO else len(oids), MAX_OIDS):
        chunk = oids[i:i + MAX_OIDS]
        rc, out, err = await run(snmp_cmd("snmpget") + [f"{HOST}:{PORT}"] + chunk)
        if rc != 0 and not out.strip():
            raise RuntimeError(err.strip() or "snmpget failed")
        values.update(parse(out))
    if DEMO:
        values = demo_values(t_start)
    ts = (t_start + time.time()) / 2      # midpoint of the request

    rates = {}
    for name, st in items:
        try:
            cin = int(values[f"{OID_IFX}.6.{st.idx}"])
            cout = int(values[f"{OID_IFX}.10.{st.idx}"])
        except (KeyError, ValueError):
            continue
        cur = (ts, cin, cout)
        pending_raw.append((ts, name, cin, cout))
        pt = advance(name, st, cur)
        if pt:
            st.rt.append((int(pt[0] * 1000), pt[1], pt[2]))
            rates[name] = [pt[1], pt[2]]
    return ts, rates


def flush():
    global pending_raw
    if not pending_raw and not dirty:
        return
    agg_rows = [(n, b, *buckets[(n, b)]) for (n, b) in dirty]
    with wdb:
        if pending_raw:
            wdb.executemany("INSERT INTO raw VALUES (?,?,?,?)", pending_raw)
        if agg_rows:
            wdb.executemany(UPSERT, agg_rows)
    pending_raw = []
    dirty.clear()
    limit = int(time.time() // BUCKET) * BUCKET - 2 * BUCKET
    for key in [k for k in buckets if k[1] < limit]:
        del buckets[key]


def cleanup():
    with wdb:
        wdb.execute("DELETE FROM raw WHERE ts<?", (time.time() - RAW_RETENTION_HOURS * 3600,))
        wdb.execute("DELETE FROM agg5m WHERE bucket<?", (time.time() - AGG_RETENTION_DAYS * 86400,))


# ---------------------------------------------------------------- RRD (Cacti style)
rrd_next: dict = {}   # iface -> next 5-minute bucket to write to the RRD (bucket start time)


def rrd_file(name):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:40]
    return f"{safe}_{hashlib.md5(name.encode()).hexdigest()[:6]}.rrd"


async def rrd_create(fname, start):
    # Cacti default RRAs: 5 min x600, 30 min x700, 2 h x775, 1 day x797 (~2.2 years)
    cmd = [RRD_BIN, "create", fname, "--step", str(BUCKET), "--start", str(start),
           f"DS:in_bps:GAUGE:{BUCKET * 2}:0:U", f"DS:out_bps:GAUGE:{BUCKET * 2}:0:U"]
    for cf in ("AVERAGE", "MAX"):
        for n, rows in ((1, 600), (6, 700), (24, 775), (288, 797)):
            cmd.append(f"RRA:{cf}:0.5:{n}:{rows}")
    rc, out, err = await run(cmd, cwd=RRD_DIR)
    if rc != 0:
        raise RuntimeError(f"rrdtool create: {err.strip()}")


async def rrd_sync(name, st):
    """Write completed 5-minute buckets from SQLite (agg5m) into the RRD file.
    Old accumulated data (e.g. if rrdtool is installed later) is imported automatically."""
    if not RRD_BIN or st.prev is None:
        return
    fname = rrd_file(name)
    nxt = rrd_next.get(name)
    if nxt is None:
        if os.path.exists(os.path.join(RRD_DIR, fname)):
            rc, out, err = await run([RRD_BIN, "last", fname], cwd=RRD_DIR)
            if rc != 0:
                raise RuntimeError(f"rrdtool last: {err.strip()}")
            nxt = int(out.strip())
        else:
            row = wdb.execute("SELECT MIN(bucket) FROM agg5m WHERE iface=?", (name,)).fetchone()
            nxt = row[0] if row and row[0] is not None else int(time.time() // BUCKET) * BUCKET
            await rrd_create(fname, nxt)
        rrd_next[name] = nxt
    final_ts = int(st.prev[0])         # every bucket ending before this time is now final
    if final_ts < nxt + BUCKET:
        return
    rows = wdb.execute(
        "SELECT bucket,in_bytes,out_bytes,covered FROM agg5m "
        "WHERE iface=? AND bucket>=? AND bucket+?<=? ORDER BY bucket",
        (name, nxt, BUCKET, final_ts)).fetchall()
    ups = [f"{b + BUCKET}:{ib * 8 / c:.2f}:{ob * 8 / c:.2f}" for b, ib, ob, c in rows if c > 0]
    for i in range(0, len(ups), 100):
        rc, out, err = await run([RRD_BIN, "update", fname] + ups[i:i + 100], cwd=RRD_DIR)
        if rc != 0:
            rc2, o2, _ = await run([RRD_BIN, "last", fname], cwd=RRD_DIR)
            if rc2 == 0:
                rrd_next[name] = int(o2.strip())
            raise RuntimeError(f"rrdtool update: {err.strip()}")
    rrd_next[name] = (final_ts // BUCKET) * BUCKET


async def broadcast(msg):
    async def send(ws):
        try:
            await asyncio.wait_for(ws.send_text(msg), 1.0)
        except Exception:  # noqa: BLE001
            clients.discard(ws)
    if clients:
        await asyncio.gather(*(send(ws) for ws in list(clients)))


def friendly_error(msg):
    """Turn raw net-snmp errors into a message that says what to check."""
    low = msg.lower()
    if "timeout" in low or "no response" in low:
        return (f"{msg.strip()} - {HOST}:{PORT} did not answer. Check that: the device is reachable "
                "(ping), SNMP is enabled on it, the community/version in config.env match the device "
                "(a wrong v1/v2c community also looks like a timeout), and its firewall/ACL allows "
                "UDP 161 from this server. Run ./check-snmp.sh for a step-by-step test.")
    if "authentication" in low or "unknown user" in low or "wrong digest" in low or "decryption" in low:
        return f"{msg.strip()} - wrong SNMPv3 credentials (user, auth/priv protocol or passwords)."
    if "no such" in low:
        return f"{msg.strip()} - the device does not provide this OID (IF-MIB ifXTable, 64-bit counters)."
    return msg


async def poller():
    next_t = time.monotonic()
    last_disc = last_clean = 0.0
    while True:
        try:
            if not ifaces or time.monotonic() - last_disc > DISCOVERY_EVERY:
                await discover()
                last_disc = time.monotonic()
            ts, rates = await fast_poll()
            status["error"] = None
            status["last_poll"] = ts
            status["polls"] += 1
            if rates:
                await broadcast(json.dumps({"ts": int(ts * 1000), "rates": rates}))
        except Exception as e:  # noqa: BLE001
            status["error"] = friendly_error(str(e))
        try:
            flush()
            rrd_err = None
            for _name, _st in list(ifaces.items()):
                try:
                    await rrd_sync(_name, _st)
                except Exception as e:  # noqa: BLE001
                    rrd_err = str(e)
            status["rrd_error"] = rrd_err
            if time.monotonic() - last_clean > 3600:
                cleanup()
                last_clean = time.monotonic()
        except Exception as e:  # noqa: BLE001
            status["error"] = f"DB: {e}"   # data stays in memory and is retried on the next cycle
        next_t += INTERVAL
        delay = next_t - time.monotonic()
        if delay < 0:
            next_t, delay = time.monotonic(), 0
        await asyncio.sleep(delay)


@asynccontextmanager
async def lifespan(_app):
    if DEMO:
        seed_demo()
    task = asyncio.create_task(poller())
    yield
    task.cancel()
    try:
        flush()
    except Exception:  # noqa: BLE001
        pass


app = FastAPI(title="SNMP Bandwidth Monitor", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"])


# ---------------------------------------------------------------- API
@app.get("/api/status")
def get_status():
    return {"host": HOST, "interval": INTERVAL, "rrdtool": bool(RRD_BIN), "demo": DEMO, "ws_clients": len(clients),
            "pending_rows": len(pending_raw), **status}


@app.get("/api/interfaces")
def get_interfaces():
    out = []
    for name, st in sorted(ifaces.items()):
        last = st.rt[-1] if st.rt else None
        out.append({"name": name, "speed_mbps": st.speed, "desc": st.desc,
                    "in_bps": last[1] if last else None,
                    "out_bps": last[2] if last else None})
    return out


@app.get("/api/realtime")
def get_realtime(iface: str, seconds: int = Query(300, ge=10, le=RT_SECONDS)):
    st = ifaces.get(iface)
    if not st:
        return []
    cutoff = (time.time() - seconds) * 1000
    return [{"t": t, "in": i, "out": o} for (t, i, o) in list(st.rt) if t >= cutoff]


@app.get("/api/agg")
def get_agg(
    iface: str,
    hours: int | None = Query(None, ge=1),
    start: int | None = Query(None, description="epoch seconds"),
    end: int | None = Query(None, description="epoch seconds"),
):
    """Stored 5-minute data. Give the range with `start`+`end` (epoch seconds) or with `hours`.
    Only completed buckets are returned. For long ranges the points are reduced to ~800."""
    now_b = int(time.time() // BUCKET) * BUCKET
    if start is not None and end is not None:
        since = int(start // BUCKET) * BUCKET
        until = min(-(-int(end) // BUCKET) * BUCKET, now_b)       # ceil
    else:
        n_req = max(1, (hours or 24) * 3600 // BUCKET)
        since, until = now_b - n_req * BUCKET, now_b
    since = max(since, until - AGG_RETENTION_DAYS * 86400)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        bounds = conn.execute(
            "SELECT MIN(bucket), MAX(bucket) FROM agg5m WHERE iface=? AND bucket<?",
            (iface, now_b)).fetchone()
        n = (until - since) // BUCKET
        step = max(1, math.ceil(max(n, 1) / MAX_AGG_POINTS))
        size = BUCKET * step
        rows = []
        if until > since:
            rows = conn.execute(
                "SELECT (bucket/?)*? AS g, SUM(in_bytes), SUM(out_bytes), SUM(covered), "
                "MAX(peak_in), MAX(peak_out) FROM agg5m "
                "WHERE iface=? AND bucket>=? AND bucket<? GROUP BY g ORDER BY g",
                (size, size, iface, since, until)).fetchall()
    finally:
        conn.close()
    points, tin, tout = [], 0.0, 0.0
    for g, bi, bo, cov, pi, po in rows:
        if cov <= 0:
            continue
        tin += bi
        tout += bo
        points.append({"t": g * 1000, "in": bi * 8 / cov, "out": bo * 8 / cov,
                       "peak_in": pi, "peak_out": po,
                       "in_bytes": bi, "out_bytes": bo})
    return {
        "step_seconds": size, "points": points,
        "total_in_bytes": tin, "total_out_bytes": tout,
        "data_start": bounds[0] * 1000 if bounds and bounds[0] is not None else None,
        "data_end": (bounds[1] + BUCKET) * 1000 if bounds and bounds[1] is not None else None,
    }


GRAPH_KEYS = ("image_width", "image_height", "graph_left", "graph_top",
              "graph_width", "graph_height", "graph_start", "graph_end")


@app.get("/api/graph")
async def get_graph(
    iface: str,
    start: int,
    end: int,
    width: int = Query(600, ge=200, le=2400),
    height: int = Query(150, ge=80, le=800),
):
    """Cacti-style traffic graph (PNG drawn by RRDtool) + graph geometry (for zoom selection)."""
    if not RRD_BIN:
        return JSONResponse({"error": "rrdtool_missing"}, status_code=503)
    fname = rrd_file(iface)
    if not os.path.exists(os.path.join(RRD_DIR, fname)):
        return JSONResponse({"error": "no_rrd"}, status_code=404)
    if end <= start:
        return JSONResponse({"error": "bad_range"}, status_code=400)
    f = fname
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    mono = "DejaVu Sans Mono"
    args = [
        RRD_BIN, "graphv", tmp,
        "--imgformat", "PNG", "--start", str(start), "--end", str(end),
        "--width", str(width), "--height", str(height),
        "--title", f"{HOST} - Traffic - {iface}",
        "--vertical-label", "bits per second",
        "--lower-limit", "0", "--base", "1000", "--alt-autoscale-max", "--slope-mode",
        "--border", "1", "--watermark", "SNMP Traffic Monitor",
        "--color", "BACK#F3F3F3", "--color", "CANVAS#FDFDFD",
        "--color", "SHADEA#CBCBCB", "--color", "SHADEB#999999",
        "--color", "FONT#000000", "--color", "AXIS#2C4D43",
        "--color", "ARROW#2C4D43", "--color", "FRAME#2C4D43",
        "--font", f"TITLE:10:{mono}", "--font", f"AXIS:7:{mono}",
        "--font", f"LEGEND:8:{mono}", "--font", f"UNIT:7:{mono}",
        "--font", f"WATERMARK:6:{mono}",
        f"DEF:inavg={f}:in_bps:AVERAGE", f"DEF:outavg={f}:out_bps:AVERAGE",
        f"DEF:inmax={f}:in_bps:MAX", f"DEF:outmax={f}:out_bps:MAX",
        "CDEF:inbytes=inavg,8,/", "CDEF:outbytes=outavg,8,/",
        "VDEF:totin=inbytes,TOTAL", "VDEF:totout=outbytes,TOTAL",
        "AREA:inavg#00CF00FF:Inbound ",
        "GPRINT:inavg:LAST: Current\\:%8.2lf %s",
        "GPRINT:inavg:AVERAGE: Average\\:%8.2lf %s",
        "GPRINT:inmax:MAX: Maximum\\:%8.2lf %s\\n",
        "LINE1:outavg#002A97FF:Outbound",
        "GPRINT:outavg:LAST: Current\\:%8.2lf %s",
        "GPRINT:outavg:AVERAGE: Average\\:%8.2lf %s",
        "GPRINT:outmax:MAX: Maximum\\:%8.2lf %s\\n",
        "COMMENT:Total In\\: ", "GPRINT:totin:%8.2lf %sB",
        "COMMENT:   Total Out\\: ", "GPRINT:totout:%8.2lf %sB\\n",
    ]
    try:
        rc, out, err = await run(args, cwd=RRD_DIR, timeout=20)
        if rc != 0:
            return JSONResponse({"error": (err or out).strip()}, status_code=500)
        info = {}
        for line in out.splitlines():
            k, sep, v = line.partition(" = ")
            if sep and k.strip() in GRAPH_KEYS:
                info[k.strip()] = int(float(v))
        with open(tmp, "rb") as fh:
            png = fh.read()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    first = wdb.execute("SELECT MIN(bucket) FROM agg5m WHERE iface=?", (iface,)).fetchone()[0]
    return {**info, "image": "data:image/png;base64," + base64.b64encode(png).decode(),
            "data_first": first * 1000 if first else None}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)
