# Eagle Eye

A roof survey in your pocket. Photograph what is on a roof, trace it, and walk away with
metric dimensions, heights, and a KML that drops into HelioScope with the height carried in
each shape's name.

Same luxe-dark register as Trove and Ledger. Static PWA: no build step, no framework, no
server of its own. Runs on the phone in the field and on the desktop from the same URL.

```
eagle-eye/
├── index.html            app shell
├── geo.js                the geometry — homography, ray casting, fitting, geodesy, KML
├── app.js                state, screens, capture, tracing, export
├── style.css             palette + components (inherited from Trove via Ledger)
├── sw.js                 service worker — offline app shell
├── manifest.webmanifest  PWA metadata
├── icons/                180 / 192 / 512 px
└── tools/
    ├── test-geo.html     90 assertions over geo.js — open it in a browser
    └── make-icons.py     regenerates the icons
```

## Why not LiDAR

You were right to rule it out. The iPhone's depth sensor is a 940 nm emitter, and a sunlit
roof floods that band — the returns get noisy exactly when you need them. Its useful range
also stops well short of the far side of a warehouse.

Photographs do not care. Eagle Eye measures by putting a photograph onto the plane of the
roof, which needs nothing but the picture and one thing whose size you know.

## Getting it onto the phone

The camera only works over **https**, so the folder cannot just live on the desktop.
GitHub Pages is the path of least resistance, the same as Ledger:

1. Push this folder to a repository.
2. Settings → Pages → Source: `main` / `/ (root)`.
3. Open `https://<username>.github.io/<repo>/` in Safari.
4. Share → **Add to Home Screen**.

Netlify Drop or Cloudflare Pages work identically. Once installed it runs offline, which
matters on an industrial roof where the signal dies.

On first capture iOS will ask twice — once for the camera, once for **Motion & Orientation**.
Both are declinable; see below for what each one costs you.

## The field workflow

1. **New survey** — name and address.
2. **Capture** — point at a section of roof and shoot. Keep something you have tape-measured
   in the frame.
3. **Calibrate** the shot (below).
4. **Trace** — tap the base corners of each unit. Name it, give it a height.
5. Move, shoot again, and mark **two landmarks** you already traced so the shots tie together.
6. **Locate** the survey against two points read off an aerial.
7. **Export KML**.

## Calibrating a shot

Two routes. The first is the accurate one.

### Measured rectangle (preferred)

Tap the four corners of something rectangular you have measured, then type its two sides.
That solves a plane homography — a direct map from photo pixels to roof metres.

It needs **no lens data, no tilt reading and no guess at your eye height**, which is why it
survives conditions the other route does not. On a roof you are rarely short of a candidate:

- a rooftop unit's curb (two tape measurements)
- **standing-seam or rib spacing** — a known pitch gives you a long, accurate baseline
- ballast pavers, usually 24″ × 24″
- two tape measures laid out in an L

If the shot also recorded a tilt, Eagle Eye takes a free lens calibration from the same four
corners and stores it — which is what makes the second route trustworthy afterwards.

### Tilt + height

Uses the attitude recorded at the shutter, the lens field of view, and your camera height
above the roof. Faster, but every one of those three can be wrong.

You can skip the eye-height guess: tap two points a known distance apart and Eagle Eye
solves the camera height in closed form.

### Read the grid

After calibrating, a green metric grid is painted back onto the photo. **If those squares do
not sit flat and square on the roof, no number from that shot is worth having.** It is the
only honest check available on site, and it takes a second.

## Tracing

| Tool | Taps | Produces |
|---|---|---|
| **Box** | 3–4 base corners | Rectangle — minimum-area fit, so tap order does not matter |
| **Cylinder** | 3+ around the base | Circle — least-squares fit |
| **Outline** | walk the parapet | Roof polygon (area, and the KML boundary) |
| **Landmark** | 1 | A named point that ties shots together and georeferences the survey |
| **Height** | base, then top | Measures height optically instead of typing it |

