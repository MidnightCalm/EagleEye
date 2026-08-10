"""Generate a matched pair of HelioScope import probes.

Both files describe the SAME geometry at the SAME place, one as vector KML and one
as a georeferenced raster in a KMZ. That pairing is the whole point: whatever
HelioScope does with each, you can compare them directly, and if both import they
must land exactly on top of each other.

Everything in them is a diagnostic:

  SCALE BAR         exactly 20.000 m long. Measure it in HelioScope. If it does
                    not read 20 m, the import is not at true scale.
  L-MARKER          asymmetric in both axes, so a mirror or a 90 deg rotation is
                    obvious at a glance rather than plausible.
  NORTH ARROW       points to plan +Y, which is true north in these files.
  h= IN NAMES       tells you whether shape names survive the trip, which is the
                    only channel heights have.
  RTU-2 AT 20 DEG   a rotated rectangle, to check rotation is not dropped.
  STACK             a 24-gon standing in for a cylinder.

Usage:
    py tools/make-helioscope-test.py --lat 43.7985 --lon -79.5075

The default coordinates are an approximate point in Concord, Vaughan. Pass your
own so the probe lands on a roof you can recognise from the aerial.
"""
import argparse
import math
import os
import zipfile

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- geodesy
# Same WGS84 series as geo.js, so these files and the app agree.


def metres_per_deg(lat_deg):
    p = math.radians(lat_deg)
    return (
        111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p) - 0.0023 * math.cos(6 * p),
        111412.84 * math.cos(p) - 93.5 * math.cos(3 * p) + 0.118 * math.cos(5 * p),
    )


def to_lat_lon(x, y, lat0, lon0):
    """Local metres (+x east, +y north) -> lat/lon."""
    m_lat, m_lon = metres_per_deg(lat0)
    return lat0 + y / m_lat, lon0 + x / m_lon


# ---------------------------------------------------------------- geometry
def rect(cx, cy, w, l, rot_deg=0.0):
    c, s = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    out = []
    for dx, dy in ((-w / 2, -l / 2), (w / 2, -l / 2), (w / 2, l / 2), (-w / 2, l / 2)):
        out.append((cx + dx * c - dy * s, cy + dx * s + dy * c))
    return out


def circle(cx, cy, r, n=24):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n))
            for i in range(n)]


# The test card. Plan +Y is north; heights are metres.
ROOF = [(-20, -15), (20, -15), (20, 15), (-20, 15)]

SHAPES = [
    # name,                     height, polygon
    ("SCALE BAR 20.000 m",      0.00, rect(-10, -18, 20.0, 0.6)),
    ("RTU-1 h=1.22m",           1.22, rect(-8, 4, 2.0, 3.0)),
    ("RTU-2 h=1.50m @20deg",    1.50, rect(4, -2, 2.4, 3.6, 20.0)),
    ("Skylight h=0.35m",        0.35, rect(-2, -8, 1.2, 6.0)),
    ("Stack h=2.40m dia0.90",   2.40, circle(10, 6, 0.45, 24)),
    # An L, asymmetric in both axes: any mirroring or quarter-turn is unmistakable.
    ("L-MARKER orientation",    0.50, [(-18, 6), (-17, 6), (-17, 11), (-18, 11)]),
    ("L-MARKER foot",           0.50, [(-17, 6), (-14, 6), (-14, 7), (-17, 7)]),
    ("NORTH ARROW",             0.50, [(16, 8), (17.2, 8), (16.6, 11.5)]),
]


# ---------------------------------------------------------------- vector KML
def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def ring(poly, lat0, lon0, alt):
    pts = [to_lat_lon(x, y, lat0, lon0) for x, y in poly]
    pts.append(pts[0])
    return " ".join("%.8f,%.8f,%.2f" % (lon, lat, alt) for lat, lon in pts)


LABEL_LIFT = 1.0     # metres a floating name hangs above its object

STYLES = (
    '<Style id="ee-obst"><LineStyle><color>ff37afd4</color><width>2</width></LineStyle>'
    "<PolyStyle><color>5537afd4</color></PolyStyle></Style>"
    '<Style id="ee-outline"><LineStyle><color>ffe8f0f4</color><width>3</width></LineStyle>'
    "<PolyStyle><fill>0</fill></PolyStyle></Style>"
    # scale 0 hides the pin; the text and its tether are the whole point
    '<Style id="ee-label"><IconStyle><scale>0</scale><Icon></Icon></IconStyle>'
    "<LabelStyle><scale>0.95</scale><color>ffffffff</color></LabelStyle>"
    "<LineStyle><color>99ffffff</color><width>2</width></LineStyle></Style>"
)


