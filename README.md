# SNMP Interface Traffic Monitor

Python (FastAPI) + React (Vite) + RRDtool (the storage format used by Cacti)

    ./setup.sh     # once (installs everything, including rrdtool)
    ./run.sh       # start -> http://localhost:5173

## Quick start

1. `cp config.env.example config.env`, then edit `config.env`: set `SNMP_HOST`, `SNMP_COMMUNITY` (or SNMPv3 settings).
   `config.env` is git-ignored, so the community / passwords are never committed.
2. `./check-snmp.sh` - tests the connection step by step.
3. `./run.sh`

## Demo (no SNMP device needed)

    ./demo.sh      # -> http://localhost:5173 (opens the browser by itself)

- 5 simulated interfaces (ether1-WAN, ether2-LAN, ether5-Office, wlan1-WiFi, vlan10-Guest)
- The last 3 days of 5-minute history are pre-loaded, so the Cacti graph is full from the start
- The live graph also runs on simulated traffic; a "DEMO" badge is shown in the header
- Your real data (`traffic.db`, `rrd/`) is never touched; demo data lives in `traffic-demo.db` and `rrd-demo/`
- Starts fresh every time. Stop with Ctrl+C
- Needs `rrdtool` (to draw graphs). No snmpd / SNMP tools needed

## What is on the page

- Pick the interface from the dropdown at the top
- Left: live graph (WebSocket, updates every second)
- Right: Cacti-style traffic graph (drawn by RRDtool)
  - Green area = Inbound, blue line = Outbound
  - Legend with Current / Average / Maximum and Total In / Out
  - Every 5 minutes the new data enters from the right and the graph moves left
  - Drag on the graph to select a range = zoom to it (like Cacti)
  - Scroll = zoom in/out, the arrows move back/forward in time, "Back to latest" returns to live
  - Time range dropdown (30 minutes to 1 year) and From / To date-time boxes

## Where the data is stored

| What | Where | Purpose |
|---|---|---|
| 5-minute graph data | `backend/rrd/<interface>.rrd` | fixed size (~95 KB), fast, ~2.2 years of history |
| Raw counters and the in-progress 5-minute totals | `backend/traffic.db` (SQLite) | recovers the data of gaps (app stopped, poll failed) |

The RRD files use Cacti's default archives: 5 min x600, 30 min x700, 2 h x775, 1 day x797 (AVERAGE and MAX).
If the app was stopped, or rrdtool is installed later, the accumulated data is imported into the RRDs automatically.

## Monitoring servers and routers

- Install only the `snmp` client tools on the machine that runs this app (`setup.sh` does it).
- The monitored device must have SNMP enabled and must allow this server's IP.
  - MikroTik: `/snmp set enabled=yes` and `/snmp community set <name> addresses=<monitor-ip>/32`
  - Linux server: install `snmpd`, set `agentaddress udp:161` and `rocommunity <name> <monitor-ip>`
- Use 64-bit counters (SNMP v2c or v3); the monitor reads `ifHCInOctets` / `ifHCOutOctets`.

## Troubleshooting: "Timeout: No Response from <ip>:161"

The device did not answer the SNMP request. Run `./check-snmp.sh`, then check in this order:

1. SNMP is enabled on the device.
2. `SNMP_COMMUNITY` and `SNMP_VERSION` in `config.env` match the device. With v1/v2c a wrong community
   gets no answer at all, so it looks exactly like a timeout.
3. The device allows this server's IP as a source (community "addresses" / ACL).
4. UDP port 161 is not blocked by a firewall (device, routers in between, or this server).
5. `SNMP_HOST` / `SNMP_PORT` are correct.

## API

- `GET /api/status`, `/api/interfaces`
- `GET /api/realtime?iface=lo&seconds=300`
- `GET /api/graph?iface=lo&start=<epoch>&end=<epoch>&width=600&height=150`
- `GET /api/agg?iface=lo&start=<epoch>&end=<epoch>` (SQLite data as JSON)
- `WS /ws`

## Notes

snmpd caches its counters (about 3 seconds), so live points arrive at that rate.
Byte totals are not affected: counters accumulate, so no bytes are lost between polls.
