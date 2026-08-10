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
    ├── test-geo.html     289 assertions over geo.js — open it in a browser
    ├── make-icons.py     regenerates the icons
    └── make-helioscope-test.py  regenerates the HelioScope import probes
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
| **KMZ** | true scale, correctly placed |
| **KML** | true scale, correctly placed, renders as **3D extruded volumes** at their real heights |
| bare **PNG** | *unscaled* — has to be placed by hand |

Two things follow, and they shape the export.

**Imported geometry is not editable.** It is a *reference to trace over* — you redraw
HelioScope's own obstructions on top of it and assign heights there. So the export is
optimised for tracing, not for looking finished: light fills you can see the roof through,
crisp outlines, and a scale bar to check against.

**The PNG result is not a defect.** A PNG contains no coordinates, so there is nothing for
HelioScope to scale it by. That is the entire reason the KMZ exists — the same image plus a
`LatLonBox` saying where its corners belong. **Use the KMZ.** A bare PNG is only worth having
as a movable fallback when the georeferencing itself is suspect.

**KMZ** *(Export tab, primary)* — one file, three layers:

1. **Deck raster** — the plan north-up as a transparent PNG: 5 m grid, 20.000 m scale bar,
   north arrow, object outlines with a barely-there fill. `drawOrder 0`, so it sits under
   everything.
2. **3D volumes** — extruded polygons at each object's real height.
3. **Floating labels** — each name hangs above its object on a tether, `relativeToGround`.

That third layer exists because names *painted on the deck* are underneath the first thing
placed over them. A `Point` at `h + lift` hangs the name in the air where it stays readable,
and `extrude` draws a line down so it still reads as attached when the view tilts. The pin
icon is suppressed; only the text and its leader are wanted. Lift is adjustable on the Export
tab (default 1.0 m) — raise it to clear racking.

Sampling is chosen to stay inside HelioScope's ~3600 × 2400 px guidance; a 40 × 30 m roof
comes out around 350 KB.

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

## Level the deck first

**Check → Set the flat plane.** Lay the phone on the roof, screen down, and Eagle Eye reads
where flat actually is from gravity. It counts down, so you never need to see the screen, and
it refuses the reading if the phone moved while it was taken.

This is what makes a *small* reference usable, and it is worth understanding why. A homography
has eight degrees of freedom and two of them **are** the vanishing line. A bank card spanning
a dozen pixels carries almost no perspective information, so those two terms end up decided by
a pixel of noise: the scale along the card comes out right and the horizon comes out wrong —
so anything away from the card is wrong with it.

Gravity has exactly the opposite problem. It fixes the plane perfectly and carries no length
at all. So the two are complementary: **plane from gravity, length from the card.**

Screen down is truer than screen up — the camera bump tilts a face-up phone about a degree.
Rest it on a wallet if the bump is the only thing touching.

A commercial roof drains at 1–2%, which is 0.6–1.1°. Small, but it is a *bias*, not noise, so
it does not average away across a survey. Re-read it if you move to a section that falls a
different way.

Every measurement path uses the reading once it exists — ray casting, the pose homography,
reprojection, and the height tool. With no reading, the deck is assumed level exactly as
before.

## Corner snapping

**On by default**, toggled in the trace toolbar. A finger is about 3 px honest even with the
loupe, and inside the trusted radius that is the dominant error. But a corner is exactly
locatable from the image itself — so your tap only has to say *which* corner, and the pixels
say where it is. It reports how far it moved, and buzzes when it catches.

Shi-Tomasi rather than Harris: the smaller eigenvalue of the structure tensor is the response
directly, with no empirical constant to tune, and it does not reward a strong edge the way
Harris can. A Gaussian prior about the tap stops it wandering to a better corner half a unit
away.

It refuses to snap when the patch is featureless, which matters as much as snapping when it is
not — blank membrane must not produce a confident answer out of sensor noise.

This is deliberately **not** shape detection. Proposing whole rectangles on a roof produces
confident nonsense: the best published attempt at that task gets 58% precision on easier
imagery, and a flat roof is wall-to-wall rectilinear clutter — membrane seams, board joints —
that swamps any line-based detector. Refining a corner you already chose adds accuracy with no
chance of inventing geometry.

## Calibrating from an aerial

The longest reference on any site is the roof itself, and somebody has already measured it.

**Trace → From the map.** Tap four points in the photo you can also identify on an aerial —
roof corners, a drain, a hatch — and paste each one's coordinates. That solves the same plane
homography a tape-measured rectangle would, over **tens of metres instead of a couple**. No
tape, no camera height, no tilt, no lens data.