def obstruction_placemarks(lat0, lon0):
    out = []
    for name, h, poly in SHAPES:
        out.append(
            "<Placemark><name>%s</name><styleUrl>#ee-obst</styleUrl>"
            "<ExtendedData>"
            '<Data name="height_m"><value>%.3f</value></Data>'
            '<Data name="vertices"><value>%d</value></Data>'
            "</ExtendedData>"
            "<Polygon><extrude>1</extrude><altitudeMode>relativeToGround</altitudeMode>"
            "<outerBoundaryIs><LinearRing><coordinates>%s</coordinates></LinearRing>"
            "</outerBoundaryIs></Polygon></Placemark>"
            % (esc(name), h, len(poly), ring(poly, lat0, lon0, h)))
    return "".join(out)


def label_placemarks(lat0, lon0):
    """Names hung in the air above each object, on a tether.

    A label drawn on the ground disappears under the first thing placed on top of
    it. relativeToGround altitude lifts it clear, and extrude keeps a line down to
    the object so it still reads as attached when the view tilts.
    """
    out = []
    for name, h, poly in SHAPES:
        cx = sum(q[0] for q in poly) / len(poly)
        cy = sum(q[1] for q in poly) / len(poly)
        lat, lon = to_lat_lon(cx, cy, lat0, lon0)
        out.append(
            "<Placemark><name>%s</name><styleUrl>#ee-label</styleUrl>"
            "<Point><extrude>1</extrude><altitudeMode>relativeToGround</altitudeMode>"
            "<coordinates>%.8f,%.8f,%.2f</coordinates></Point></Placemark>"
            % (esc(name), lon, lat, h + LABEL_LIFT))
    return "".join(out)


def outline_placemark(lat0, lon0):
    return ("<Placemark><name>Roof outline 40 x 30 m</name>"
            "<styleUrl>#ee-outline</styleUrl><Polygon><extrude>0</extrude>"
            "<altitudeMode>clampToGround</altitudeMode><outerBoundaryIs><LinearRing>"
            "<coordinates>%s</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"
            % ring(ROOF, lat0, lon0, 0))


def build_vector_kml(lat0, lon0):
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            "<name>Eagle Eye — HelioScope VECTOR probe</name>"
            "<description>%s</description>%s"
            "<Folder><name>Roof outline</name>%s</Folder>"
            "<Folder><name>Obstructions</name>%s</Folder>"
            "<Folder><name>Labels</name>%s</Folder>"
            "</Document></kml>"
            % (esc("Vector probe. SCALE BAR is exactly 20.000 m. Heights are in the "
                   "placemark names and in ExtendedData, and the Labels folder floats "
                   "each name %.2f m above its object so it is not buried by anything "
                   "placed on the deck. Anchor %.6f, %.6f. Plan +Y is true north."
                   % (LABEL_LIFT, lat0, lon0)),
               STYLES, outline_placemark(lat0, lon0),
               obstruction_placemarks(lat0, lon0), label_placemarks(lat0, lon0)))


def build_combined_kml(lat0, lon0):
    """Everything in one document: tracing base, 3D volumes, floating names.

    This is what the app itself now emits, so the probe tests the real product
    rather than a simplified stand-in.
    """
    m_lat, m_lon = metres_per_deg(lat0)
    north = lat0 + (CENTRE[1] + EXT_H / 2) / m_lat
    south = lat0 + (CENTRE[1] - EXT_H / 2) / m_lat
    east = lon0 + (CENTRE[0] + EXT_W / 2) / m_lon
    west = lon0 + (CENTRE[0] - EXT_W / 2) / m_lon
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            "<name>Eagle Eye — HelioScope COMBINED probe</name>"
            "<description>%s</description>%s"
            "<GroundOverlay><name>Deck</name><drawOrder>0</drawOrder>"
            "<Icon><href>files/overlay.png</href></Icon>"
            "<LatLonBox><north>%.9f</north><south>%.9f</south>"
            "<east>%.9f</east><west>%.9f</west><rotation>0</rotation>"
            "</LatLonBox></GroundOverlay>"
            "<Folder><name>Roof outline</name>%s</Folder>"
            "<Folder><name>Obstructions</name>%s</Folder>"
            "<Folder><name>Labels</name>%s</Folder>"
            "</Document></kml>"
            % (esc("Deck raster to trace on, 3D volumes standing on it, and names "
                   "floating %.2f m clear of both. Scale bar 20.000 m."
                   % LABEL_LIFT),
               STYLES, north, south, east, west,
               outline_placemark(lat0, lon0),
               obstruction_placemarks(lat0, lon0), label_placemarks(lat0, lon0)))


