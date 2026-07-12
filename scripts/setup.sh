#!/usr/bin/env bash
# One-time setup: fetch the Tectonic binary and create the Python venv the
# agent's run_python/view_pdf/ats_check tools use. Idempotent — safe to rerun.
#
#   npm run setup            # everything
#   SKIP_VENV=1 npm run setup  # tectonic only
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Tectonic (LaTeX engine) — the server runs bin/tectonic (or TECTONIC_BIN).
if [ -x bin/tectonic ]; then
  echo "tectonic: bin/tectonic already present"
elif command -v tectonic >/dev/null 2>&1; then
  echo "tectonic: linking system binary $(command -v tectonic) into bin/"
  mkdir -p bin
  ln -s "$(command -v tectonic)" bin/tectonic
else
  echo "tectonic: downloading into bin/"
  mkdir -p bin
  (cd bin && curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh)
fi

# 2. Python venv for the agent's figure/PDF tools (optional: SKIP_VENV=1).
if [ "${SKIP_VENV:-}" = "1" ]; then
  echo "venv: skipped (SKIP_VENV=1)"
elif [ -x server/.venv/bin/python ]; then
  echo "venv: server/.venv already present"
else
  echo "venv: creating server/.venv (see server/requirements.txt)"
  python3 -m venv server/.venv
  server/.venv/bin/pip install --quiet -r server/requirements.txt
fi

echo "setup: done — run 'npm run dev' (development) or 'npm run build && npm start' (production)"
