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

## Accuracy, honestly

- A measured-rectangle calibration is exact in the plane. Error comes from where your finger
  lands, which is what the loupe is for.
- Error grows with how obliquely you are looking. Keep the tilt between **25° and 65°** below
  horizontal — the capture screen colours the readout and says so — and stay within roughly
  10–15× your camera height of the target.
- Height measurement is geometrically exact but leans on tilt and lens. Trust it more after a
  rectangle calibration has solved the lens; for a rooftop unit a few metres away it is good.
- The registration residual and the scale check are real diagnostics. Look at them.

## Testing

`tools/test-geo.html` runs 90 assertions against `geo.js` in a browser — homography against
ray-cast cross-validation, pixel round trips at all four screen orientations, shape fitting,
station registration, geodesy round trips, and KML structure. Open it; the title reads
`PASS n` or `FAIL n`.

Two bugs it earned its keep on:

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

## What it does not do

- No LiDAR and no ARKit — a web app on iOS gets neither. That is a deliberate trade for
  something that works in full sun and installs from a URL.
- Shapes are rectangles and cylinders, because those are what HelioScope takes. An
  L-shaped unit is two boxes.
- Sloped roofs are not modelled; everything assumes one horizontal plane per shot.