# ---------------------------------------------------------------- raster KMZ
EXT_W, EXT_H = 48.0, 44.0          # metres covered by the overlay
CENTRE = (0.0, -2.0)               # local centre of that box
GSD = 0.025                        # metres per pixel


def font(size, bold=False):
    for path in (r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf",
                 r"C:\Windows\Fonts\arial.ttf",
                 "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def build_overlay_png(path):
    """North-up, transparent-background PNG of the same card.

    Transparent so it can sit over an aerial. The pixel grid is sized from the
    METRE extents, so the ground stays square once the GroundOverlay stretches it
    across a lat/lon box that was derived from those same metres.
    """
    px_w = int(round(EXT_W / GSD))
    px_h = int(round(EXT_H / GSD))
    im = Image.new("RGBA", (px_w, px_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    x0 = CENTRE[0] - EXT_W / 2
    y1 = CENTRE[1] + EXT_H / 2

    def P(x, y):
        """Local metres -> image pixels (image y grows downward)."""
        return ((x - x0) / GSD, (y1 - y) / GSD)

    # Colours are chosen for a transparent overlay sitting on an AERIAL, which may
    # be pale concrete or dark membrane. White-on-transparent vanished against
    # light roofs entirely; magenta and cyan read against both, and every mark
    # carries a dark underlay so nothing depends on the base being dark.
    MAGENTA = (255, 61, 174, 255)
    CYAN = (0, 210, 255, 130)
    DARK = (0, 0, 0, 170)

    # 5 m grid
    gx = math.ceil(x0 / 5) * 5
    while gx <= x0 + EXT_W:
        d.line([P(gx, y1 - EXT_H), P(gx, y1)], fill=CYAN, width=3)
        gx += 5
    gy = math.ceil((y1 - EXT_H) / 5) * 5
    while gy <= y1:
        d.line([P(x0, gy), P(x0 + EXT_W, gy)], fill=CYAN, width=3)
        gy += 5

    # roof outline, dark underlay first so it survives a pale background
    ring_px = [P(*q) for q in ROOF] + [P(*ROOF[0])]
    d.line(ring_px, fill=DARK, width=12)
    d.line(ring_px, fill=MAGENTA, width=6)

    # Light fill only. This raster is something to TRACE ON, so the roof beneath
    # has to stay readable; and no per-object text, because a name painted on the
    # deck is buried the moment anything is placed over it. Names ride in the
    # vector layer instead, floating above each object.
    for name, h, poly in SHAPES:
        if name.startswith("SCALE BAR"):
            continue                              # drawn separately, below
        pts = [P(*q) for q in poly]
        d.polygon(pts, fill=(212, 175, 55, 40), outline=DARK)
        d.line(pts + [pts[0]], fill=(232, 201, 106, 255), width=4)

    # Scale bar as alternating 5 m blocks — the one mark that must be unambiguous
    # on any background, so it is drawn black-and-white with a hard border.
    for i in range(4):
        a, b = -20.0 + i * 5.0, -20.0 + (i + 1) * 5.0
        box = [P(a, -18.3), P(b, -18.3), P(b, -17.7), P(a, -17.7)]
        d.polygon(box, fill=(255, 255, 255, 255) if i % 2 == 0 else (0, 0, 0, 255),
                  outline=(0, 0, 0, 255))
    d.line([P(-20, -18.3), P(0, -18.3), P(0, -17.7), P(-20, -17.7), P(-20, -18.3)],
           fill=(0, 0, 0, 255), width=4)
    for ex in (-20.0, 0.0):
        d.line([P(ex, -19.2), P(ex, -16.8)], fill=(0, 0, 0, 255), width=8)
        d.line([P(ex, -19.2), P(ex, -16.8)], fill=(255, 255, 255, 255), width=4)
    bx, by = P(-20.0, -19.6)
    d.text((bx, by), "SCALE BAR  20.000 m  (4 x 5 m)  — MEASURE THIS AFTER IMPORT",
           font=font(32, True), fill=(255, 255, 255, 250),
           stroke_width=5, stroke_fill=(0, 0, 0, 230))

    # north arrow label, on top of the triangle shape
    d.text(P(16.2, 12.6), "N", font=font(48, True), fill=(255, 255, 255, 250),
           stroke_width=5, stroke_fill=(0, 0, 0, 220))

    d.text((16, 16), "EAGLE EYE OVERLAY PROBE  %.1f x %.1f m  @ %.3f m/px  —  north up"
           % (EXT_W, EXT_H, GSD), font=font(30, True),
           fill=(255, 255, 255, 250), stroke_width=5, stroke_fill=(0, 0, 0, 220))

    im.save(path, optimize=True)
    return px_w, px_h


def build_overlay_kml(lat0, lon0):
    """GroundOverlay + LatLonBox, rotation 0.

    LatLonBox is axis-aligned in lat/lon and its <rotation> is a separate rotation
    of the image about the box centre, in an unspecified frame. At this latitude a
    degree of longitude is ~1.38x shorter than a degree of latitude, so a non-zero
    rotation is not safely defined — the card is north-up instead.
    """
    m_lat, m_lon = metres_per_deg(lat0)
    north = lat0 + (CENTRE[1] + EXT_H / 2) / m_lat
    south = lat0 + (CENTRE[1] - EXT_H / 2) / m_lat
    east = lon0 + (CENTRE[0] + EXT_W / 2) / m_lon
    west = lon0 + (CENTRE[0] - EXT_W / 2) / m_lon
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        "<name>Eagle Eye — HelioScope RASTER probe</name>"
        "<description>%s</description>"
        "<GroundOverlay><name>Eagle Eye overlay probe</name><drawOrder>1</drawOrder>"
        "<Icon><href>files/overlay.png</href></Icon>"
        "<LatLonBox>"
        "<north>%.9f</north><south>%.9f</south><east>%.9f</east><west>%.9f</west>"
        "<rotation>0</rotation>"
        "</LatLonBox></GroundOverlay></Document></kml>"
        % (esc("Georeferenced raster probe, north-up. The white SCALE BAR is exactly "
               "20.000 m on the ground. Covers %.1f x %.1f m at %.3f m/px."
               % (EXT_W, EXT_H, GSD)),
           north, south, east, west))


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, default=43.7985,
                    help="anchor latitude (default: approximate Concord, Vaughan)")
    ap.add_argument("--lon", type=float, default=-79.5075, help="anchor longitude")
    ap.add_argument("--out", default="tools/helioscope-test")
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    vec = os.path.join(a.out, "helioscope-probe-vector.kml")
    png = os.path.join(a.out, "overlay.png")
    kmz = os.path.join(a.out, "helioscope-probe-combined.kmz")

    with open(vec, "w", encoding="utf-8") as fh:
        fh.write(build_vector_kml(a.lat, a.lon))

    w, h = build_overlay_png(png)

    # KMZ is a plain zip: exactly one .kml at the root, images by relative path.
    with zipfile.ZipFile(kmz, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", build_combined_kml(a.lat, a.lon))
        z.write(png, "files/overlay.png")

    print("anchor        %.6f, %.6f" % (a.lat, a.lon))
    print("vector KML    %s  (%.1f KB)" % (vec, os.path.getsize(vec) / 1024))
    print("overlay PNG   %s  (%d x %d px, %.1f KB)" % (png, w, h, os.path.getsize(png) / 1024))
    print("combined KMZ  %s  (%.1f KB)" % (kmz, os.path.getsize(kmz) / 1024))
    verify(a.lat, a.lon, vec, kmz, w, h)


def verify(lat0, lon0, vec_path, kmz_path, px_w, px_h):
    """Prove the two files describe the same ground before either is trusted.

    A probe that is itself wrong would send the whole HelioScope question down a
    blind alley, so the scale bar is measured back out of the emitted coordinates
    rather than assumed from the code that wrote them.
    """
    import re
    print()
    print("self-check")
    ok = True

    def geo_dist(a, b):
        m_lat, m_lon = metres_per_deg((a[0] + b[0]) / 2)
        return math.hypot((b[1] - a[1]) * m_lon, (b[0] - a[0]) * m_lat)

    # --- vector: measure the scale bar out of its own coordinates ---
    kml = open(vec_path, encoding="utf-8").read()
    block = re.search(r"<name>SCALE BAR[^<]*</name>.*?<coordinates>([^<]+)</coordinates>",
                      kml, re.S)
    pts = [tuple(map(float, t.split(",")))[:2] for t in block.group(1).split()]
    corners = [(p[1], p[0]) for p in pts]                     # -> (lat, lon)
    length = geo_dist(corners[0], corners[1])
    width = geo_dist(corners[1], corners[2])
    print("  vector scale bar   %.4f m x %.4f m  (want 20.0000 x 0.6000)" % (length, width))
    ok &= abs(length - 20.0) < 0.002 and abs(width - 0.6) < 0.002

    n_pm = len(re.findall(r"<Placemark>", kml))
    want = 1 + 2 * len(SHAPES)          # outline + obstruction + label per shape
    print("  vector placemarks  %d  (1 outline + %d obstructions + %d labels)"
          % (n_pm, len(SHAPES), len(SHAPES)))
    ok &= n_pm == want
    ok &= "RTU-1 h=1.22m" in kml
    print("  heights in names   %s" % ("yes" if "RTU-1 h=1.22m" in kml else "MISSING"))

    # labels must hang above their object, not on the deck
    alts = [float(c.rsplit(",", 1)[1]) for c in
            re.findall(r"<Point><extrude>1</extrude><altitudeMode>relativeToGround"
                       r"</altitudeMode><coordinates>([^<]+)</coordinates>", kml)]
    print("  floating labels    %d, altitudes %.2f-%.2f m (lift %.2f)"
          % (len(alts), min(alts), max(alts), LABEL_LIFT))
    ok &= len(alts) == len(SHAPES) and min(alts) >= LABEL_LIFT - 1e-9
    ok &= abs(max(alts) - (max(h for _, h, _ in SHAPES) + LABEL_LIFT)) < 1e-6

    # --- raster: does the LatLonBox imply the same metres per pixel? ---
    with zipfile.ZipFile(kmz_path) as z:
        names = z.namelist()
        doc = z.read("doc.kml").decode("utf-8")
    print("  kmz entries        %s" % ", ".join(names))
    ok &= names.count("doc.kml") == 1 and "files/overlay.png" in names

    def tag(t):
        return float(re.search(r"<%s>([^<]+)</%s>" % (t, t), doc).group(1))
    n, s, e, w_ = tag("north"), tag("south"), tag("east"), tag("west")
    m_lat, m_lon = metres_per_deg(lat0)
    box_h_m = (n - s) * m_lat
    box_w_m = (e - w_) * m_lon
    print("  overlay box        %.3f m x %.3f m  (want %.3f x %.3f)" % (box_w_m, box_h_m, EXT_W, EXT_H))
    ok &= abs(box_w_m - EXT_W) < 0.01 and abs(box_h_m - EXT_H) < 0.01

    gsd_x, gsd_y = box_w_m / px_w, box_h_m / px_h
    print("  implied gsd        %.5f x %.5f m/px  (square to %.4f%%)"
          % (gsd_x, gsd_y, abs(gsd_x - gsd_y) / gsd_x * 100))
    ok &= abs(gsd_x - gsd_y) / gsd_x < 0.002          # ground must not be stretched
    ok &= abs(float(re.search(r"<rotation>([^<]+)</rotation>", doc).group(1))) < 1e-9

    # --- the two must sit on top of each other ---
    roof_ll = [to_lat_lon(x, y, lat0, lon0) for x, y in ROOF]
    inside = all(s <= la <= n and w_ <= lo <= e for la, lo in roof_ll)
    print("  vector inside box  %s" % ("yes" if inside else "NO — they will not align"))
    ok &= inside

    print("  RESULT             %s" % ("all checks passed" if ok else "*** FAILED ***"))
    return ok


if __name__ == "__main__":
    main()
