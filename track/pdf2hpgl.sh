#!/bin/bash
# pdf2hpgl.sh - convert PDF/PS/EPS linework to HPGL for a pen plotter.
#
# Pipeline: ghostscript (ps2write) -> pstoedit (hpgl) -> fit/rotate/pen transform.
#
# The ghostscript step exists because ghostscript >= 9.57 dropped the PostScript
# based PDF interpreter, so pstoedit can no longer read PDF directly -- it emits
# an empty file with a warning. Converting to PostScript first restores it.
#
# The transform step exists because pstoedit's hpgl driver has no bed-size or
# pen-number option: it emits a fixed scale and assigns pens only from source
# colors. Safe to post-process because the driver flattens all curves to line
# segments, so an affine transform is exact.

set -euo pipefail

PEN=4
BED_X=10300
BED_Y=7650
MARGIN=0
ROTATE=auto
MULTIPEN=0
KEEP=0

usage() {
    cat <<'USAGE'
usage: pdf2hpgl.sh [options] input.pdf [output.hpgl]

  -p N      pen number for all linework (default: 4)
  -b WxH    plotter bed size in plotter units (default: 10300x7650)
  -m N      margin in plotter units, all four sides (default: 0)
  -r R      rotation: auto|0|90|180|270 (default: auto -- picks whichever
            of 0/90 fits the bed at the larger scale)
  -M        multi-pen: keep pstoedit's colour-to-pen mapping instead of
            forcing every stroke to one pen
  -k        keep intermediate .ps / raw .hpgl files
  -h        show this help

Output defaults to the input name with a .hpgl extension.
USAGE
}

while getopts ":p:b:m:r:Mkh" opt; do
    case $opt in
        p) PEN=$OPTARG ;;
        b) BED_X=${OPTARG%%x*}; BED_Y=${OPTARG##*x} ;;
        m) MARGIN=$OPTARG ;;
        r) ROTATE=$OPTARG ;;
        M) MULTIPEN=1 ;;
        k) KEEP=1 ;;
        h) usage; exit 0 ;;
        :) echo "pdf2hpgl: -$OPTARG requires an argument" >&2; exit 2 ;;
        \?) echo "pdf2hpgl: unknown option -$OPTARG" >&2; usage >&2; exit 2 ;;
    esac
done
shift $((OPTIND - 1))

if [ $# -lt 1 ]; then usage >&2; exit 2; fi

IN=$1
[ -r "$IN" ] || { echo "pdf2hpgl: cannot read '$IN'" >&2; exit 1; }
OUT=${2:-"${IN%.*}.hpgl"}

for tool in gs pstoedit python3; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "pdf2hpgl: '$tool' not found in PATH" >&2; exit 1; }
done

case $ROTATE in auto|0|90|180|270) ;; *)
    echo "pdf2hpgl: -r must be auto, 0, 90, 180 or 270" >&2; exit 2 ;;
esac

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pdf2hpgl.XXXXXX")
if [ "$KEEP" -eq 1 ]; then
    trap 'echo "pdf2hpgl: intermediates kept in $WORK" >&2' EXIT
else
    trap 'rm -rf "$WORK"' EXIT
fi

PS=$WORK/in.ps
RAW=$WORK/raw.hpgl

# 1. normalise input to PostScript
case ${IN##*.} in
    pdf|PDF)
        gs -q -dNOPAUSE -dBATCH -dSAFER -sDEVICE=ps2write \
           -dLanguageLevel=2 -o "$PS" "$IN"
        ;;
    *)  cp "$IN" "$PS" ;;
esac

# 2. vector -> HPGL. -penplotter drops width/fill commands a pen plotter
#    cannot honour. -pencolors only matters in multi-pen mode.
PSTOPTS="-penplotter"
[ "$MULTIPEN" -eq 1 ] && PSTOPTS="$PSTOPTS -pencolors 8"
pstoedit -q -f "hpgl:$PSTOPTS" "$PS" "$RAW" 2>&1 \
    | grep -v 'not very elaborated' >&2 || true

[ -s "$RAW" ] || { echo "pdf2hpgl: pstoedit produced no output" >&2; exit 1; }

# 3. fit to bed: measure, rotate, scale, centre, set pen
PEN=$PEN BED_X=$BED_X BED_Y=$BED_Y MARGIN=$MARGIN ROTATE=$ROTATE \
MULTIPEN=$MULTIPEN RAW=$RAW OUT=$OUT python3 <<'PYEOF'
import os, re, sys

