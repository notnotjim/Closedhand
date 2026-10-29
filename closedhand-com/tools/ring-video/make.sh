#!/bin/sh
# Films the desktop home page's smoke ring for phones and tablets, which play
# it as a small looping video instead of running 3D, with the page's own
# words inside it. The ring uses the desktop's own shaders, read from
# views/home.html, so a change there is filmed exactly. Two films: the dark
# theme's (smoke.*) and the light theme's (smoke-light.*), each played on a
# page in its own theme, so neither is ever filtered into the other.
# Needs Google Chrome, Node, ffmpeg with hevc_videotoolbox and libvpx-vp9
# (macOS), and Python 3 with Pillow. CHROME= another Chrome; ONLY=light or
# dark films one; PREVIEW="0,66,133" writes just those frames, on each
# theme's ground, to $PREVIEW_DIR for a look before filming.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
python3 - "$ROOT/views/home.html" "$HERE/shaders.js" <<'PY'
import sys
s = open(sys.argv[1]).read()
def take(start):
    a = s.index(start); b = s.index("].join('\\n');", a) + len("].join('\\n');")
    return s[a:b]
open(sys.argv[2], 'w').write(take("  var vertexShader = [") + "\n" + take("  var fragmentShader = [") + "\n")
PY

film() { # theme, file name stem
  WORK="$(mktemp -d)"
  if [ "$1" = light ]; then export FILM_QUERY="light"; GROUND="#EFE6D6"; else export FILM_QUERY=""; GROUND="#100E0D"; fi
  if [ -n "$PREVIEW" ]; then
    node "$HERE/film.js" 200 0.0375 "$WORK/frames" "$PREVIEW"
    mkdir -p "$PREVIEW_DIR"
    python3 - "$WORK/frames" "$PREVIEW_DIR" "$2" "$GROUND" <<'PY'
import glob, os, sys
from PIL import Image
src, out, stem, ground = sys.argv[1:5]
for p in sorted(glob.glob(src + '/f*.png')):
    im = Image.open(p).convert('RGBA').resize((648, 648), Image.LANCZOS)
    bg = Image.new('RGBA', im.size, ground)
    Image.alpha_composite(bg, im).convert('RGB').save(os.path.join(out, stem + '-' + os.path.basename(p)))
PY
    rm -rf "$WORK"; return
  fi
  # 200 frames make a 10 second loop at 20 frames a second. 0.0375 is the
  # smoke's drift through the noise (with the ring's sway in film.html).
  node "$HERE/film.js" 200 0.0375 "$WORK/frames"
  cd "$WORK"
  # Frames are 1296 pixels (see film.html); the videos are 648, what a phone
  # shows (216 CSS pixels at three device pixels each), so nothing is blown up.
  ffmpeg -hide_banner -loglevel error -y -framerate 20 -i frames/f%04d.png -vf "scale=648:648:flags=lanczos" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 900k -pass 1 -row-mt 1 -deadline good -an -f null /dev/null
  ffmpeg -hide_banner -loglevel error -y -framerate 20 -i frames/f%04d.png -vf "scale=648:648:flags=lanczos" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 900k -pass 2 -row-mt 1 -deadline good -an "$ROOT/public/orb/$2.webm"
  # Safari's HEVC transparency expects colour already multiplied by its
  # opacity; handed plain colour it shows every faint wisp at full strength.
  # Its opacity is kept at 0.7: finer wisps than 0.5, and much over 0.7 the
  # film grows fast (1.0 stores it nearly losslessly, 8 MB for 10 seconds).
  python3 - <<'PY'
import glob, os
from PIL import Image, ImageChops
os.makedirs('premultiplied', exist_ok=True)
for p in sorted(glob.glob('frames/f*.png')):
    r, g, b, a = Image.open(p).convert('RGBA').split()
    Image.merge('RGBA', [ImageChops.multiply(c, a) for c in (r, g, b)] + [a]).save('premultiplied/' + os.path.basename(p))
PY
  # Without Apple's hardware encoder (GitHub's Mac) the bitrate is ignored, so
  # there the premultiplied frames are kept losslessly (LOSSLESS_DIR) for
  # mov.sh to encode on a Mac that has one.
  if [ -n "$LOSSLESS_DIR" ]; then
    mkdir -p "$LOSSLESS_DIR"
    ffmpeg -hide_banner -loglevel error -y -framerate 20 -i premultiplied/f%04d.png -vf "scale=648:648:flags=lanczos" -c:v ffv1 -pix_fmt bgra -an "$LOSSLESS_DIR/$2.mkv"
  else
    ffmpeg -hide_banner -loglevel error -y -framerate 20 -i premultiplied/f%04d.png -vf "scale=648:648:flags=lanczos" -c:v hevc_videotoolbox -alpha_quality 0.7 -b:v 1200k -tag:v hvc1 -an "$ROOT/public/orb/$2.mov"
  fi
  python3 -c "
from PIL import Image
im = Image.open('frames/f0000.png').convert('RGBA').resize((648, 648), Image.LANCZOS)
im.quantize(colors=255, method=Image.Quantize.FASTOCTREE).save('$ROOT/public/orb/$2-poster.png', optimize=True)"
  cd "$HERE"; rm -rf "$WORK"
  echo "Wrote public/orb/$2.webm, $2.mov and $2-poster.png"
}

[ "$ONLY" = light ] || film dark smoke
[ "$ONLY" = dark ] || film light smoke-light
rm -f "$HERE/shaders.js"
