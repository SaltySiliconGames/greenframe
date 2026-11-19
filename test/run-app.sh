#!/usr/bin/env bash
# End-to-end test without an Xbox: a local page streams a canvas (video), a tone (audio) and a data channel over
# WebRTC loopback; GreenFrame hooks it like xbox.com/play, and a fake bridge (no shared memory) saves the H.264 it
# receives, asking for a keyframe every 3 s like SmoovPlay. Then ffmpeg checks every frame decodes.
#   Needs: node + npm (app deps installed), python3, ffmpeg; on Linux without a display, xvfb-run.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
python3 -m http.server 8765 --directory test/www >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
RUN=(npx electron --no-sandbox .)
command -v xvfb-run >/dev/null && [ -z "${DISPLAY:-}" ] && RUN=(xvfb-run -a "${RUN[@]}")
(cd app && GREENFRAME_URL="http://localhost:8765/loopback.html" GREENFRAME_PYTHON=python3 \
  GREENFRAME_BRIDGE_ARGS="--fake --save $OUT/stream.h264 --allow-origin http://localhost --fake-idr-every 3" \
  timeout 20 "${RUN[@]}" >"$OUT/electron.log" 2>&1) || true
LOGS="${XDG_CONFIG_HOME:-$HOME/.config}/GreenFrame/logs"
grep "TEST" "$LOGS/page.log" | tail -2
grep -E "live|keyframe arrived" "$LOGS/bridge.log" | tail -4
ERR=$(ffmpeg -threads 1 -v error -f h264 -i "$OUT/stream.h264" -f null - 2>&1 | wc -l)
FRAMES=$(ffprobe -v error -f h264 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$OUT/stream.h264")
echo "frames: $FRAMES, decode errors: $ERR"
[ "$FRAMES" -gt 300 ] && [ "$ERR" -eq 0 ] && echo PASS || { echo FAIL; exit 1; }
