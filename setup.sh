#!/bin/bash
# Ubuntu 24.04: installs everything needed (skipping what is already installed)
set -e
cd "$(dirname "$0")"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

need=()
[ -n "$DEMO_ONLY" ] || command -v snmpget >/dev/null || need+=(snmp)
command -v rrdtool  >/dev/null || need+=(rrdtool)
fc-list 2>/dev/null | grep -qi "dejavu sans mono" || need+=(fonts-dejavu-core)
command -v python3  >/dev/null || need+=(python3)
python3 -c "import ensurepip" 2>/dev/null || need+=(python3-venv python3-pip)
command -v node >/dev/null || need+=(nodejs)
command -v npm  >/dev/null || need+=(npm)

if [ ${#need[@]} -gt 0 ]; then
  echo "==> Will install: ${need[*]}"
  sudo apt update || true
  sudo apt install -y "${need[@]}"
else
  echo "==> All system packages are already installed"
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
echo "==> Node $(node -v), npm $(npm -v)"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "Node 18+ is required (run: nvm install 20)"; exit 1; fi

echo "==> Python virtualenv + packages"
python3 -m venv backend/.venv
backend/.venv/bin/pip install --upgrade pip
backend/.venv/bin/pip install -r backend/requirements.txt

echo "==> Frontend packages"
(cd frontend && npm install)

echo
echo "Setup complete. Now run:  ./run.sh"