Press and drag: a **loupe** follows your thumb so you can place a corner precisely instead of
somewhere near it. Two fingers pan and zoom.

Tap **where the object meets the roof**. A tap on the top edge of a unit is not on the roof
plane and will land metres away.

Every traced shape is drawn back onto the photo with its live dimensions, so a bad tap is
obvious before you commit it.

## Tying shots together

One photo will not cover a roof. Each shot is its own frame until it is placed.

Trace a **landmark** on something visible from both positions — a corner, a drain, a curb
end — and give it **the same name** in each shot. Two matching names place the second shot
exactly; three or more also give you a residual, reported in centimetres. That residual is
the most honest accuracy figure the app can produce.

It also reports a **scale check**. If two shots disagree about size by 8%, one of the
calibrations is wrong, and the number says so rather than quietly splitting the difference.

Failing landmarks, place a shot by hand from the plan (rotation and offset).

## Locating the survey

KML needs real coordinates.

- **Two landmarks** *(best)* — right-click each of two traced points in Google Maps, copy the
  coordinates, paste them in. Decimal degrees, degrees-minutes-seconds, and N/S/E/W suffixes
  are all accepted. The further apart the two points, the better: at ~1 cm of coordinate
  precision over a 41 m baseline the bearing is good to about 0.01°.
- **GPS** — one tap, but a phone fix lands within several metres and a compass sits badly on
  a steel roof. Fine for a first placement.
- **Manual** — type the anchor and the bearing of plan-up.

The two-landmark fit also reports a **scale check** comparing your surveyed distance against
the map distance. Under 2% is healthy; a larger number means the survey and the aerial
disagree, and it is worth knowing before the layout is drawn.

## Export

**Tested against HelioScope on 2026-08-10**, via Designer → Advanced → Overlays → Upload
Overlay:

| file | result |
|---|---|
| **KMZ** | lands at **true scale**, correctly placed |
| **KML** | lands at **true scale**, correctly placed |
| bare **PNG** | *unscaled* — has to be placed by hand |

The PNG result is not a defect: a PNG contains no coordinates, so there is nothing for
HelioScope to scale it by. That is the entire reason the KMZ exists — it is the same image
plus a `LatLonBox` saying where its corners belong. **Use the KMZ.** The bare PNG is only
worth having as a movable fallback when the georeferencing itself is suspect.

**KMZ overlay** *(Export tab, primary)* — the traced plan rendered north-up as a transparent
PNG with a 20.000 m scale bar, north arrow, 5 m grid and every object labelled with its
height, wrapped with a `GroundOverlay` at `rotation=0`. Sampling is chosen to stay inside
HelioScope's ~3600 × 2400 px guidance; a 40 × 30 m roof comes out around 370 KB.

Rendered in **east/north**, not plan coordinates, because a `LatLonBox` is axis-aligned in
lat/lon and its `<rotation>` is a separate spin about the box centre in an unspecified frame.
At 43° N a degree of longitude is ~1.38× shorter than a degree of latitude, so a non-zero
rotation is not safely defined — the survey's bearing is baked into the raster instead.

The KMZ is written without a zip library: a KMZ is a plain zip, and `STORE` is the right
method because the payload is a PNG that is already deflated.

**KML** — one folder for the roof outline, one for obstructions. Rectangles export as
polygons; cylinders as 24-sided polygons (adjustable). Each placemark is extruded to its real
height with `relativeToGround`, so **opening the KML in Google Earth first shows you solid
blocks at their true heights** — the fastest sanity check there is before anything reaches a
layout tool.

Height rides in the name, per the template on the Export tab:

```
{name} h={h}{u}      →   RTU-1 h=1.22m
```

`{name}`, `{h}`, `{u}` are all substitutable, and the height can be written in feet
regardless of the units you surveyed in. Dimensions, radius, rotation and notes are also
written to `ExtendedData`, so nothing is lost even though HelioScope only reads the name.

**Schedule CSV** — one row per object, for a report.
**Backup JSON** — the whole survey. Photos are not included; they live in IndexedDB.

