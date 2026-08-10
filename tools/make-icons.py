"""Eagle Eye app icons.

An aperture iris around a survey crosshair, in the Trove/Ledger palette. Drawn
at 4x and downsampled, which is cheaper than antialiasing each primitive.
"""
import math
from PIL import Image, ImageDraw

BG = (11, 9, 16)
PLUM = (36, 22, 53)
GOLD = (212, 175, 55)
GOLD_D = (138, 112, 33)
CREAM = (244, 240, 232)

SS = 4  # supersample


def make(size: int) -> Image.Image:
    n = size * SS
    im = Image.new("RGB", (n, n), BG)
    d = ImageDraw.Draw(im)
    c = n / 2

    # plum ground, so the icon does not read as a black square on a dark home screen
    d.ellipse([n * 0.045, n * 0.045, n * 0.955, n * 0.955], fill=PLUM)

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
        d.line([c + s * arm_i, c, c + s * arm_o, c], fill=CREAM, width=w)
        d.line([c, c + s * arm_i, c, c + s * arm_o], fill=CREAM, width=w)

    rr = n * 0.115
    d.ellipse([c - rr, c - rr, c + rr, c + rr], outline=GOLD, width=w)
    d.ellipse([c - w, c - w, c + w, c + w], fill=GOLD)

    # outer ring
    d.ellipse([n * 0.045, n * 0.045, n * 0.955, n * 0.955], outline=GOLD, width=max(2, int(n * 0.012)))

    return im.resize((size, size), Image.LANCZOS)


for s in (180, 192, 512):
    make(s).save(f"icons/icon-{s}.png", optimize=True)
    print(f"icons/icon-{s}.png")
