"""Eagle Eye app icons.

An aperture iris around a survey crosshair, in the LUXE DARK language:
purple-biased near-black ground, a ghost-paint purple edge (the raised
surface), and the reticle in gold — the instrument you READ. Drawn at 4x
and downsampled, which is cheaper than antialiasing each primitive.
"""
import math
import os
from PIL import Image, ImageDraw

BG = (10, 9, 13)          # --lx-bg
SURFACE = (25, 21, 33)    # --lx-surface-2, the raised disc
PURPLE = (157, 140, 255)  # --lx-purple, the ghost edge
GOLD = (228, 181, 74)     # --lx-gold, the read accent
GOLD_D = (150, 118, 48)   # dimmed gold for the brackets
INK = (237, 234, 244)     # --lx-ink

SS = 4  # supersample


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make(size: int) -> Image.Image:
    n = size * SS
    im = Image.new("RGB", (n, n), BG)
    d = ImageDraw.Draw(im)
    c = n / 2

    # ghost glow: soft purple falloff outside the surface edge
    for i, t in ((3, 0.05), (2, 0.09), (1, 0.16)):
        r0 = n * 0.045 - i * n * 0.011
        d.ellipse([r0, r0, n - r0, n - r0], outline=mix(BG, PURPLE, t),
                  width=max(2, int(n * 0.012)))

    # raised surface, so the icon does not read as a black square on a dark home screen
    d.ellipse([n * 0.045, n * 0.045, n * 0.955, n * 0.955], fill=SURFACE)

    w = max(2, int(n * 0.017))

    # reticle brackets: four corners of a frame, the surveyor's read on a target
    br, gap = n * 0.30, n * 0.115
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = c + sx * br, c + sy * br
            d.line([x, y, x - sx * (br - gap), y], fill=GOLD_D, width=w)
            d.line([x, y, x, y - sy * (br - gap)], fill=GOLD_D, width=w)

    # crosshair, broken at the centre so the ring reads clearly
    arm_o, arm_i = n * 0.235, n * 0.085
    for s in (-1, 1):
        d.line([c + s * arm_i, c, c + s * arm_o, c], fill=INK, width=w)
        d.line([c, c + s * arm_i, c, c + s * arm_o], fill=INK, width=w)

    rr = n * 0.115
    d.ellipse([c - rr, c - rr, c + rr, c + rr], outline=GOLD, width=w)
    d.ellipse([c - w, c - w, c + w, c + w], fill=GOLD)

    # the ghost edge itself: a purple ring on the surface rim
    d.ellipse([n * 0.045, n * 0.045, n * 0.955, n * 0.955],
              outline=mix(BG, PURPLE, 0.55), width=max(2, int(n * 0.012)))

    return im.resize((size, size), Image.LANCZOS)


for s in (180, 192, 512):
    make(s).save(f"icons/icon-{s}.png", optimize=True)
    print(f"icons/icon-{s}.png")

# The native shell's marketing icon. App Store Connect rejects a build without a
# 1024 icon, and it must carry NO alpha channel — which is why every icon here is
# drawn on an opaque RGB canvas rather than composited.
native = "native/Assets.xcassets/AppIcon.appiconset"
if os.path.isdir(os.path.dirname(os.path.dirname(native))):
    os.makedirs(native, exist_ok=True)
    make(1024).save(f"{native}/icon-1024.png", optimize=True)
    print(f"{native}/icon-1024.png")