## Units

Metres or feet, switched anywhere, applied everywhere. Everything is stored in metres, so
switching never rounds your data. The Export tab has its own unit for the height written into
names, so you can survey in metres and label in feet.

## Storage

Photos go to IndexedDB, the rest to localStorage. A 1440 px JPEG runs a few hundred KB, and
base64 in localStorage would inflate that by a third and hit the wall at about ten shots.

Settings shows the total and offers **Drop all photos** — this keeps every measurement and
frees the space, costing only the ability to go back and trace more from those shots.

## Coverage, the checklist, and the live view

Three things answer "what do I still need", and they answer different questions.

**Coverage** (Plan tab → Coverage) shades the roof by **position error**, not by
resolution. Green means a cell was seen at adequate *geometry* — it does **not** mean
anything in it was measured. An area can be fully green and contain nothing traced.

Position error is what matters and it behaves badly with distance. A ray leaving at
depression θ lands at `h/tan θ`, so an attitude error moves the point by `(h² + d²)/h` per
radian — growing with the **square** of range:

| range | 0.5° tilt error | 1.0° |
|---|---|---|
| 3 m | 0.06 m | 0.13 m |
| 10 m | 0.58 m | 1.15 m |
| 20 m | 2.27 m | 4.53 m |

Which gives the number that governs the whole survey:

> **Trusted radius: ~4.3 m** at 1.55 m camera height, ±0.25 m tolerance, 0.5° tilt error and
> a deck assumed flat to ±0.08 m. Attitude alone it would be 6.5 m; the deck assumption costs
> the rest.

Standing closer beats every other improvement. The Check tab shows this live and lets you
edit all three inputs under **Error model**.

**The checklist** (Check tab) is what answers "can I leave the roof": objects with no height,
shots not placed or not calibrated, objects traced beyond the trusted radius, missing
landmarks, no scale reference, and the percentage of the outline actually covered. Blockers
badge the tab. Every row is tappable and jumps straight to the thing that needs fixing.

**Live** (bottom bar) draws the survey back over the camera feed from a standpoint you have
already placed. It is a **drift monitor, not a positioning system** — nothing here can know
where you are standing, so it assumes you are at the chosen shot and shows what the survey
claims is in front of you. If the wireframe sits on the real units, the survey is consistent.
If it has slid, something is wrong. Objects with no height draw amber and dashed. Coverage
gaps are shaded on the deck where they actually are, so you can walk to them.

The yaw slider exists because iOS `alpha` drifts; nudge until the wireframe lines up.

## Scale is an input, not an output

Every length rides on one measured distance, and no amount of photography recovers it —
scale is a gauge freedom of the projection equations, so the information for it is
identically zero. Record it under Check → *No scale reference* :

| method | on a 24 m baseline |
|---|---|
| laser | ±0.006% |
| 30 m fibreglass tape | ±0.04% |
| paced | ±1% |

Shoot the laser at the **inside face of the far parapet** — a large matte near-vertical
target that returns in full sun. White membrane often will not return past 15–20 m.

A scale error is invisible in the plan and lands on every length and doubly on every area.

## What a deck mosaic could and could not be

Worth recording, since it was investigated and rejected for v1. Projecting frames onto the
roof plane gives a picture of the **deck** only. Anything above it is thrown outward by
`h/(h−z)`:

| object height | apparent range, from 1.55 m |
|---|---|
| 0.30 m | 1.24× |
| 0.90 m | 2.38× |
| 1.20 m | 4.43× |
| ≥ 1.55 m | never meets the deck |

So a mosaic is a tracing base, never a measurement surface — and continuous capture while
walking is self-defeating regardless: normal gait puts 20–60°/s on the phone, while
frame-to-attitude skew needs under ~15°/s to stay inside the error budget. If it is ever
built, it should be **step-and-stand bursts**, not video.

## Accuracy, honestly