And because the reference frame is east/north, the survey lands **georeferenced with bearing
0** — no separate locating step, no compass.

A **fifth point is optional and worth taking**: four correspondences always fit a homography
exactly, so four tell you nothing about their own quality. The fifth is the first thing that
can disagree, and its residual is reported.

Two caveats, both real:

- **Read error.** Google's aerial runs about 0.15 m/px in town, so a corner is good to roughly
  half a metre. Over 40 m that is ~1% — comparable to a well-tapped 2.4 m kerb. The long
  baseline is doing the work.
- **Building lean.** An orthophoto is rectified to the *ground*, so a roof `h` above it is
  thrown outward from the image nadir. Across a roof of extent `L` the differential is about
  `h·L/H` for flying height `H`: a 10 m building, 40 m across, shot from 600 m distorts about
  0.7 m end to end. Satellite imagery barely leans (`H` is hundreds of km) but is coarser per
  pixel.

All four points must be at **roof level**. Mixing a roof corner with a point on the ground
breaks the plane the whole method rests on.

The lean also shifts the whole roof sideways from its true ground position — which here is a
*feature*, since the layout tool draws on the same kind of imagery and inherits the same
shift.

The same idea works retroactively: **Check → Correct the scale → From the map** takes two
traced landmarks and their coordinates and rescales a finished survey to match.

## A reference is measured in pixels, not metres

The most consequential number in a calibration, and the least obvious. A reference does not
fix scale in metres — it fixes the **ratio** of real length to pixel length. So the error in
that ratio is your tap error divided by how many **pixels** the reference spans.

A finger lands within ~3 px with the loupe. Measured at 2.2 m range:

| reference | pixels spanned | scale error | over a 20 m roof |
|---|---|---|---|
| 2.4 m kerb | ~240 | ±1.3% | ±0.25 m |
| bank card | ~12 | ±25% | ±4.9 m |
| bank card, stepped 10× | — | ±7.8% | ±1.6 m |

Metres are a red herring: a small object held close to the lens can span more pixels than a
long one across the roof. **Fill the frame with the reference.** The calibration screen shows
the pixel span, the implied scale error, and what that costs over 20 m, live — so a bad
reference is visible while you can still retake the shot.

Presets cover a bank card (ISO/IEC 7810 ID-1 fixes it at 85.60 × 53.98 mm worldwide, tighter
than any spec sheet), A4, Letter, a 24″ paver, and your own phone measured once in Settings.
They are a rescue, not a plan.

Stepping a short reference end to end helps, but slowly: length grows as *n* while placement
error grows as √*n*, so relative error improves only as 1/√*n*.

**A golf ball works too**, through the tilt-and-height two-tap flow: the R&A/USGA rules fix
its diameter at 42.67 mm, so every ball is the same ball, and its silhouette reads identically
from every direction — no foreshortening, no which-side-is-which, no need to lie flat. Tap its
two side edges and pick the **Golf ball** preset. The one systematic is exactly correctable:
the visible rim sits one radius above the deck, and layover makes the solve return precisely
*h − r*, so the preset hands the 21.3 mm back. The limit is pixels — ~26 px across at 1.5 m,
so expect a few percent; the card's long side is twice the ball, and a paver beats both. White
balls also make excellent landmarks for tying shots together.

**With a small reference, the plane always comes from gravity** (when the tilt sensor is on) —
even before the lens has been measured. In that case the scale is marked **provisional**
(uniform, ~10% if the assumed lens is wrong), the Check tab says so, and one tape measurement
via **Correct the scale** trues every shot and clears the flag. A wrong plane is unfixable
after the fact; a wrong scale is one multiplication. A small reference with **no** tilt data is
marked *suspect*, banner and all — its vanishing line is noise and nothing measured through it
should be trusted.

## Locking things down

Redundancy beats precision, and the cheapest redundancy on a roof is an assumption you can
check. **Check → Align to the building** finds the axis your rectangles share and reports how
well they agree before snapping them to it.

When units really are parallel to the building — nearly always — their rotations are **one**
unknown rather than *N*, so this removes an error mode rather than tidying the drawing. The
mean is taken modulo 90°, because 1° and 89° describe the same alignment of a rectangle and
averaging them naively answers 45° and spins every unit on the roof. If the spread is wide,
it says so and does not pretend: either the units genuinely differ, or a shot is misplaced.

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

`tools/test-geo.html` runs 289 assertions against `geo.js` in a browser — homography against
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
