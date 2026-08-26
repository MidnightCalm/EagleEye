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
    ├── test-geo.html     421 assertions over geo.js — open it in a browser
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

### The hexagonal panel

A regular hexagon of known side — a 15 cm acoustic panel does perfectly — is the best
portable reference the app knows: *Calibrate → Hex panel*, tap its six corners walking
around it, type one number. No tape measure, no long-and-short side to keep straight.

Six corners over-determine the homography, and that surplus is the point: four corners
always fit exactly, so they cannot criticise themselves, while six agree only as well as
the taps and the print are true — and the calibration **reports that residual** ("six
corners agree to ±4 mm"). Get close enough for the panel to span a decent part of the
frame and it also pins the vanishing line and **measures the lens**, after which the ball
and tilt modes inherit the true focal length instead of a guess. The panel's few
millimetres of thickness shift the measured plane parallel to the deck by the same amount
— beneath notice. High-contrast colour (orange on grey roof) makes the corners easy to
tap and easy to snap.

**How its plane is decided.** Field data taught a hard lesson: a hexagon spanning a few
hundred pixels fits a homography whose scale is excellent but whose perspective terms are
noise — its own two focal estimates disagreed by 26–40% and its vanishing line sat 18°
from gravity's, and the app believed it anyway. Now the panel's full homography is only
trusted with the plane when it demonstrably pinned perspective (large in frame, focal
estimates agreeing); otherwise the **plane comes from gravity** and the panel supplies
shape and scale — and, better, the app **searches for the focal length** that makes the
gravity-projected panel best match its true shape. A wrong lens shears the projection;
the true lens is where the residual bottoms out. So a modest panel plus a trusted
attitude measures the lens that the panel alone could not — the toast says "lens solved
against gravity" when the minimum was sharp enough to store, and every other mode
inherits it. Near nadir the lens degenerates into pure scale, and the app says so
instead of pretending.

**The lens is fused across shots, never trusted from one.** Debug photos from the field
settled it: a single panel shot at ordinary look-down angles has a residual valley
±20–40% wide in focal length — it will happily solve to a minimum, and the minimum is
not to be trusted (one such solve once wrote a 100° lens into settings and poisoned every
solve after it, including clamping the next search to its own neighbourhood). Every
panel shot now records its corners, and the app minimises ONE focal length over ALL of
them jointly — the same two field shots whose single valleys spanned ±25–40% put their
joint minimum within 5% of the camera's spec sheet. The lens is only adopted when the
joint valley is certifiably narrow, must land inside 40–100°, and a stored value outside
that band is dropped at startup. Until it certifies, the toast coaches: add a second
panel shot at a different tilt. When it lands, every hex shot is re-fitted at the fused
lens (its world rescaled with it), horizon locks are re-derived, and ties re-solved.

**Panel thickness is handled exactly** — tap the TOP corners, always (they are the
visible, consistent ones); the typed thickness (default 9 mm) is subtracted so camera
height is measured to the deck, and the tie corners are computed on the top plane. No
guessing where the corners “hit the ground”.

**The same panel must be entered the same everywhere** — it is one physical object, and
a shot calibrated with a different side length lives in a different-sized world. The app
warns when two shots' entered sides disagree.

**The panel also TIES shots.** Two shots calibrated on the same hexagon share six
corners; the app matches them automatically (the six-fold symmetry is resolved by each
shot's known orientation) and places the new shot with no landmarks named at all —
"placed from the panel, six corners to ±N cm". A tie whose implied scale is off says the
two shots disagree about the panel's size, and refuses rather than absorbing it.

### Lock to horizon (outdoors)

On a roof the far horizon is in half your shots, and it is a gravity reference better
than the tilt sensor: two taps on it (calibration screen → **⇱ Lock to horizon**) give two
rays that both lie level, so their cross product IS the down direction in the camera's
frame. The shot's pitch and roll are then taken from the photo — the sensor only keeps
the compass — and the per-device trims stop applying to that shot. Tap the *true* horizon
(open water, distant skyline), not a parapet or nearby ridge: anything close sits below
level and tilts the plane. The lock runs at the shot's own calibrated focal length and
remembers the tapped pixels, so when the fused lens later improves, the lock is
re-derived to match — the drawn horizon and the tapped points stay in agreement. (The
visible horizon dips ~0.03°·√height-in-metres below true
level — 0.2° from a 30 m roof — smaller than a tap.)

The capture screen also carries a fine **plumb readout** near dead vertical, iPhone-level
style: hold within half a degree and it locks green with a click, so shots can be taken
at a known, repeatable attitude — and a chip that reads plumb when the phone visibly is
not is the sensor bias advertising itself.

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

**With three or more tied shots the survey is adjusted globally** — every pose and every
landmark solved together, rather than each shot inheriting the errors of the one it tied
to. The idea is global bundle adjustment's, scaled to a pocket: in 2D the similarity
version of the problem is exactly linear (poses as complex numbers), so it solves in one
step with no initial guess and no local minima, then tightens to rigid. It runs by itself
as ties land, and from **Check → Adjust the survey** by hand; the toast reports landmark
agreement before → after, names the worst landmark (usually one tapped on different
features in different shots), and flags any shot whose scale wants to differ from the
rest. Manually-placed shots and the origin stay put.

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

**Different camera heights across shots are normal.** Crouch for one shot and stand for
the next and both are right — for any shot calibrated on a reference (hexagon, ball,
rectangle, map) the camera height is an *output* of the calibration, not a knob. The
scale tools honour that now: **Scale across shots** labels every shot as
*reference-pinned* or *assumed*, and only ever rescales the assumed ones; a pinned shot
can only change by being recalibrated. (The old behaviour forced one height onto every
shot, which once multiplied a correct hexagon calibration — taken crouching — by 1.81×
to match a standing one. Camera height is scale *within* a shot, never a law *across*
shots.) A real cross-shot size disagreement is detected where the evidence actually is
— the hexagon tie or the survey adjustment — and the checklist then names the shot to
recalibrate.

A **Debug bundle + photos**: the project, the device settings the
plain backup never carried (lens, trims, measured sensor bias), and per-shot derived
numbers — the homography actually in force, both horizons, the frame's focal length —
computed exactly as the app would use them — plus every shot's photo. When something
looks wrong in the field, that one file is the whole story.

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

## The sensor check — the Measure-style calibration

**Check → deck panel → Read + sensor check.** Lay the phone screen-down on the deck, let it
settle, then spin it half a turn flat when it buzzes. The true deck slope reverses in the
device frame under the spin; a sensor bias does not — so half the sum is your phone's bias
and half the difference is the real slope. It is the same trick Apple's Measure uses. The
trims are then **set from measurement, not eyeballed**, and the stored deck plane has the
bias removed. Verified: a sensor lying by +1.6°/−0.7° is measured to a tenth of a degree, and
a 0.5 m square then traces 0.5000 × 0.5000 through the corrected pipeline. A "bias" over 8°
is refused — that is not a sensor, that is a magnetic case or a moving surface.

**The shutter tap was the other horizon-killer.** Tapping the shutter rocks the phone about
your grip — the top tips back, the sensor reads more upright at exactly the instant the
attitude was sampled, and every horizon drawn from that shot sits too low: precisely the
symptom reported from the field. Shots now carry the median attitude from a window ending
120 ms *before* the tap, and warn when the phone was moving fast at the shutter.

An off-frame horizon now says so — "⇡ N px above the photo" — instead of pinning its label
to the top of the screen, which read as a wildly wrong calibration when it was actually a
steep close-up behaving correctly.

## The horizon trim

Phone pitch sensors genuinely carry a per-device bias — a degree or three from assembly
tolerance, more with a case; it is why Apple's own Measure app has a recalibration flow. At
this geometry one degree of pitch is ~30 cm of range error at 5 m, so it matters.

The **▲ / ▼ horizon** steppers (calibrate and trace screens, 0.2° per tap) nudge the drawn
horizon until it sits on the real one — and on a roof the real horizon is always visible,
which makes eyeballing it a genuinely good calibration. The trim is stored per device and
applied to **every** attitude the geometry consumes: shots, the live HUD, and the deck
levelling. Verified: a sensor lying by 1° distorts a true 0.5 m square to 0.516 × 0.529;
trim −1° restores 0.500 × 0.500 exactly. Roll trim lives in the tilt-mode diagnostics.

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

**A golf ball has its own calibration mode** — *Trace → Calibrate → Golf ball*, top level,
next to Rectangle. The R&A/USGA rules fix the diameter at 42.67 mm, so every ball is the same
ball, and a sphere's silhouette reads identically from every direction — no foreshortening,
no which-side-is-which, no need to lie flat.

The interface is a **circular selector**: press on the ball's centre, then drag out to its
edge — a circle follows your finger. On release the rim is locked automatically: 48 spokes
search for the strongest edge, a robust circle fit rejects the contact shadow, a second pass
re-probes from the refined centre, and the result draws in green with its pixel width. If the
lock fails (glare, low contrast) it says so and uses your circle as drawn.

The solve uses the **horizontal** rim extremes deliberately: a sphere's silhouette is radially
elongated off-axis and its bottom edge is where the contact shadow lives, so the left–right
chord is both the geometrically correct measure and the cleanest one. From those two tangent
rays the ball's centre is **ranged outright** — distance = radius / sin(half the angle between
them) — which is exact at any position in the frame. (The earlier route, treating the rim
extremes as two ground points a diameter apart, was exact dead ahead but drifted quadratically
off-axis: about −1% at 8° off the midline, −3.7% at 16°. Ranging replaced it everywhere.)

The honest limit is pixels — ~26 px across at 1.5 m — so get close; the readout shows the
implied scale error live. The card's long side is twice the ball, and a paver beats both.
White balls also make excellent landmarks for tying shots together.

### Two balls, three balls

Because the diameter is known, every ball's silhouette gives a direction AND a distance — a
full 3D point from the photo alone. That makes a bag of golf balls a surveying instrument:

- **One ball** prices the scale and camera height. The plane still comes from the sensor.
- **Two balls** also measure the deck's tilt **along the line between them**, independent of
  the sensor, and give two heights that must agree. Put them as far apart as the frame allows.
- **Three balls in a triangle** measure the **whole deck plane** from the photo, the sensor
  only saying which way is up. Three in a row read no more than two — the app refuses the
  degenerate triangle and says which way to move.

After circling the first ball, **+ Add ball B** banks it and clears the selector; the banked
balls wear their letters on the photo. With two or more in play a live **PHOTO vs SENSOR**
panel shows what the balls can already see: the tilt along the pair (with the resolution the
constellation actually supports), the per-ball heights, or the full plane-vs-sensor angle.

**Spacing is the instrument.** The tilt lever is the distance *between* balls against a
ranging error of a few centimetres — **a metre apart beats a hand-span**, and a cluster reads
heights but not tilt. The field taught this the hard way: a hand-span cluster once out-voted
the sensor with a 55° horizon, because with a bunched constellation the disagreement IS the
noise. Four safeguards now stand in the way:

1. **Capability ceiling** — the photo's plane is only ever adopted when the constellation can
   resolve tilt to ±4° or better; a bunched set calibrates heights, keeps the sensor's plane,
   and says how far to spread.
2. **Statistical gate** — adoption also requires the disagreement to exceed 1.6× the photo's
   own resolution, so the trade is favourable whenever it happens.
3. **Range consistency** — every ball prices the same camera height; a ball whose height
   stands apart has a corrupt rim lock and is named by letter, at any spread, before any
   plane mathematics. (The roster shows each ball's implied range for the same reason.)
4. **Systemic detection** — heights that are absurd and mutually inconsistent point at the
   attitude itself (the screen-rotation class of failure), and the app says so instead of
   framing a ball.

The arbitration is honest in both directions. The photo's plane replaces the sensor's only
when the disagreement exceeds what the ball geometry can resolve — correcting a good sensor by
ranging noise would be adding noise — and when it does win, the plane is stored **in the
device frame**, so the attitude error cancels exactly all the way through the homography.
Verified: a sensor lying by 6° of pitch and 2° of roll, three synthetic balls, and a true
0.5 m square traces **0.5000 × 0.5000** through the app's own measurement path; the same lie
with one ball is ~22 cm of height error, which is the whole argument for carrying three.

Different-coloured balls are a feature: each ball's detector projects the pixels onto the
colour axis from *its own* outside to *its own* inside, so a dark-yellow ball on grey membrane
— nearly invisible to plain brightness — locks as cleanly as a white one.

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

`tools/test-geo.html` runs 421 assertions against `geo.js` in a browser — homography against
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