- A measured-rectangle calibration is exact in the plane. Error comes from where your finger
  lands, which is what the loupe is for.
- Error grows with how obliquely you are looking. Keep the tilt between **25° and 65°** below
  horizontal — the capture screen colours the readout and says so — and stay inside the
  trusted radius shown on the Check tab.
- **Do not read accuracy off sharpness.** A pixel 20 m away can resolve to 2 cm and still sit
  2.3 m from where it is drawn. Ground sampling distance says how sharp something is; it says
  nothing about where it is. Nothing in the UI colours by resolution.
- **Do not treat a closed loop as validation.** A 10% scale error closes a 130 m perimeter to
  0.000 m while inflating the enclosed area by 21%. Closure is a heading check, never a scale
  check.
- Eagle Eye is a **field measurement aid**, not a survey. It does not replace a stamped
  survey, an EagleView report or a drone flight, and it does not replace the tape or laser —
  the measured baseline is an input to it.
- Height measurement is geometrically exact but leans on tilt and lens. Trust it more after a
  rectangle calibration has solved the lens; for a rooftop unit a few metres away it is good.
- The registration residual and the scale check are real diagnostics. Look at them.

## Testing

`tools/test-geo.html` runs 175 assertions against `geo.js` in a browser — homography against
ray-cast cross-validation, pixel round trips at all four screen orientations, shape fitting,
station registration, geodesy round trips, and KML structure. Open it; the title reads
`PASS n` or `FAIL n`.

Bugs it earned its keep on:

- `applyH` guarded `|w| < 1e-12` while its comment claimed it rejected points behind the
  horizon. A negative `w` passed straight through and returned a **mirrored point behind the
  camera** — so a tap on the sky became a measurement, and geometry off the back of a frame
  drew as a ghost.
- The confidence metric started as `sqrt(|det J|)`, the *geometric mean* of the two principal
  scales. At a grazing angle, fine cross-track resolution masks a terrible along-track smear:
  40 cm along × 2 cm across averages to a comfortable-looking 9 cm. Replaced first by the
  worst singular value, then abandoned entirely in favour of position error.
- The trusted-radius ring was computed from attitude alone while the coverage map was coloured
  by attitude *and* deck uncertainty, so cells inside the "trusted" ring painted amber. Both
  now invert one sigma.
- The service worker's network-first path called `fetch(e.request)`, which consults the
  browser's HTTP cache — so on a host sending `Last-Modified` without `Cache-Control` it
  served stale files while appearing to go to the network. **Ledger and Trove share this
  worker and have the same bug.**

- The minimum-area box is **degenerate for three points** — around a right triangle,
  aligning to the hypotenuse encloses exactly the same area as aligning to the legs, so a
  clean 2.0 × 3.5 unit came back as 1.74 × 4.03. Three taps now use the two tapped edges.
- Recovering the camera pose from a reference rectangle was using the **rigid** fit, which
  holds scale at 1 — but there the scale *is* the camera height. It was fitting a rotation
  and translation across a 1.6× gap, throwing the height tool out by 4% and sending the
  focal-length search 10° wide. `similarity2D` exists to keep the two apart.

To run it locally:

```bash
py -m http.server 8795 --directory eagle-eye
```

`tools/make-helioscope-test.py` regenerates the matched probe pair used to establish the
table above — the same geometry as vector KML and as raster KMZ, with a 20.000 m scale bar,
an L-marker asymmetric in both axes (so a mirror or a quarter-turn is obvious rather than
plausible), and heights in the placemark names. It self-checks before writing: the scale bar
is measured back out of its own emitted coordinates, and the KMZ's box is checked for square
ground. Point it at a real site with `--lat` / `--lon`.

## What it does not do

- No LiDAR and no ARKit — a web app on iOS gets neither. That is a deliberate trade for
  something that works in full sun and installs from a URL.
- Shapes are rectangles and cylinders, because those are what HelioScope takes. An
  L-shaped unit is two boxes.
- Sloped roofs are not modelled; everything assumes one horizontal plane per shot.
