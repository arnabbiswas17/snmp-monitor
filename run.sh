#!/bin/bash
# Starts the backend (port 8000) + frontend (port 5173) together
cd "$(dirname "$0")"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
[ -f ./config.env ] || { echo "config.env not found. Run: cp config.env.example config.env  (then set SNMP_HOST / SNMP_COMMUNITY)"; exit 1; }
source ./config.env

cleanup() { echo; echo "Stopping..."; kill $BACK_PID 2>/dev/null; exit 0; }
trap cleanup INT TERM

(cd backend && ./.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000 --no-access-log --log-level warning) &
BACK_PID=$!

sleep 1
echo "Backend  : http://localhost:8000/api/status"
echo "Frontend : http://localhost:5173"
(cd frontend && npm run dev -- --host 0.0.0.0)
cleanup
