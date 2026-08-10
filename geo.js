/* Eagle Eye — geometry core.

   Everything that turns pixels into metres lives here, isolated from the UI so it
   can be exercised directly by tools/test-geo.html.

   Two independent ways to map a photo onto the roof plane:

     1. HOMOGRAPHY (`homographyFromQuad`) — the user taps four points whose real
        ground coordinates are known (normally the corners of a rectangle they
        measured with a tape). This needs no lens data, no device attitude and no
        camera height: it is a pure 2D image-plane -> 2D ground-plane map. It is
        the accurate mode and the one to prefer on site.

     2. RAY CAST (`rayForPixel` + `groundPoint`) — build the camera ray for a
        pixel from the focal length, rotate it into the world with the device
        attitude captured at the shutter, and intersect it with the roof plane a
        known height below the camera. Needs a calibrated focal length and a
        trustworthy tilt, so it is the convenience mode. It is also the only mode
        that knows where the camera is in 3D, so object HEIGHT measurement and
        tracing on a raised plane are ray-cast only.

   Units are metres and radians throughout. Degrees only ever appear at the
   boundaries — device orientation events in, geodesy out. */
'use strict';

var EE = (function () {

  var M_PER_FT = 0.3048;
  var DEG = Math.PI / 180;

  /* ================= small linear algebra ================= */

  /* Gauss-Jordan with partial pivoting. A is n arrays of n, b is length n.
     Returns null on a singular system rather than handing back Infinities —
     a degenerate tap (three points in a line) has to fail loudly. */
  function solveLinear(A, b) {
    var n = b.length, i, j, k;
    var M = [];
    for (i = 0; i < n; i++) M.push(A[i].slice().concat([b[i]]));

    for (i = 0; i < n; i++) {
      var piv = i;
      for (k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      if (Math.abs(M[piv][i]) < 1e-12) return null;
      var tmp = M[i]; M[i] = M[piv]; M[piv] = tmp;

      var d = M[i][i];
      for (j = i; j <= n; j++) M[i][j] /= d;
      for (k = 0; k < n; k++) {
        if (k === i) continue;
        var f = M[k][i];
        if (f === 0) continue;
        for (j = i; j <= n; j++) M[k][j] -= f * M[i][j];
      }
    }
    var x = [];
    for (i = 0; i < n; i++) x.push(M[i][n]);
    return x;
  }

  /* 3x3 matrices are flat row-major 9-arrays throughout. */
  function mul3(a, b) {
    var o = new Array(9);
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
    return o;
  }
  function transpose3(m) {
    return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  }
  function applyM3(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
    ];
  }
  function invert3(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    var det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-14) return null;
    var id = 1 / det;
    return [
      A * id, (c * h - b * i) * id, (b * f - c * e) * id,
      B * id, (a * i - c * g) * id, (c * d - a * f) * id,
      C * id, (b * g - a * h) * id, (a * e - b * d) * id
    ];
  }

  /* ================= homography ================= */

  /* Hartley normalisation: shift to centroid, scale so mean radius is sqrt(2).
     Pixel coordinates run into the thousands while ground coordinates are single
     digit metres, and feeding that spread straight into the 8x8 solve loses most
     of the available precision. Returns the similarity transform used. */
  function normalise(pts) {
    var n = pts.length, i, cx = 0, cy = 0;
    for (i = 0; i < n; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= n; cy /= n;
    var d = 0;
    for (i = 0; i < n; i++) d += Math.hypot(pts[i].x - cx, pts[i].y - cy);
    d /= n;
    var s = d > 1e-9 ? Math.SQRT2 / d : 1;
    var out = [];
    for (i = 0; i < n; i++) out.push({ x: (pts[i].x - cx) * s, y: (pts[i].y - cy) * s });
    return { pts: out, T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1] };
  }

  /* Solves the 3x3 that maps src -> dst for four correspondences.
     h8 is fixed at 1, leaving the eight unknowns of a plane projectivity. */
  function homographyFromQuad(src, dst) {
    if (!src || !dst || src.length < 4 || dst.length < 4) return null;
    var ns = normalise(src.slice(0, 4)), nd = normalise(dst.slice(0, 4));
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = ns.pts[i].x, y = ns.pts[i].y, X = nd.pts[i].x, Y = nd.pts[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    var h = solveLinear(A, b);
    if (!h) return null;
    var Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];

    var Td = invert3(nd.T);
    if (!Td) return null;
    var H = mul3(Td, mul3(Hn, ns.T));
    /* Scale so h8 = 1 — keeps stored values readable and comparisons stable. */
    if (Math.abs(H[8]) > 1e-14) { for (var k = 0; k < 9; k++) H[k] /= H[8]; }
    for (k = 0; k < 9; k++) if (!isFinite(H[k])) return null;

    /* The four reference corners are by construction in front of the camera, so
       their centroid fixes which sign of w means "roof". */
    var cx = 0, cy = 0;
    for (var j = 0; j < 4; j++) { cx += src[j].x / 4; cy += src[j].y / 4; }
    return orientH(H, { x: cx, y: cy });
  }

  function det3(m) {
    return m[0] * (m[4] * m[8] - m[5] * m[7])
      - m[1] * (m[3] * m[8] - m[5] * m[6])
      + m[2] * (m[3] * m[7] - m[4] * m[6]);
  }

  /* H and -H are the same projective map, so the solver's choice of sign is
     arbitrary — but the sign of w is what separates roof from sky. Pinning it so
     that w > 0 in front of the camera makes `w > 0` a universally valid horizon
     test, whichever calibration produced the matrix. */
  function orientH(H, insidePt) {
    var w = H[6] * insidePt.x + H[7] * insidePt.y + H[8];
    if (w < 0) for (var i = 0; i < 9; i++) H[i] = -H[i];
    return H;
  }

  /* Applies a homography to a point. Returns null behind the horizon, where w
     flips sign — those pixels are sky, not roof, and must not silently produce
     a mirrored point somewhere behind the camera. */
  function applyH(H, p) {
    var w = H[6] * p.x + H[7] * p.y + H[8];
    /* w <= 0, not |w| < eps. The comment above promised this and the code did not
       deliver it: a negative w passed straight through and returned a mirrored
       point behind the camera. Now that orientH pins the sign, one test serves
       both directions — a sky pixel has no ground point, and a ground point
       behind the camera has no pixel, so shapes off the back of the frame stop
       being drawn as ghosts. */
    if (w <= 1e-12) return null;
    var out = { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
    if (!isFinite(out.x) || !isFinite(out.y)) return null;
    return out;
  }

  /* Corner list for a W (x) by L (y) rectangle, matching the tap order the
     capture screen asks for: near-left, near-right, far-right, far-left. */
  function rectRefCorners(w, l) {
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: l }, { x: 0, y: l }];
  }

  /* ================= how good is that reference? =================

     The single most consequential number in a calibration, and the one nobody
     thinks about: a reference does not fix scale in metres, it fixes scale as a
     RATIO of real length to pixel length. So the error in that ratio is the tap
     error divided by how many PIXELS the reference spans — not how many metres.

     A finger lands within about 3 px with the loupe. Across a kerb spanning
     800 px that is 0.4%. Across a phone spanning 120 px it is 2.5%, and that 2.5%
     multiplies every dimension in the survey and doubles on every area.

     Metres are a red herring: a short reference held close to the lens can span
     more pixels than a long one across the roof. Pixels are what count. */
  function referenceQuality(quadPix, tapErrPx) {
    if (!quadPix || quadPix.length < 4) return null;
    var tap = tapErrPx > 0 ? tapErrPx : 3;

    var spans = [];
    for (var i = 0; i < 4; i++) {
      var a = quadPix[i], b = quadPix[(i + 1) % 4];
      spans.push(Math.hypot(b.x - a.x, b.y - a.y));
    }
    var minSpan = Math.min.apply(null, spans);
    var maxSpan = Math.max.apply(null, spans);
    if (!(minSpan > 0)) return null;

    /* The shortest edge sets the worst-conditioned direction, so it governs. */
    var relScaleErr = tap / minSpan;

    /* Foreshortening: opposite edges of a rectangle project to equal lengths only
       when it is viewed square-on. A large disparity means the quad is being read
       at a grazing angle, where corner positions are least certain. */
    var squash = Math.min(spans[0], spans[2]) / Math.max(spans[0], spans[2]);
    var squash2 = Math.min(spans[1], spans[3]) / Math.max(spans[1], spans[3]);
    var foreshorten = Math.min(squash, squash2);

    return {
      minSpanPx: minSpan,
      maxSpanPx: maxSpan,
      relScaleErr: relScaleErr,
      foreshorten: foreshorten,
      verdict: relScaleErr <= 0.005 && foreshorten >= 0.45 ? 'good'
        : relScaleErr <= 0.02 && foreshorten >= 0.25 ? 'fair' : 'poor'
    };
  }

  /* Laying a short reference end to end n times: the length grows as n while the
     placement error grows only as sqrt(n), so the relative error improves as
     1/sqrt(n). Ten placements of a phone beat one by roughly three times. */
  function steppedReferenceError(singleRelErr, n) {
    if (!(n > 0)) return Infinity;
    return singleRelErr / Math.sqrt(n);
  }

  /* Circular mean of angles whose period is 90 degrees.

     Rooftop units are almost always parallel to the building, so their rotations
     are one shared unknown rather than N independent ones. Averaging them
     directly is wrong — 1 degree and 89 degrees describe the same alignment of a
     rectangle. Mapping through 4x makes the period come out right, and the
     resultant length doubles as a measure of how well they actually agree. */
  function meanAngleMod90(angles) {
    if (!angles || !angles.length) return null;
    var sx = 0, sy = 0;
    for (var i = 0; i < angles.length; i++) {
      sx += Math.cos(4 * angles[i]);
      sy += Math.sin(4 * angles[i]);
    }
    var r = Math.hypot(sx, sy) / angles.length;
    if (r < 1e-9) return null;
    var m = Math.atan2(sy, sx) / 4;
    while (m > Math.PI / 4) m -= Math.PI / 2;
    while (m < -Math.PI / 4) m += Math.PI / 2;
    /* Circular standard deviation, mapped back through the same 4x. */
    return { angle: m, agreement: r, spreadDeg: Math.sqrt(-2 * Math.log(Math.max(1e-12, r))) / 4 / DEG };
  }

  /* ================= device attitude ================= */

  /* W3C device orientation is an intrinsic Z-X'-Y'' Tait-Bryan triple. The
     product below is the standard composition and yields device -> world, with
     world X east, Y north, Z up (alpha is only true-north referenced if the
     caller has folded in a compass heading).

     Device frame is the screen frame: X right, Y toward the top of the screen,
     Z out of the glass toward the user. The rear camera therefore looks down
     device -Z. */
  function rotFromOrientation(alphaDeg, betaDeg, gammaDeg) {
    var a = (alphaDeg || 0) * DEG, b = (betaDeg || 0) * DEG, g = (gammaDeg || 0) * DEG;
    var cA = Math.cos(a), sA = Math.sin(a);
    var cB = Math.cos(b), sB = Math.sin(b);
    var cG = Math.cos(g), sG = Math.sin(g);

    return [
      cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
      sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
      -cB * sG, sB, cB * cG
    ];
  }

  /* ---- attitude as a quaternion ----

     A frame almost never coincides with an attitude sample: iOS polls CoreMotion
     at 60 Hz on the main thread, the camera delivers on its own schedule, and
     neither carries a sensor timestamp. The attitude belonging to a frame has to
     be interpolated between the samples either side of it.

     Interpolating alpha/beta/gamma directly is wrong — they are a rotation
     sequence, not a vector. Halfway between alpha 359 and alpha 1 is alpha 180,
     pointing the camera backwards, and near beta = +-90 the remaining two axes
     collapse into each other. Quaternions have neither problem, so samples are
     converted on arrival and interpolated as rotations. */
  function quatMul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
    ];
  }

  /* Same Z-X'-Y'' order as rotFromOrientation, so the two agree exactly. */
  function quatFromOrientation(alphaDeg, betaDeg, gammaDeg) {
    var a = (alphaDeg || 0) * DEG / 2, b = (betaDeg || 0) * DEG / 2, g = (gammaDeg || 0) * DEG / 2;
    var qz = [Math.cos(a), 0, 0, Math.sin(a)];
    var qx = [Math.cos(b), Math.sin(b), 0, 0];
    var qy = [Math.cos(g), 0, Math.sin(g), 0];
    return quatMul(qz, quatMul(qx, qy));
  }

  function quatToMatrix(q) {
    var w = q[0], x = q[1], y = q[2], z = q[3];
    var n = Math.hypot(w, x, y, z);
    if (n < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    w /= n; x /= n; y /= n; z /= n;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
    ];
  }

  /* Shortest-arc spherical interpolation. Antipodal representations describe the
     same rotation, so one is flipped when the dot product is negative — without
     that the phone appears to spin the long way round between two samples 3 ms
     apart. Falls back to a normalised lerp when the arc is too small to divide. */
  function quatSlerp(a, b, t) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    var bb = b;
    if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
    var k0, k1;
    if (d > 0.9995) { k0 = 1 - t; k1 = t; }
    else {
      var th = Math.acos(Math.min(1, Math.max(-1, d))), s = Math.sin(th);
      k0 = Math.sin((1 - t) * th) / s;
      k1 = Math.sin(t * th) / s;
    }
    var q = [k0 * a[0] + k1 * bb[0], k0 * a[1] + k1 * bb[1], k0 * a[2] + k1 * bb[2], k0 * a[3] + k1 * bb[3]];
    var n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }

  /* Angle between two attitudes, in degrees — the "how fast is it moving" and
     "has it turned enough to be worth a new keyframe" measure. */
  function quatAngleDeg(a, b) {
    var d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return 2 * Math.acos(Math.min(1, d)) / DEG;
  }

  /* Focal length in pixels from a horizontal field of view, for an image whose
     long edge is `longPx`. FOV is quoted across the long edge of the sensor. */
  function focalFromFov(fovDeg, longPx) {
    return (longPx / 2) / Math.tan((fovDeg * DEG) / 2);
  }

  /* Camera ray for an image pixel, in the DEVICE frame.

     `screenAngle` is screen.orientation.angle at the shutter. Safari hands back
     a frame oriented to the interface, so in landscape the image axes are turned
     relative to the device axes that alpha/beta/gamma are expressed in. Undoing
     that rotation here is what keeps a landscape capture from measuring sideways. */
  function rayForPixel(px, py, imgW, imgH, f, screenAngle) {
    var cx = imgW / 2, cy = imgH / 2;
    var x = px - cx, y = py - cy;

    var ang = ((screenAngle || 0) % 360 + 360) % 360;
    var rx = x, ry = y;
    if (ang === 90) { rx = -y; ry = x; }
    else if (ang === 180) { rx = -x; ry = -y; }
    else if (ang === 270) { rx = y; ry = -x; }

    /* Image y grows downward, device Y grows upward; the camera looks down -Z. */
    var v = [rx / f, -ry / f, -1];
    var n = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
  }

  /* Intersects a device-frame ray with a horizontal plane `planeZ` metres above
     the roof, given a camera `camHeight` above that same roof. Returns null when
     the ray is level or rising — i.e. above the horizon. */
  function groundPoint(rayDev, R, camHeight, planeZ, deckNormal) {
    var d = applyM3(R, rayDev);
    var n = deckNormal || [0, 0, 1];
    var z = planeZ || 0;
    if (camHeight - z <= 1e-6) return null;

    var nd = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (nd > -1e-6) return null;                 /* level with or above the deck */
    var t = (z - camHeight) / nd;

    var b = deckBasis(n);
    var X = [t * d[0], t * d[1], t * d[2]];
    return {
      x: X[0] * b.e1[0] + X[1] * b.e1[1] + X[2] * b.e1[2],
      y: X[0] * b.e2[0] + X[1] * b.e2[1] + X[2] * b.e2[2],
      range: t
    };
  }

  /* World point -> pixel. The exact inverse of rayForPixel + groundPoint, used to
     paint the metric grid and the traced shapes back onto the photo. That overlay
     is the only honest way for someone on a roof to see that a calibration is
     right before they trust a number from it. */
  function projectToPixel(pt, R, camHeight, imgW, imgH, f, screenAngle, planeZ, deckNormal) {
    var n = deckNormal || [0, 0, 1];
    var b = deckBasis(n);
    var k = (planeZ || 0) - camHeight;
    /* A deck point lifted along the deck normal, not along world up. */
    var v = [
      pt.x * b.e1[0] + pt.y * b.e2[0] + k * n[0],
      pt.x * b.e1[1] + pt.y * b.e2[1] + k * n[1],
      pt.x * b.e1[2] + pt.y * b.e2[2] + k * n[2]
    ];
    var d = applyM3(transpose3(R), v);
    if (d[2] > -1e-9) return null;           /* behind the camera */
    var xn = d[0] / -d[2], yn = -d[1] / -d[2];
    var rx = xn * f, ry = yn * f;

    var ang = ((screenAngle || 0) % 360 + 360) % 360;
    var x = rx, y = ry;
    if (ang === 90) { x = ry; y = -rx; }
    else if (ang === 180) { x = -rx; y = -ry; }
    else if (ang === 270) { x = -ry; y = rx; }

    return { x: x + imgW / 2, y: y + imgH / 2 };
  }

  /* ================= the deck plane =================

     Where "flat" actually is, taken from gravity rather than assumed.

     This is what rescues a small reference. A homography has 8 degrees of freedom
     and two of them ARE the vanishing line. A bank card spanning a dozen pixels
     carries almost no perspective information, so those two terms end up decided
     by a pixel of noise: the scale along the card comes out fine while the
     horizon is nonsense, and everything away from the card goes with it.

     Gravity has the opposite problem — it fixes the plane exactly and carries no
     length at all. Lay the phone on the deck and the two are complementary: the
     plane comes from gravity, the length from the card. */

  /* Deck normal, in the world frame, from the attitude of a phone lying on it.
     Face-up the device +Z points out of the screen along the normal; face-down it
     points into the deck, so the sign flips. */
  function normalFromAttitude(alphaDeg, betaDeg, gammaDeg, faceDown) {
    var R = rotFromOrientation(alphaDeg, betaDeg, gammaDeg);
    var n = applyM3(R, [0, 0, faceDown ? -1 : 1]);
    var m = Math.hypot(n[0], n[1], n[2]);
    if (m < 1e-9) return [0, 0, 1];
    return [n[0] / m, n[1] / m, n[2] / m];
  }

  /* How far off level the deck is, in degrees. A commercial roof drains at 1-2%,
     which is 0.6-1.1 deg — small, but it is a bias rather than noise, so it does
     not average away over a survey. */
  function deckTiltDeg(n) {
    if (!n) return 0;
    return Math.acos(Math.min(1, Math.abs(n[2]))) / DEG;
  }

  /* An orthonormal pair spanning the deck, for expressing points on it in 2D.
     e1 is world east projected onto the deck, so a level deck reduces to plain
     x/y and every existing measurement is unchanged. */
  function deckBasis(n) {
    if (!n || Math.abs(n[2] - 1) < 1e-12) return { e1: [1, 0, 0], e2: [0, 1, 0] };
    var ref = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    var d = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
    var e1 = [ref[0] - d * n[0], ref[1] - d * n[1], ref[2] - d * n[2]];
    var m = Math.hypot(e1[0], e1[1], e1[2]);
    if (m < 1e-9) return { e1: [1, 0, 0], e2: [0, 1, 0] };
    e1 = [e1[0] / m, e1[1] / m, e1[2] / m];
    var e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    return { e1: e1, e2: e2 };
  }

  /* The ray cast expressed as a single 3x3 image -> ground homography.

     The two calibration modes look unrelated in code but describe the same kind
     of object: a plane projectivity. Writing the pose-based one out as a matrix
     collapses that difference, so a mosaic renderer, a footprint test and a
     ground-sampling calculation can each be written once and fed by either mode.

     Derivation: the device ray is linear in the pixel, d = R.M.S.(u,v,1), where S
     recentres and undoes the screen rotation and M turns that into camera-frame
     directions. Intersecting z = 0 from height h gives x = h.d0/(-d2) and
     y = h.d1/(-d2), which is exactly the matrix below. Because the third row is
     -d2, w > 0 lands in front of the camera for free. */
  function homographyFromPose(R, camHeight, f, imgW, imgH, screenAngle, deckNormal) {
    if (!R || !(camHeight > 0) || !(f > 0)) return null;
    var cx = imgW / 2, cy = imgH / 2;
    var ang = ((screenAngle || 0) % 360 + 360) % 360;

    var S;
    if (ang === 90) S = [0, -1, cy, 1, 0, -cx, 0, 0, 1];
    else if (ang === 180) S = [-1, 0, cx, 0, -1, cy, 0, 0, 1];
    else if (ang === 270) S = [0, 1, -cy, -1, 0, cx, 0, 0, 1];
    else S = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];

    var M = [1 / f, 0, 0, 0, -1 / f, 0, 0, 0, -1];
    var A = mul3(R, mul3(M, S));

    var n = deckNormal || [0, 0, 1];
    var b = deckBasis(n);
    /* (v^T A)[j] — the row of A seen along direction v. */
    var row = function (v) {
      return [v[0] * A[0] + v[1] * A[3] + v[2] * A[6],
      v[0] * A[1] + v[1] * A[4] + v[2] * A[7],
      v[0] * A[2] + v[1] * A[5] + v[2] * A[8]];
    };
    var r1 = row(b.e1), r2 = row(b.e2), r3 = row(n);

    /* Negating the third row keeps w > 0 in front of the camera, which is what
       every horizon test in the codebase relies on. A level deck reduces this to
       [h.A0 ; h.A1 ; -A2], exactly as before. */
    return [
      camHeight * r1[0], camHeight * r1[1], camHeight * r1[2],
      camHeight * r2[0], camHeight * r2[1], camHeight * r2[2],
      -r3[0], -r3[1], -r3[2]
    ];
  }

  /* Jacobian of the plane projectivity at an image pixel — how a pixel-sized
     square lands on the roof. Returned row-major as [dx/du, dx/dv, dy/du, dy/dv]. */
  function jacobianAtPixel(H, p) {
    var w = H[6] * p.x + H[7] * p.y + H[8];
    if (w <= 1e-9) return null;
    var X = H[0] * p.x + H[1] * p.y + H[2];
    var Y = H[3] * p.x + H[4] * p.y + H[5];
    var iw2 = 1 / (w * w);
    return [
      (H[0] * w - X * H[6]) * iw2, (H[1] * w - X * H[7]) * iw2,
      (H[3] * w - Y * H[6]) * iw2, (H[4] * w - Y * H[7]) * iw2
    ];
  }

  /* Ground sampling distance: how much roof one image pixel covers, reported as
     the WORST direction — the larger singular value of the Jacobian.

     sqrt(|det J|) was the obvious choice and it flatters a grazing view badly.
     Looking along a roof from eye height, a pixel lands on a long thin slice:
     fine across the view, dreadful along it. The geometric mean of those two
     averages a 40 cm smear and a 2 cm width into a comfortable-looking 9 cm,
     which is exactly the corner a survey must not trust. The larger singular
     value reports the 40 cm.

     For a 2x2 J the singular values follow from the Frobenius norm and the
     determinant without forming J'J explicitly. */
  function gsdAtPixel(H, p) {
    var J = jacobianAtPixel(H, p);
    if (!J) return Infinity;
    var F = J[0] * J[0] + J[1] * J[1] + J[2] * J[2] + J[3] * J[3];
    var D = J[0] * J[3] - J[1] * J[2];
    var disc = Math.max(0, F * F - 4 * D * D);
    var s1 = Math.sqrt(Math.max(0, (F + Math.sqrt(disc)) / 2));
    return isFinite(s1) ? s1 : Infinity;
  }

  /* The w at which the frame stops meeting `maxGsd`.

     With the determinant form this was closed-form: a constant w, and therefore a
     straight line in the image parallel to the horizon. The worst-direction
     figure has no such luck — range grows towards the frame corners, so quality
     varies along a line of constant w and the true contour is curved. Rather than
     pretend otherwise, bisect on w and test the clipped polygon's own vertices,
     where the worst case always sits. Twenty iterations settle it. */
  function wForGsd(H, imgW, imgH, maxGsd) {
    if (!(maxGsd > 0)) return 1e-9;
    var rect = [{ x: 0, y: 0 }, { x: imgW, y: 0 }, { x: imgW, y: imgH }, { x: 0, y: imgH }];

    var worstAt = function (w) {
      var poly = clipHalfPlane(rect, H[6], H[7], H[8] - w);
      if (poly.length < 3) return -1;                 /* nothing left: trivially fine */
      var m = 0;
      for (var i = 0; i < poly.length; i++) m = Math.max(m, gsdAtPixel(H, poly[i]));
      return m;
    };

    /* An upper bound on w: the largest the frame can produce anywhere. */
    var hi = 1e-9;
    for (var i = 0; i < 4; i++) {
      var w = H[6] * rect[i].x + H[7] * rect[i].y + H[8];
      if (w > hi) hi = w;
    }
    if (worstAt(1e-9) <= maxGsd) return 1e-9;         /* whole frame already passes */

    var lo = 1e-9;
    for (var k = 0; k < 24; k++) {
      var mid = (lo + hi) / 2;
      if (worstAt(mid) > maxGsd) lo = mid; else hi = mid;
    }
    return hi;
  }

  /* Sutherland-Hodgman against the half-plane a.x + b.y + c >= 0. */
  function clipHalfPlane(poly, a, b, c) {
    var out = [], n = poly.length;
    if (!n) return out;
    for (var i = 0; i < n; i++) {
      var cur = poly[i], nxt = poly[(i + 1) % n];
      var dc = a * cur.x + b * cur.y + c;
      var dn = a * nxt.x + b * nxt.y + c;
      if (dc >= 0) out.push(cur);
      if ((dc >= 0) !== (dn >= 0)) {
        var t = dc / (dc - dn);
        out.push({ x: cur.x + t * (nxt.x - cur.x), y: cur.y + t * (nxt.y - cur.y) });
      }
    }
    return out;
  }

  /* The patch of roof a frame actually contributes, as a ground polygon.

     The image rectangle is clipped in IMAGE space first — against the horizon,
     and against the quality limit — because both are straight lines there. Only
     then is it mapped to the ground. Mapping first and clipping after would send
     near-horizon corners to infinity and take the polygon with them. */
  function frameFootprint(H, imgW, imgH, maxGsd) {
    if (!H) return null;
    var rect = [{ x: 0, y: 0 }, { x: imgW, y: 0 }, { x: imgW, y: imgH }, { x: 0, y: imgH }];
    var wMin = wForGsd(H, imgW, imgH, maxGsd);
    var img = clipHalfPlane(rect, H[6], H[7], H[8] - wMin);
    if (img.length < 3) return null;

    var ground = [], lo = Infinity, hi = 0;
    for (var i = 0; i < img.length; i++) {
      var g = applyH(H, img[i]);
      if (!g) return null;
      ground.push(g);
      var s = gsdAtPixel(H, img[i]);
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    return { image: img, ground: ground, minGsd: lo, maxGsd: hi, area: polygonArea(ground) };
  }

  /* ================= where a point IS =================

     Ground sampling distance answers "how sharp is this pixel". It does not
     answer "where is this thing", and the two diverge quadratically with range —
     a cell 20 m out can be crisp and still be metres from where it is drawn.
     Confidence anywhere in the UI must come from position error, never from GSD.

     Two independent sources dominate, and both scale badly with range:

     - Attitude. A ray leaving at depression theta lands at d = h/tan(theta), so
       d(d)/d(theta) = -(h^2 + d^2)/h. At 1.55 m and 10 m out, half a degree of
       tilt error moves the point 58 cm. It grows as the SQUARE of range while the
       camera height divides it, which is the whole argument for standing closer
       rather than looking further.

     - The deck itself. If the roof is not the plane it is assumed to be, an error
       of delta in deck height drags the intersection out by delta.d/h. This one
       is declared by the operator, never measured, so it must be stated. */

  /* Metres of ground movement per radian of attitude error, at range d. */
  function bearingSensitivity(camHeight, d) {
    if (!(camHeight > 0)) return Infinity;
    return (camHeight * camHeight + d * d) / camHeight;
  }

  /* Combined 1-sigma position error at range d, in metres. */
  function positionSigma(camHeight, d, attSigmaRad, deckUncertainty) {
    if (!(camHeight > 0)) return Infinity;
    var att = bearingSensitivity(camHeight, d) * (attSigmaRad || 0);
    var deck = (deckUncertainty || 0) * d / camHeight;
    return Math.hypot(att, deck);
  }

  /* How far out the survey still meets a stated tolerance — the honest radius of
     a standpoint, and the reason a roof is walked rather than scanned from one
     corner.

     This MUST invert the same sigma the coverage map is coloured by, deck term
     included. Solving it for attitude alone drew a ring labelled "trusted" with
     amber cells inside it, which is worse than either answer on its own.

     It looks quartic in d and is not: substituting u = d^2 into
     tol^2 = (A(h^2+u))^2 + (Bu... ) leaves a plain quadratic in u, so it stays
     closed-form. With deck = 0 it reduces to tol.h/sigma - h^2 as before. */
  function maxTrustedRange(camHeight, attSigmaRad, tolerance, deckUncertainty) {
    if (!(camHeight > 0) || !(attSigmaRad > 0)) return 0;
    var A = attSigmaRad / camHeight;
    var B = (deckUncertainty || 0) / camHeight;
    var h2 = camHeight * camHeight;

    var a = A * A;
    var b = 2 * a * h2 + B * B;
    var c = a * h2 * h2 - tolerance * tolerance;
    if (a < 1e-30) return 0;

    var disc = b * b - 4 * a * c;
    if (disc <= 0) return 0;
    var u = (-b + Math.sqrt(disc)) / (2 * a);
    return u > 0 ? Math.sqrt(u) : 0;
  }

  /* ================= relief displacement =================

     The hard limit on any ground-plane mosaic, and the reason one is a picture of
     the roof DECK rather than of the roof.

     Everything projected onto the plane is assumed to lie on it. Anything that
     does not — the top of a unit, a parapet, a stack — is thrown outward from the
     camera. A point z above the deck at ground range r lands at r.h/(h-z): the
     ray from the camera through it only meets the deck further out.

     Handheld, that factor is brutal. At h = 1.6 m a z = 1.0 m unit top lands 2.7x
     its true range — 8 m becomes 21 m — and at z = h it never meets the deck at
     all. Aerial photogrammetry gets away with ignoring this because h is hundreds
     of metres and z/h vanishes; at chest height z/h is the whole story.

     So: trace bases, never tops, and warn when an object is tall relative to the
     camera. */

  /* Multiplier on ground range suffered by a point `objectHeight` above the deck. */
  function layoverFactor(camHeight, objectHeight) {
    var d = camHeight - (objectHeight || 0);
    if (!(camHeight > 0) || d <= 1e-9) return Infinity;
    return camHeight / d;
  }

  /* How far outward that point is smeared, in metres. */
  function reliefDisplacement(range, objectHeight, camHeight) {
    var k = layoverFactor(camHeight, objectHeight);
    return isFinite(k) ? range * (k - 1) : Infinity;
  }

  /* The tallest thing whose top still lands within `maxFactor` of its true range —
     the honest ceiling on what a deck mosaic can depict rather than smear. */
  function maxSafeObjectHeight(camHeight, maxFactor) {
    if (!(camHeight > 0) || !(maxFactor > 1)) return 0;
    return camHeight * (1 - 1 / maxFactor);
  }

  /* Height of something standing on the roof, from its base and top pixels.

     The base fixes where the object is on the plane. The top must lie on the
     vertical through that base, so walking out along the top ray until its
     horizontal travel matches the base's gives the altitude directly. */
  function heightFromBaseTop(basePt, topRayDev, R, camHeight, deckNormal) {
    var d = applyM3(R, topRayDev);
    var n = deckNormal || [0, 0, 1];
    var b = deckBasis(n);
    /* Components of the top ray within the deck, and along its normal. */
    var hx = d[0] * b.e1[0] + d[1] * b.e1[1] + d[2] * b.e1[2];
    var hy = d[0] * b.e2[0] + d[1] * b.e2[1] + d[2] * b.e2[2];
    var hn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    var den = hx * hx + hy * hy;
    if (den < 1e-12) return null;             /* looking straight down */
    var t = (basePt.x * hx + basePt.y * hy) / den;
    if (t <= 0) return null;                  /* top ray points the other way */
    var h = camHeight + t * hn;
    if (!isFinite(h)) return null;
    return h;
  }

  /* Solves camera height from one known distance on the roof plane. Ground
     coordinates scale linearly with camera height, so measuring the pair at a
     nominal 1 m and dividing gives the true height in closed form. This is what
     lets someone skip guessing their eye height. */
  function camHeightFromKnown(rayA, rayB, R, knownDist, deckNormal) {
    var a = groundPoint(rayA, R, 1, 0, deckNormal), b = groundPoint(rayB, R, 1, 0, deckNormal);
    if (!a || !b) return null;
    var d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < 1e-9) return null;
    return knownDist / d;
  }

  /* ================= corner snapping =================

     Tap error is the dominant error inside the trusted radius, and a finger is
     about 3 px honest even with the loupe. A corner, though, is exactly locatable
     from the image itself — so the tap only has to say WHICH corner, and the
     pixels say where it is.

     Shi-Tomasi rather than Harris: the smaller eigenvalue of the structure tensor
     is the response directly, with no empirical k to tune, and it does not reward
     a strong edge the way Harris can. A Gaussian prior about the tap keeps it
     honest — without one it happily snaps to a better corner half a unit away.

     Deliberately NOT a shape detector. Rooftops are wall-to-wall rectilinear
     clutter — membrane seams, board joints — so proposing whole rectangles
     produces confident nonsense. Refining a corner the user already chose adds
     accuracy with no chance of inventing geometry. */
  function bestCorner(gray, w, h, sigma) {
    if (!gray || w < 9 || h < 9) return null;
    var cx = (w - 1) / 2, cy = (h - 1) / 2;
    var sg = sigma > 0 ? sigma : Math.max(3, w / 6);
    var twoSig2 = 2 * sg * sg;

    /* Sobel, then a 3x3 box sum of the structure tensor. Both margins are dropped
       so no neighbourhood ever reads outside the patch. */
    var n = w * h;
    var gx = new Float32Array(n), gy = new Float32Array(n);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        var tl = gray[i - w - 1], tc = gray[i - w], tr = gray[i - w + 1];
        var ml = gray[i - 1], mr = gray[i + 1];
        var bl = gray[i + w - 1], bc = gray[i + w], br = gray[i + w + 1];
        gx[i] = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        gy[i] = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      }
    }

    var best = null, scores = [];
    for (y = 2; y < h - 2; y++) {
      for (x = 2; x < w - 2; x++) {
        var a = 0, b = 0, c = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var j = (y + dy) * w + (x + dx);
            a += gx[j] * gx[j]; b += gx[j] * gy[j]; c += gy[j] * gy[j];
          }
        }
        /* Smaller eigenvalue of [[a,b],[b,c]] — large only when BOTH gradient
           directions are strong, which is what distinguishes a corner from an edge. */
        var half = (a + c) / 2;
        var disc = Math.sqrt(Math.max(0, ((a - c) / 2) * ((a - c) / 2) + b * b));
        var lambda = half - disc;
        scores.push(lambda);

        var r2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        var s = lambda * Math.exp(-r2 / twoSig2);
        if (!best || s > best.s) best = { x: x, y: y, s: s, lambda: lambda };
      }
    }
    if (!best) return null;

    /* Confidence against the patch's own texture, so a blank membrane cannot
       produce a confident snap out of sensor noise. */
    scores.sort(function (p, q) { return p - q; });
    var median = scores[Math.floor(scores.length / 2)] || 0;
    var p90 = scores[Math.floor(scores.length * 0.9)] || 0;

    return {
      x: best.x, y: best.y,
      lambda: best.lambda,
      ratio: median > 1e-9 ? best.lambda / median : (best.lambda > 1e-6 ? Infinity : 0),
      p90: p90,
      dist: Math.hypot(best.x - cx, best.y - cy)
    };
  }

  /* ================= shape fitting ================= */

  function hull(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var cross = function (o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
    var lo = [], hi = [], i;
    for (i = 0; i < p.length; i++) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop();
      lo.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
      while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p[i]) <= 0) hi.pop();
      hi.push(p[i]);
    }
    lo.pop(); hi.pop();
    return lo.concat(hi);
  }

  /* Minimum-area oriented box by rotating calipers.

     Taking the first tapped edge as the axis was the obvious alternative and it
     is worse: a short or sloppily placed first edge then rotates the whole unit.
     The min-area box recovers the true rectangle from any tap order, and copes
     with four corners or with eight points round a messy kerb.

     Three points are the exception, and the tests caught it. The minimum-area
     box around a right triangle is degenerate — aligning to the hypotenuse
     encloses exactly the same area as aligning to the legs, so the caliper
     search picks between them arbitrarily and a clean 2.0 x 3.5 unit came back
     as 1.74 x 4.03. With three taps the user has given corner-edge-corner, so
     the two tapped edges are the only sane candidates. */
  function fitOrientedRect(pts) {
    if (!pts || pts.length < 3) return null;

    var h;
    if (pts.length === 3) {
      h = pts.slice();                      /* candidate axes are p0->p1 and p1->p2 */
    } else {
      h = hull(pts);
      if (h.length < 3) h = pts.slice();
    }

    var best = null;
    for (var i = 0; i < h.length; i++) {
      if (pts.length === 3 && i === 2) break;   /* p2->p0 closes the hypotenuse */
      var a = h[i], b = h[(i + 1) % h.length];
      var ex = b.x - a.x, ey = b.y - a.y;
      var len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      ex /= len; ey /= len;

      var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var j = 0; j < pts.length; j++) {
        var u = pts[j].x * ex + pts[j].y * ey;
        var v = -pts[j].x * ey + pts[j].y * ex;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      var w = maxU - minU, l = maxV - minV, area = w * l;
      if (!best || area < best.area) {
        var cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
        best = {
          area: area, w: w, l: l,
          cx: cu * ex - cv * ey,
          cy: cu * ey + cv * ex,
          rot: Math.atan2(ey, ex)
        };
      }
    }
    if (!best) return null;

    /* Report the longer side as the length, so the rotation always describes the
       short axis turning — otherwise nominally identical units come back as
       3x2 @ 0 deg and 2x3 @ 90 deg depending on which way they were walked. */
    var w = best.w, l = best.l, rot = best.rot;
    if (w > l) { var t = w; w = l; l = t; rot += Math.PI / 2; }
    while (rot > Math.PI / 2) rot -= Math.PI;
    while (rot < -Math.PI / 2) rot += Math.PI;
    return { cx: best.cx, cy: best.cy, w: w, l: l, rot: rot };
  }

  /* Corners of a fitted rectangle, counter-clockwise. */
  function rectCorners(r) {
    var c = Math.cos(r.rot), s = Math.sin(r.rot);
    var hw = r.w / 2, hl = r.l / 2;
    var local = [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]];
    return local.map(function (p) {
      return { x: r.cx + p[0] * c - p[1] * s, y: r.cy + p[0] * s + p[1] * c };
    });
  }

  /* Kasa algebraic circle fit: minimise the residual of
     x^2 + y^2 + Dx + Ey + F = 0, which is linear in D, E, F.
     Exact for three points, least-squares beyond that. Plenty for a roof stack
     or tank traced by hand — the bias of the algebraic form only bites on short
     arcs, and a tapped rim is never that. */
  function fitCircle(pts) {
    if (!pts || pts.length < 3) return null;
    var n = pts.length, Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0;
    for (var i = 0; i < n; i++) {
      var x = pts[i].x, y = pts[i].y, z = x * x + y * y;
      Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
      Sxz += x * z; Syz += y * z; Sz += z;
    }
    var sol = solveLinear([[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]], [-Sxz, -Syz, -Sz]);
    if (!sol) return null;
    var cx = -sol[0] / 2, cy = -sol[1] / 2;
    var rr = cx * cx + cy * cy - sol[2];
    if (rr <= 0) return null;
    return { cx: cx, cy: cy, r: Math.sqrt(rr) };
  }

  function circlePoly(cx, cy, r, n) {
    var out = [];
    n = n || 24;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  }

  function polygonArea(pts) {
    if (!pts || pts.length < 3) return 0;
    var a = 0;
    for (var i = 0, n = pts.length; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  /* ================= station registration ================= */

  /* Rigid 2D fit (Kabsch): the rotation and translation carrying src onto dst
     with scale held at 1 — correct for tying stations together, because both
     already carry their own metric scale.

     `scale` comes back as a diagnostic only. It is what the fit WOULD have used
     had scale been free, so a value of 1.08 means the two stations disagree
     about size by 8% and one of the calibrations is wrong. That number is worth
     more than the fit itself. */
  function rigid2D(src, dst) {
    var n = Math.min(src.length, dst.length), i;
    if (n < 2) return null;

    var sx = 0, sy = 0, dx = 0, dy = 0;
    for (i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += dst[i].x; dy += dst[i].y; }
    sx /= n; sy /= n; dx /= n; dy /= n;

    var S = 0, C = 0, norm = 0;
    for (i = 0; i < n; i++) {
      var ax = src[i].x - sx, ay = src[i].y - sy;
      var bx = dst[i].x - dx, by = dst[i].y - dy;
      S += ax * by - ay * bx;
      C += ax * bx + ay * by;
      norm += ax * ax + ay * ay;
    }
    if (norm < 1e-12) return null;
    var theta = Math.atan2(S, C);
    var ct = Math.cos(theta), st = Math.sin(theta);
    var tx = dx - (ct * sx - st * sy);
    var ty = dy - (st * sx + ct * sy);

    var rms = 0;
    for (i = 0; i < n; i++) {
      var px = ct * src[i].x - st * src[i].y + tx;
      var py = st * src[i].x + ct * src[i].y + ty;
      rms += (px - dst[i].x) * (px - dst[i].x) + (py - dst[i].y) * (py - dst[i].y);
    }
    rms = Math.sqrt(rms / n);

    return { theta: theta, tx: tx, ty: ty, rms: rms, n: n, scale: Math.hypot(C, S) / norm };
  }

  function applyRigid(t, p) {
    var c = Math.cos(t.theta), s = Math.sin(t.theta);
    return { x: c * p.x - s * p.y + t.tx, y: s * p.x + c * p.y + t.ty };
  }

  /* Similarity fit: dst ~= scale * R(theta) * src + t, with scale FREE.

     Distinct from rigid2D, and the distinction matters. Tying two stations
     together is a rigid problem — both frames are already metric, so letting
     scale float would just absorb a real disagreement. Recovering a camera pose
     from a reference rectangle is the opposite: the scale IS the camera height,
     the whole point of the fit. Reusing rigid2D there silently fitted a rotation
     and translation across a 1.6x scale gap, which threw the height tool out by
     4% and sent the focal-length search 10 degrees wide. */
  function similarity2D(src, dst) {
    var n = Math.min(src.length, dst.length), i;
    if (n < 2) return null;

    var sx = 0, sy = 0, dx = 0, dy = 0;
    for (i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += dst[i].x; dy += dst[i].y; }
    sx /= n; sy /= n; dx /= n; dy /= n;

    var S = 0, C = 0, norm = 0;
    for (i = 0; i < n; i++) {
      var ax = src[i].x - sx, ay = src[i].y - sy;
      var bx = dst[i].x - dx, by = dst[i].y - dy;
      S += ax * by - ay * bx;
      C += ax * bx + ay * by;
      norm += ax * ax + ay * ay;
    }
    if (norm < 1e-12) return null;

    var theta = Math.atan2(S, C);
    var scale = Math.hypot(C, S) / norm;
    if (!(scale > 0) || !isFinite(scale)) return null;

    var ct = Math.cos(theta) * scale, st = Math.sin(theta) * scale;
    var tx = dx - (ct * sx - st * sy);
    var ty = dy - (st * sx + ct * sy);

    var rms = 0;
    for (i = 0; i < n; i++) {
      var qx = ct * src[i].x - st * src[i].y + tx;
      var qy = st * src[i].x + ct * src[i].y + ty;
      rms += (qx - dst[i].x) * (qx - dst[i].x) + (qy - dst[i].y) * (qy - dst[i].y);
    }

    return { scale: scale, theta: theta, tx: tx, ty: ty, rms: Math.sqrt(rms / n), n: n };
  }

  /* Inverse of a similarity: dst frame back into src frame. */
  function applySimilarityInverse(t, p) {
    var c = Math.cos(-t.theta), s = Math.sin(-t.theta);
    var x = (p.x - t.tx) / t.scale, y = (p.y - t.ty) / t.scale;
    /* Undo the rotation after removing the translation, then the scale — the
       divide happens first here only because scale and rotation commute. */
    return { x: c * x - s * y, y: s * x + c * y };
  }

  /* ================= geodesy ================= */

  /* WGS84 metres per degree, series form. Good to a few millimetres and far
     simpler than a full geodesic solution — sites are hundreds of metres across,
     not hundreds of kilometres. */
  function metresPerDeg(latDeg) {
    var p = latDeg * DEG;
    return {
      lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
      lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)
    };
  }

  /* Local plan (x right, y up) -> lat/lon.

     `bearingDeg` is the compass bearing of the plan's +Y axis. So bearing 0 puts
     plan-up at true north; bearing 90 puts plan-up due east. */
  function localToLatLon(p, anchor) {
    var br = (anchor.bearing || 0) * DEG;
    var c = Math.cos(br), s = Math.sin(br);
    /* Rotate plan axes onto east/north. */
    var east = p.x * c + p.y * s;
    var north = -p.x * s + p.y * c;
    var m = metresPerDeg(anchor.lat);
    return {
      lat: anchor.lat + north / m.lat,
      lon: anchor.lon + east / (Math.abs(m.lon) < 1e-6 ? 1e-6 : m.lon)
    };
  }

  function latLonToLocal(ll, anchor) {
    var m = metresPerDeg(anchor.lat);
    var north = (ll.lat - anchor.lat) * m.lat;
    var east = (ll.lon - anchor.lon) * m.lon;
    var br = (anchor.bearing || 0) * DEG;
    var c = Math.cos(br), s = Math.sin(br);
    return { x: east * c - north * s, y: east * s + north * c };
  }

  /* Fits anchor lat/lon/bearing so two plan points land on two known lat/lons.

     This is the accurate way to georeference: read the coordinates of two roof
     corners off an aerial, and the plan is placed to within how well they were
     read — no GPS, no compass, neither of which behaves on a steel roof.
     `scaleError` compares the plan distance to the geodetic one, which is a free
     end-to-end check on the whole survey. */
  function anchorFromTwoPoints(planA, llA, planB, llB) {
    var pX = planB.x - planA.x, pY = planB.y - planA.y;
    var pLen = Math.hypot(pX, pY);
    if (pLen < 1e-6) return null;
    var pAng = Math.atan2(pX, pY);          /* clockwise from plan +Y */

    /* localToLatLon expands degrees using metresPerDeg at the ANCHOR latitude, so
       the fit has to use that same latitude or the two disagree. Measuring at the
       midpoint instead left a systematic ~2e-6 bias, which is nothing on the
       ground but quietly poisons scaleError — the one number here whose whole job
       is to be a trustworthy check on the survey.

       The anchor latitude is not known until the fit is done, so iterate: the
       anchor lies within the site of llA, metresPerDeg barely moves over that
       distance, and three passes converge to machine precision. */
    var anchor = { lat: llA.lat, lon: llA.lon, bearing: 0 };
    var gLen = 0;
    for (var it = 0; it < 3; it++) {
      var m = metresPerDeg(anchor.lat);
      if (Math.abs(m.lon) < 1e-6) return null;

      var gE = (llB.lon - llA.lon) * m.lon, gN = (llB.lat - llA.lat) * m.lat;
      gLen = Math.hypot(gE, gN);
      if (gLen < 1e-6) return null;

      anchor.bearing = ((Math.atan2(gE, gN) - pAng) / DEG % 360 + 360) % 360;

      /* Back the anchor off so planA lands exactly on llA. */
      var br = anchor.bearing * DEG, c = Math.cos(br), s = Math.sin(br);
      var eastA = planA.x * c + planA.y * s;
      var northA = -planA.x * s + planA.y * c;
      anchor.lat = llA.lat - northA / m.lat;
      anchor.lon = llA.lon - eastA / m.lon;
    }

    return { anchor: anchor, scaleError: pLen / gLen - 1, groundDist: gLen, planDist: pLen };
  }

  /* ================= KML ================= */

  function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }

  function fmtName(tpl, name, heightM, unit) {
    var h = unit === 'ft' ? heightM / M_PER_FT : heightM;
    var hs = (Math.round(h * 100) / 100).toString();
    return String(tpl || '{name} h={h}{u}')
      .replace(/\{name\}/g, name)
      .replace(/\{h\}/g, hs)
      .replace(/\{u\}/g, unit === 'ft' ? 'ft' : 'm');
  }

  /* KML coordinates are lon,lat,alt — the one ordering everybody gets wrong.
     Rings are closed by repeating the first vertex.

     extrude + relativeToGround means Google Earth draws a real solid at the
     stated height, so the export doubles as a check on the scene before it goes
     anywhere near a layout tool. */
  function ring(coords, anchor, altM) {
    var out = [];
    for (var i = 0; i < coords.length; i++) {
      var ll = localToLatLon(coords[i], anchor);
      out.push(ll.lon.toFixed(8) + ',' + ll.lat.toFixed(8) + ',' + (altM || 0).toFixed(2));
    }
    if (out.length) out.push(out[0]);
    return out.join(' ');
  }

  function placemark(o, anchor, opts) {
    var coords = o.kind === 'cylinder'
      ? circlePoly(o.cx, o.cy, o.r, opts.circleSegments || 24)
      : (o.kind === 'rect' ? rectCorners(o) : (o.pts || []));
    if (coords.length < 3) return '';

    var extrude = o.kind === 'outline' ? 0 : 1;
    var alt = o.kind === 'outline' ? 0 : (o.h || 0);
    var label = o.kind === 'outline' ? o.name : fmtName(opts.nameTemplate, o.name, o.h || 0, opts.unit);

    var ext = '<ExtendedData>' +
      '<Data name="type"><value>' + xmlEsc(o.kind) + '</value></Data>' +
      '<Data name="height_m"><value>' + (o.h || 0).toFixed(3) + '</value></Data>' +
      (o.kind === 'rect' ? '<Data name="width_m"><value>' + o.w.toFixed(3) + '</value></Data>' +
        '<Data name="length_m"><value>' + o.l.toFixed(3) + '</value></Data>' +
        '<Data name="rotation_deg"><value>' + (o.rot / DEG).toFixed(2) + '</value></Data>' : '') +
      (o.kind === 'cylinder' ? '<Data name="radius_m"><value>' + o.r.toFixed(3) + '</value></Data>' +
        '<Data name="diameter_m"><value>' + (o.r * 2).toFixed(3) + '</value></Data>' : '') +
      (o.note ? '<Data name="note"><value>' + xmlEsc(o.note) + '</value></Data>' : '') +
      '</ExtendedData>';

    return '<Placemark>' +
      '<name>' + xmlEsc(label) + '</name>' +
      (o.note ? '<description>' + xmlEsc(o.note) + '</description>' : '') +
      '<styleUrl>#' + (o.kind === 'outline' ? 'ee-outline' : 'ee-obst') + '</styleUrl>' +
      ext +
      '<Polygon><extrude>' + extrude + '</extrude>' +
      '<altitudeMode>' + (extrude ? 'relativeToGround' : 'clampToGround') + '</altitudeMode>' +
      '<outerBoundaryIs><LinearRing><coordinates>' +
      ring(coords, anchor, alt) +
      '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>';
  }

  /* Plan frame -> east/north metres about the anchor.

     The plan's +Y sits at the anchor bearing, so a north-up raster has to be
     built in east/north rather than in plan coordinates. Same rotation that
     localToLatLon applies, exposed on its own so a renderer can work in metres
     and convert once at the end. */
  function planToEastNorth(pt, anchor) {
    var br = (anchor.bearing || 0) * DEG;
    var c = Math.cos(br), s = Math.sin(br);
    return { e: pt.x * c + pt.y * s, n: -pt.x * s + pt.y * c };
  }

  /* East/north metre bounds -> a geodetic LatLonBox.

     LatLonBox is axis-aligned in lat/lon and its <rotation> is a separate spin of
     the image about the box centre in an unspecified frame. At 43 N a degree of
     longitude is ~1.38x shorter than a degree of latitude, so a non-zero rotation
     is not safely defined — the raster is rendered north-up and rotation stays 0. */
  function eastNorthBox(bounds, anchor) {
    var m = metresPerDeg(anchor.lat);
    return {
      north: anchor.lat + bounds.maxN / m.lat,
      south: anchor.lat + bounds.minN / m.lat,
      east: anchor.lon + bounds.maxE / m.lon,
      west: anchor.lon + bounds.minE / m.lon
    };
  }

  /* The overlay on its own, so it can either stand alone or be dropped into a
     Document alongside the vector geometry — one KMZ carrying the tracing base,
     the 3D volumes and the floating labels together. */
  function groundOverlayFragment(box, opts) {
    opts = opts || {};
    return '<GroundOverlay><name>' + xmlEsc(opts.name || 'Eagle Eye plan') + '</name>' +
      '<drawOrder>0</drawOrder>' +
      '<Icon><href>' + xmlEsc(opts.href || 'files/plan.png') + '</href></Icon>' +
      '<LatLonBox>' +
      '<north>' + box.north.toFixed(9) + '</north>' +
      '<south>' + box.south.toFixed(9) + '</south>' +
      '<east>' + box.east.toFixed(9) + '</east>' +
      '<west>' + box.west.toFixed(9) + '</west>' +
      '<rotation>0</rotation>' +
      '</LatLonBox></GroundOverlay>';
  }

  function buildGroundOverlayKML(box, opts) {
    opts = opts || {};
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      '<name>' + xmlEsc(opts.name || 'Eagle Eye plan') + '</name>' +
      '<description>' + xmlEsc(opts.description || '') + '</description>' +
      groundOverlayFragment(box, opts) +
      '</Document></kml>';
  }

  /* A name floating above the object rather than painted on the roof.

     Ground-drawn labels are unreadable the moment anything is placed on the deck —
     they are underneath it. A Point at relativeToGround altitude hangs the name in
     the air above its unit, and extrude draws a tether down so it stays attached
     to something when the view tilts. The icon is suppressed; only the text and
     its leader are wanted. */
  function labelPlacemark(o, anchor, opts) {
    var c = o.kind === 'cylinder' || o.kind === 'rect'
      ? { x: o.cx, y: o.cy }
      : (function () {
        var pts = o.pts || [];
        if (!pts.length) return null;
        var sx = 0, sy = 0;
        pts.forEach(function (q) { sx += q.x; sy += q.y; });
        return { x: sx / pts.length, y: sy / pts.length };
      })();
    if (!c) return '';

    var ll = localToLatLon(c, anchor);
    var lift = opts.labelLift == null ? 1.0 : opts.labelLift;
    var alt = (o.kind === 'outline' ? 0 : (o.h || 0)) + lift;
    var text = o.kind === 'outline'
      ? o.name
      : fmtName(opts.nameTemplate, o.name, o.h || 0, opts.unit);

    return '<Placemark><name>' + xmlEsc(text) + '</name>' +
      '<styleUrl>#ee-label</styleUrl>' +
      '<Point><extrude>1</extrude><altitudeMode>relativeToGround</altitudeMode>' +
      '<coordinates>' + ll.lon.toFixed(8) + ',' + ll.lat.toFixed(8) + ',' + alt.toFixed(2) +
      '</coordinates></Point></Placemark>';
  }

  function buildKML(project, opts) {
    opts = opts || {};
    var anchor = project.anchor;
    if (!anchor || typeof anchor.lat !== 'number') return null;

    var outlines = project.objects.filter(function (o) { return o.kind === 'outline'; });
    var obst = project.objects.filter(function (o) { return o.kind !== 'outline'; });

    var folder = function (name, list, fn) {
      if (!list.length) return '';
      return '<Folder><name>' + xmlEsc(name) + '</name>' +
        list.map(function (o) { return fn(o, anchor, opts); }).join('') +
        '</Folder>';
    };

    var labels = '';
    if (opts.labels !== false) {
      labels = folder('Labels', project.objects.filter(function (o) {
        return o.kind !== 'point' && o.name;
      }), labelPlacemark);
    }

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      '<name>' + xmlEsc(project.name || 'Eagle Eye survey') + '</name>' +
      '<description>' + xmlEsc(
        (project.address || '') +
        '\nSurveyed with Eagle Eye. Heights are encoded in each placemark name and in ExtendedData.'
      ) + '</description>' +
      /* fill 0, not a translucent fill. HelioScope ignores PolyStyle alpha, so a
         55% gold turns solid and hides the roof underneath — which is the one
         thing this layer must not do, since it exists to be traced over. */
      '<Style id="ee-obst"><LineStyle><color>ff37afd4</color><width>3</width></LineStyle>' +
      '<PolyStyle><fill>0</fill><outline>1</outline></PolyStyle></Style>' +
      '<Style id="ee-outline"><LineStyle><color>ffe8f0f4</color><width>3</width></LineStyle>' +
      '<PolyStyle><fill>0</fill></PolyStyle></Style>' +
      /* scale 0 hides the pin: the text and its tether are the whole point */
      '<Style id="ee-label"><IconStyle><scale>0</scale><Icon></Icon></IconStyle>' +
      '<LabelStyle><scale>0.95</scale><color>ffffffff</color></LabelStyle>' +
      '<LineStyle><color>99ffffff</color><width>2</width></LineStyle></Style>' +
      (opts.groundOverlay || '') +
      folder('Roof outline', outlines, placemark) +
      folder('Obstructions', obst, placemark) +
      labels +
      '</Document></kml>';
  }

  /* ================= formatting ================= */

  function fmtLen(m, unit, dp) {
    if (unit === 'ft') {
      var ft = m / M_PER_FT;
      return ft.toFixed(dp == null ? 1 : dp) + ' ft';
    }
    return m.toFixed(dp == null ? 2 : dp) + ' m';
  }
  function fmtArea(m2, unit) {
    if (unit === 'ft') return Math.round(m2 / (M_PER_FT * M_PER_FT)).toLocaleString() + ' ft²';
    return (Math.round(m2 * 10) / 10).toLocaleString() + ' m²';
  }
  function toM(v, unit) { return unit === 'ft' ? v * M_PER_FT : v; }
  function fromM(v, unit) { return unit === 'ft' ? v / M_PER_FT : v; }

  return {
    M_PER_FT: M_PER_FT, DEG: DEG,
    solveLinear: solveLinear, mul3: mul3, invert3: invert3, applyM3: applyM3, transpose3: transpose3,
    homographyFromQuad: homographyFromQuad, applyH: applyH, rectRefCorners: rectRefCorners,
    det3: det3, orientH: orientH, homographyFromPose: homographyFromPose,
    referenceQuality: referenceQuality, steppedReferenceError: steppedReferenceError,
    meanAngleMod90: meanAngleMod90, bestCorner: bestCorner,
    normalFromAttitude: normalFromAttitude, deckTiltDeg: deckTiltDeg, deckBasis: deckBasis,
    jacobianAtPixel: jacobianAtPixel, gsdAtPixel: gsdAtPixel, wForGsd: wForGsd,
    clipHalfPlane: clipHalfPlane, frameFootprint: frameFootprint,
    rotFromOrientation: rotFromOrientation, focalFromFov: focalFromFov,
    quatMul: quatMul, quatFromOrientation: quatFromOrientation, quatToMatrix: quatToMatrix,
    quatSlerp: quatSlerp, quatAngleDeg: quatAngleDeg,
    rayForPixel: rayForPixel, groundPoint: groundPoint, projectToPixel: projectToPixel,
    heightFromBaseTop: heightFromBaseTop, camHeightFromKnown: camHeightFromKnown,
    layoverFactor: layoverFactor, reliefDisplacement: reliefDisplacement,
    maxSafeObjectHeight: maxSafeObjectHeight,
    bearingSensitivity: bearingSensitivity, positionSigma: positionSigma,
    maxTrustedRange: maxTrustedRange,
    hull: hull, fitOrientedRect: fitOrientedRect, rectCorners: rectCorners,
    fitCircle: fitCircle, circlePoly: circlePoly, polygonArea: polygonArea,
    rigid2D: rigid2D, applyRigid: applyRigid,
    similarity2D: similarity2D, applySimilarityInverse: applySimilarityInverse,
    metresPerDeg: metresPerDeg, localToLatLon: localToLatLon, latLonToLocal: latLonToLocal,
    anchorFromTwoPoints: anchorFromTwoPoints,
    buildKML: buildKML, fmtName: fmtName, xmlEsc: xmlEsc,
    planToEastNorth: planToEastNorth, eastNorthBox: eastNorthBox,
    buildGroundOverlayKML: buildGroundOverlayKML, groundOverlayFragment: groundOverlayFragment,
    fmtLen: fmtLen, fmtArea: fmtArea, toM: toM, fromM: fromM
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EE;
