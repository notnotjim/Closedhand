#!/bin/sh
# Safari's films (smoke.mov, smoke-light.mov) from the lossless, premultiplied
# copies make.sh keeps when it runs where there is no hardware HEVC encoder
# (GitHub's Mac, LOSSLESS_DIR): encoded here with Apple's, which keeps to the
# bitrate. Usage: mov.sh <folder with smoke.mkv and smoke-light.mkv>
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
for name in smoke smoke-light; do
  [ -f "$1/$name.mkv" ] || continue
  ffmpeg -hide_banner -loglevel error -y -i "$1/$name.mkv" -c:v hevc_videotoolbox -alpha_quality 0.7 -b:v 1200k -tag:v hvc1 -an "$ROOT/public/orb/$name.mov"
  echo "Wrote public/orb/$name.mov"
done
