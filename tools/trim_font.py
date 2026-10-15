#!/usr/bin/env python3
"""Trims Archivo's variable axes to the range the site uses, to keep pages
under the 150 KB budget (issue #12). Glyphs and their coverage are unchanged;
only the unused ends of the axes are cut: weight 400-700 (of 100-900) and
width 100-125% (of 62-125%). This took the file from 88 KB to 56 KB.

Archivo is under the SIL Open Font License 1.1 with no Reserved Font Name,
so the trimmed file may keep its name; public/assets/fonts/OFL-Archivo.txt
ships beside it.

The source is the untrimmed latin file from @fontsource-variable/archivo
5.2.8 (files/archivo-latin-wdth-normal.woff2). Needs fontTools and brotli
(pip install fonttools brotli). Run from the repo root:

  python3 tools/trim_font.py SOURCE.woff2 public/assets/fonts/archivo-latin-wdth-normal.woff2

If the CSS starts using a weight or width outside the range, widen the range
here and in the @font-face rule in public/assets/site.css together.
"""
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

AXES = {"wght": (400, 700), "wdth": (100, 125)}


def main(src, out):
    font = instantiateVariableFont(TTFont(src, lazy=False), AXES)
    font.flavor = "woff2"
    font.save(out)
    print("axes:", [(a.axisTag, a.minValue, a.maxValue) for a in TTFont(out)["fvar"].axes])


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