pen      = int(os.environ['PEN'])
bed_x    = float(os.environ['BED_X'])
bed_y    = float(os.environ['BED_Y'])
margin   = float(os.environ['MARGIN'])
rotate   = os.environ['ROTATE']
multipen = os.environ['MULTIPEN'] == '1'
src      = open(os.environ['RAW']).read()

# Walk the command stream. Only PU/PD carry geometry; SP matters in multi-pen
# mode. Everything else (IN/SC/LT/EC/PG/OE) is reissued or dropped below --
# pstoedit's trailer in particular is HPGL/2/PCL, and its PG would trigger a
# page feed on a pen plotter.
ops = []
xs, ys = [], []
for cmd in re.findall(r'[A-Z]{2}[^;]*;', src):
    name, arg = cmd[:2], cmd[2:-1].strip()
    if name in ('PU', 'PD'):
        if not arg:
            ops.append((name, []))
            continue
        n = [int(v) for v in arg.replace(' ', '').split(',') if v]
        pts = list(zip(n[0::2], n[1::2]))
        xs += [p[0] for p in pts]
        ys += [p[1] for p in pts]
        ops.append((name, pts))
    elif name == 'SP' and multipen and arg:
        ops.append((name, int(arg)))

if not xs:
    sys.exit('pdf2hpgl: no geometry found in pstoedit output')

minx, maxx = min(xs), max(xs)
miny, maxy = min(ys), max(ys)
w, h = maxx - minx, maxy - miny

avail_x, avail_y = bed_x - 2 * margin, bed_y - 2 * margin
if avail_x <= 0 or avail_y <= 0:
    sys.exit('pdf2hpgl: margin leaves no usable bed area')

def extents(r):
    return (w, h) if r in (0, 180) else (h, w)

def fit(r):
    ew, eh = extents(r)
    return min(avail_x / ew, avail_y / eh) if ew and eh else 0.0

if rotate == 'auto':
    # prefer no rotation on a tie so output stays predictable
    rot = 90 if fit(90) > fit(0) + 1e-9 else 0
else:
    rot = int(rotate)

scale = fit(rot)
ew, eh = extents(rot)
off_x = margin + (avail_x - ew * scale) / 2.0
off_y = margin + (avail_y - eh * scale) / 2.0

def xf(x, y):
    nx, ny = x - minx, y - miny
    if   rot == 0:   rx, ry = nx,     ny
    elif rot == 90:  rx, ry = h - ny, nx
    elif rot == 180: rx, ry = w - nx, h - ny
    else:            rx, ry = ny,     w - nx
    # clamp guards against a rounding overshoot at the very edge of the bed
    return (min(int(bed_x), max(0, round(rx * scale + off_x))),
            min(int(bed_y), max(0, round(ry * scale + off_y))))

out = ['IN;', 'SC;']
out.append('PU;' if multipen else 'SP%d;PU;' % pen)

last = 'PU'          # header already lifted the pen
for name, val in ops:
    if name == 'SP':
        out.append('SP%d;' % val)
        continue
    if not val:
        if last != 'PU':                     # collapse redundant pen-ups
            out.append('PU;')
            last = 'PU'
        continue
    out.append(name + ','.join('%d,%d' % xf(x, y) for x, y in val) + ';')
    last = name
out += ['PU;', 'SP0;']

# wrap on command boundaries -- some controllers choke on very long lines
lines, cur = [], ''
for c in re.findall(r'[^;]*;', ''.join(out)):
    if len(cur) + len(c) > 250:
        lines.append(cur)
        cur = ''
    cur += c
if cur:
    lines.append(cur)

with open(os.environ['OUT'], 'w') as f:
    f.write('\n'.join(lines) + '\n')

pw, ph = ew * scale, eh * scale
sys.stderr.write(
    'pdf2hpgl: %d points, %d strokes\n'
    '          source bbox %d x %d units\n'
    '          rotation    %d deg%s\n'
    '          scale       %.4f\n'
    '          plotted     %d x %d  (bed %d x %d, margin %d)\n'
    '          pen         %s\n'
    % (len(xs), sum(1 for n, v in ops if n == 'PD' and v),
       w, h, rot, ' (auto)' if os.environ['ROTATE'] == 'auto' else '',
       scale, round(pw), round(ph), bed_x, bed_y, margin,
       'from source colours' if multipen else pen))
PYEOF

echo "pdf2hpgl: wrote $OUT" >&2
