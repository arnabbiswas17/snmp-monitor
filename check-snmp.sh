#!/bin/bash
# Step-by-step SNMP connectivity test using the settings in config.env.
# Run this first if the page shows "Timeout: No Response".
cd "$(dirname "$0")"
[ -f ./config.env ] || { echo "config.env not found. Run: cp config.env.example config.env  (then set SNMP_HOST / SNMP_COMMUNITY)"; exit 1; }
source ./config.env
HOST="$SNMP_HOST"; PORT="${SNMP_PORT:-161}"; VER="${SNMP_VERSION:-2c}"

command -v snmpget >/dev/null || { echo "snmpget not found. Run: sudo apt install snmp"; exit 1; }
if [ "$VER" = "3" ]; then AUTH=($SNMP_EXTRA_ARGS); else AUTH=(-c "$SNMP_COMMUNITY"); fi

echo "Target : $HOST:$PORT   SNMP version: $VER"
[ "$VER" != "3" ] && echo "Community: $SNMP_COMMUNITY   (must match the device exactly, case-sensitive)"
echo

echo "[1/4] Ping"
if ping -c 2 -W 2 "$HOST" >/dev/null 2>&1; then
  echo "  OK    host answers ping"
else
  echo "  --    no ping reply (ICMP may simply be blocked; continuing)"
fi

echo "[2/4] SNMP GET sysDescr (v$VER)"
OUT=$(snmpget -v"$VER" "${AUTH[@]}" -t 3 -r 1 -Oqv "$HOST:$PORT" 1.3.6.1.2.1.1.1.0 2>&1); RC=$?
if [ $RC -eq 0 ]; then
  echo "  OK    $OUT"
else
  echo "  FAIL  $OUT"
  if [ "$VER" != "3" ]; then
    echo "[3/4] Trying SNMP v1 with the same community"
    OUT1=$(snmpget -v1 -c "$SNMP_COMMUNITY" -t 3 -r 1 -Oqv "$HOST:$PORT" 1.3.6.1.2.1.1.1.0 2>&1)
    if [ $? -eq 0 ]; then
      echo "  OK    v1 works: $OUT1"
      echo "        -> set SNMP_VERSION=1 in config.env (note: v1 has no 64-bit counters)"
    else
      echo "  FAIL  $OUT1"
    fi
  fi
  echo
  echo "No SNMP reply. Most common causes, in order:"
  echo "  1. SNMP is not enabled on the device."
  echo "       MikroTik : /snmp set enabled=yes      then check: /snmp community print"
  echo "       Linux    : snmpd must listen on the network (agentaddress udp:161), not only 127.0.0.1"
  echo "  2. Wrong community (or version). On v1/v2c a wrong community gives NO answer, so it looks like a timeout."
  echo "       Set the right value in config.env (SNMP_COMMUNITY / SNMP_VERSION)."
  echo "  3. The device only allows certain source IPs. Allow THIS server's IP:"
  echo "       MikroTik : /snmp community set <name> addresses=<this-server-ip>/32"
  echo "       Linux    : rocommunity <name> <this-server-ip>"
  echo "  4. A firewall blocks UDP 161 (on the device, on a router in between, or on this server)."
  echo "  5. Wrong IP or port in config.env (SNMP_HOST / SNMP_PORT)."
  exit 1
fi

echo "[3/4] Interface list (ifName)"
snmpbulkwalk -v"$VER" "${AUTH[@]}" -t 3 -r 1 -Oqn "$HOST:$PORT" 1.3.6.1.2.1.31.1.1.1.1 2>&1 | head -12

echo "[4/4] 64-bit counters (ifHCInOctets)"
HC=$(snmpbulkwalk -v"$VER" "${AUTH[@]}" -t 3 -r 1 -Oqn "$HOST:$PORT" 1.3.6.1.2.1.31.1.1.1.6 2>&1 | head -3)
if echo "$HC" | grep -q "^\.1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.6\."; then
  echo "  OK    device provides 64-bit counters"; echo "$HC"
else
  echo "  FAIL  no ifHCInOctets: $HC"
  echo "        The monitor needs 64-bit counters (SNMP v2c or v3)."
  exit 1
fi
echo
echo "All good. Start the app with: ./run.sh"
