#!/bin/bash
# DEMO mode: no SNMP device or snmpd needed.
# Starts the app with 5 simulated interfaces + the last 3 days of 5-minute history.
cd "$(dirname "$0")"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

if [ ! -x backend/.venv/bin/uvicorn ] || [ ! -d frontend/node_modules ]; then
  echo "==> First run: installing dependencies (without SNMP tools)..."
  DEMO_ONLY=1 ./setup.sh || exit 1
fi
if ! command -v rrdtool >/dev/null; then
  echo "rrdtool is missing. Run: sudo apt install rrdtool"; exit 1
fi

# Fresh demo data every time (your real traffic.db / rrd/ are never touched)
rm -rf backend/traffic-demo.db* backend/rrd-demo

export DEMO=1 POLL_INTERVAL=1

cleanup() { echo; echo "Stopping demo..."; kill $BACK_PID 2>/dev/null; exit 0; }
trap cleanup INT TERM

(cd backend && ./.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log --log-level warning) &
BACK_PID=$!

echo -n "Starting backend"
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:8000/api/status >/dev/null 2>&1 && break
  echo -n "."; sleep 0.5
done
echo
echo "=============================================="
echo "  DEMO running:  http://localhost:5173"
echo "  (simulated data • press Ctrl+C to stop)"
echo "=============================================="
( sleep 3; command -v xdg-open >/dev/null && xdg-open http://localhost:5173 >/dev/null 2>&1 ) &
(cd frontend && npm run dev -- --host 127.0.0.1)
cleanup
