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
  /* The inverse, so a focal length recovered from a homography can be shown as
     the field of view a human recognises. */
  function fovFromFocalLong(f, longPx) {
    if (!(f > 0)) return 0;
    return 2 * Math.atan((longPx / 2) / f) / DEG;
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

  /* Focal length recovered from a plane homography alone — Zhang's constraint.

     This removes the worst guess in the app. A 68 deg field of view was assumed
     for every phone; an iPhone 16 Pro Max main camera is a 24 mm equivalent at
     roughly 73-77 deg, and Safari may hand back a cropped stream at a different
     figure again. In the ray model f sets the perspective outright, so a 10%
     error there puts the vanishing line badly wrong — exactly the failure of a
     calibration that measures fine along one direction and nowhere else.

     If G = H^-1 maps the plane to the image then G = lambda.K.[r1 r2 t], and r1,
     r2 being orthonormal gives two equations. Recentring on the principal point
     leaves K = diag(f, f, 1), so each equation solves for f in closed form — no
     search, no attitude, nothing but the four corners already tapped.

     The two estimates are independent, which is the useful part: when they agree
     the quad is sound, and when they do not it is telling you the corners are
     wrong or the reference is too small to determine perspective at all. */
  function focalFromHomography(H, imgW, imgH) {
    var G = invert3(H);
    if (!G) return null;
    var cx = imgW / 2, cy = imgH / 2;

    /* Columns of G, shifted so the principal point is the origin, then scaled by
       a COMMON factor — the two share one projective scale, so normalising them
       separately would break the equal-length constraint. */
    var g1 = [G[0] - cx * G[6], G[3] - cy * G[6], G[6]];
    var g2 = [G[1] - cx * G[7], G[4] - cy * G[7], G[7]];
    var s = Math.max(Math.hypot(g1[0], g1[1], g1[2]), Math.hypot(g2[0], g2[1], g2[2]));
    if (!(s > 0)) return null;
    for (var i = 0; i < 3; i++) { g1[i] /= s; g2[i] /= s; }

    /* Both denominators vanish in ordinary situations, and an absolute epsilon
       is not enough to notice. Hold the phone without roll and align the
       reference to the frame — the everyday case — and g1z goes to zero, taking
       the first constraint with it; floating-point noise then sails through a
       1e-18 guard and the division returns confident nonsense. With the columns
       normalised, a relative threshold catches it. */
    var EPS = 1e-9;
    var f2a = null, f2b = null;
    var denA = g1[2] * g2[2];
    if (Math.abs(denA) > EPS) {
      var va = -(g1[0] * g2[0] + g1[1] * g2[1]) / denA;
      if (va > 0) f2a = va;
    }
    var denB = g1[2] * g1[2] - g2[2] * g2[2];
    if (Math.abs(denB) > EPS) {
      var vb = ((g2[0] * g2[0] + g2[1] * g2[1]) - (g1[0] * g1[0] + g1[1] * g1[1])) / denB;
      if (vb > 0) f2b = vb;
    }

    /* A focal length outside roughly 10-150 degrees across the frame is not a
       lens; it is a degenerate solve that slipped the guard. */
    var plausible = function (f2) {
      if (f2 == null) return null;
      var f = Math.sqrt(f2);
      var fov = fovFromFocalLong(f, Math.max(imgW, imgH));
      return (fov > 10 && fov < 150) ? f : null;
    };
    var fa = plausible(f2a), fb = plausible(f2b);
    if (fa == null && fb == null) return null;

    var f = (fa != null && fb != null) ? Math.sqrt(fa * fb) : (fa != null ? fa : fb);

    /* How far apart the two independent answers are, as a fraction. */
    var disagree = (fa != null && fb != null)
      ? Math.abs(fa - fb) / Math.max(fa, fb)
      : null;

    return { f: f, fOrtho: fa, fEqual: fb, disagree: disagree };
  }

  /* Where the deck's horizon falls in the image, for a plane homography.
     w = 0 is the vanishing line by construction, so this is exact — and drawing
     it is the fastest way to see that a calibration has gone wrong. */
  function horizonLine(H, imgW, imgH) {
    if (!H) return null;
    var a = H[6], b = H[7], c = H[8];
    if (Math.abs(a) < 1e-18 && Math.abs(b) < 1e-18) return null;

    /* Solved along whichever axis is better conditioned. A y = f(x) form alone
       returns nothing when the horizon is vertical — which is precisely the shape
       a wrongly-rotated frame produces, and the one case the diagnostic most
       needs to draw. */
    var steep = Math.abs(b) < Math.abs(a);
    var h = imgH || imgW;
    if (!steep) {
      return { x0: 0, y0: -c / b, x1: imgW, y1: -(c + a * imgW) / b, steep: false };
    }
    return { x0: -c / a, y0: 0, x1: -(c + b * h) / a, y1: h, steep: true };
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

  /* ================= multi-ball =================

     A sphere of known diameter is a self-ranging landmark: its silhouette gives
     a direction (where it sits in the frame) and a distance (how big it looks),
     so every ball is a full 3D point measured by the photo alone. One ball pins
     scale and camera height; two pin the deck's tilt ALONG the line between
     them; three, spread into a triangle, pin the whole deck plane with no help
     from the attitude sensor at all. Disagreement between that plane and the
     sensor's is then a lie detector — the balls are ON the deck, so when the
     two argue, the balls are right. */

  /* Ball centre as a 3D point in the DEVICE frame, camera at the origin.

     The two rays through the level rim extremes are tangent to the sphere, so
     the distance to its centre is r / sin(half the angle between them), along
     their bisector. Exact to O(sin²θ): for a golf ball past arm's length that
     is sub-millimetre, far below pixel noise — and it reuses the same xL/xR the
     single-ball height solve already measures. */
  function sphereCenterDev(xL, xR, cyRow, imgW, imgH, f, screenAngle, dia) {
    if (!(dia > 0) || !(xR - xL > 2)) return null;
    var a = rayForPixel(xL, cyRow, imgW, imgH, f, screenAngle);
    var b = rayForPixel(xR, cyRow, imgW, imgH, f, screenAngle);
    var sinHalf = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 2;
    /* A ball filling a 60° cone is not a photograph of a ball on a roof. */
    if (!(sinHalf > 1e-7) || sinHalf >= 0.5) return null;
    var dist = (dia / 2) / sinHalf;
    var m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    var mn = Math.hypot(m[0], m[1], m[2]);
    if (mn < 1e-9) return null;
    return { p: [m[0] / mn * dist, m[1] / mn * dist, m[2] / mn * dist], dist: dist };
  }

  /* What one, two or three ball centres say about the deck.

     Everything in ONE frame — the app passes the device frame, so the verdict
     cannot inherit an attitude error. `centers` are ball-centre points, `nPred`
     the predicted deck up-normal in the same frame (gravity + the flip test),
     `r` the ball radius, `relErrs` each ball's relative range error (spread of
     the rim measurement over its width). Centres sit exactly r above the deck,
     so the plane through them IS the deck plane translated — same normal.

     The returned `use` is the arbitration: the photo's plane replaces the
     sensor's only when the disagreement exceeds what the photo can actually
     resolve — correcting a good sensor by ranging noise would be adding noise,
     while a sensor lying beyond the gate loses to the balls, which are ground
     truth by construction. */
  function ballPlane(centers, nPred, r, relErrs) {
    if (!centers || !centers.length) return null;
    var dot = function (u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; };
    var sub = function (u, v) { return [u[0] - v[0], u[1] - v[1], u[2] - v[2]]; };
    var unit = function (u) {
      var m = Math.hypot(u[0], u[1], u[2]);
      return m > 1e-12 ? [u[0] / m, u[1] / m, u[2] / m] : null;
    };
    var cross = function (u, v) {
      return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    };
    var clampd = function (v) { return v < -1 ? -1 : v > 1 ? 1 : v; };

    var n = unit(nPred);
    if (!n) return null;
    var k = centers.length;
    var hVs = function (nn) {
      return centers.map(function (c) { return r - dot(c, nn); });
    };
    var mean = function (a) {
      var s = 0; for (var i = 0; i < a.length; i++) s += a[i];
      return s / a.length;
    };
    /* Per-ball height noise against a plane: range error projected onto the
       normal — the component that can masquerade as tilt. */
    var hSigma = function (nn) {
      return centers.map(function (c, i) {
        var d = Math.hypot(c[0], c[1], c[2]);
        var rel = (relErrs && relErrs[i] > 0) ? relErrs[i] : 0.01;
        return d * rel * Math.abs(dot(unit(c), nn));
      });
    };

    var res = { mode: k, n: n, use: 'sensor', hs: hVs(n), sigmaDeg: null };
    if (k === 1) { res.camH = res.hs[0]; return res; }

    /* Range consistency, judged before any plane geometry: every ball prices
       the same camera height against the sensor's plane, and however wrong
       that plane is (bounded by what a sensor can be wrong by), the answers
       agree to a few tens of centimetres. A ball whose height stands half a
       metre from the others has a corrupt RANGE — a rim locked at the wrong
       size — and it poisons the plane and the height mean alike, at any
       spread. This is the check that catches it even when the constellation
       is too bunched for the plane mathematics to notice anything. */
    var hsSorted = res.hs.slice().sort(function (a, b) { return a - b; });
    var hMed = hsSorted[Math.floor(hsSorted.length / 2)];
    var hTol = Math.max(0.35, 0.25 * Math.abs(hMed));
    if (k === 2) {
      if (Math.abs(res.hs[0] - res.hs[1]) > hTol) res.rangeSuspect = -1;
    } else {
      var worstI = -1, worstDev = 0;
      for (var qi = 0; qi < k; qi++) {
        var dev = Math.abs(res.hs[qi] - hMed);
        if (dev > worstDev) { worstDev = dev; worstI = qi; }
      }
      if (worstDev > hTol) {
        /* One traitor, or everything? A single corrupt ball leaves the OTHERS
           in tight agreement AT A BELIEVABLE HEIGHT; an attitude wrong enough
           to spread the heights — the screen-rotation class — prices the
           camera somewhere absurd (30° of tilt read the test scene at 0.33 m
           and −0.17 m). The first names a ball; the second must not frame one. */
        var others = [];
        for (var qj = 0; qj < k; qj++) if (qj !== worstI) others.push(res.hs[qj]);
        var spread2 = Math.abs(others[0] - others[1]);
        var believable = hMed > 0.4 && hMed < 4;
        if (believable && spread2 <= Math.max(0.2, 0.15 * Math.abs(hMed))) res.rangeSuspect = worstI;
        else res.systemic = true;
      }
    }

    var sz = hSigma(n);
    var gateOf = function (sigmaDeg) { return Math.max(1.2, 1.6 * sigmaDeg); };
    /* Adoption is gated THREE ways, because the failure the field produced was a
       plane the photo had no business asserting:
       1. disagree > gate: the photo must see more than its own noise. But with a
          bunched constellation the disagreement IS the noise — a tail event
          walks through a purely statistical gate and a 55° horizon gets drawn
          with full confidence. Hence:
       2. sigma <= PHOTO_CAP: the constellation must be capable in absolute
          terms. A cluster of balls a hand-span apart resolves ±10° at best;
          adopting anything from it trades a possibly-wrong sensor for a
          certainly-noisy photo. When this trips, the answer is not arbitration,
          it is "spread the balls". The cap sits at 4° because a metre-wide
          triangle at working range lands at ±2.5-3° — squarely eligible —
          while a cluster lands at ±8° and up; and adoption still requires
          disagree > 1.6 sigma, so the trade is favourable whenever it happens.
       3. disagree <= SANITY: after the flip test no phone sensor is 25° wrong.
          A capable constellation reporting a wilder plane than that means one
          ball's range is corrupt — locked on a shadow, or not on the deck — and
          the right response is refusal naming the problem, not adoption. */
    var PHOTO_CAP = 4, SANITY = 25;
    var arbitrate = function (nc) {
      /* A set with a corrupt range or a systemic inconsistency never adopts,
         whatever its plane says — its height mean is as poisoned as its tilt. */
      if (res.rangeSuspect != null || res.systemic) return;
      /* Incapable next: when sigma is huge, any wild disagreement is the
         photo's own noise and the actionable diagnosis is "spread the balls" —
         which also unmasks a corrupt ball if one is hiding in the cluster. */
      if (res.sigmaDeg > PHOTO_CAP) { res.whyNot = 'noise'; return; }
      if (res.disagreeDeg > SANITY) { res.implausible = true; return; }
      if (res.disagreeDeg <= gateOf(res.sigmaDeg)) return;
      res.use = 'photo'; res.n = nc;
    };

    if (k === 2) {
      var d2 = sub(centers[1], centers[0]);
      var L = Math.hypot(d2[0], d2[1], d2[2]);
      res.baselineM = L;
      if (L < 0.05) {
        res.degenerate = 'coincident';
        res.camH = mean(res.hs);
        return res;
      }
      var dh = unit(d2);
      var s = clampd(dot(dh, n));
      res.tiltAlongDeg = Math.asin(s) / DEG;
      res.disagreeDeg = Math.abs(res.tiltAlongDeg);
      res.sigmaDeg = Math.atan(Math.hypot(sz[0], sz[1]) / L) / DEG;
      var nc = unit([n[0] - s * dh[0], n[1] - s * dh[1], n[2] - s * dh[2]]);
      res.nPhoto = nc || n;
      if (nc && L >= 0.15) arbitrate(nc);
      res.camH = mean(hVs(res.n));
      return res;
    }

    /* Three (the app never passes more): the full plane. */
    var u3 = sub(centers[1], centers[0]);
    var v3 = sub(centers[2], centers[0]);
    var w3 = sub(centers[2], centers[1]);
    var cr = cross(u3, v3);
    var area2 = Math.hypot(cr[0], cr[1], cr[2]);
    var Lmax = Math.max(Math.hypot(u3[0], u3[1], u3[2]),
      Math.hypot(v3[0], v3[1], v3[2]), Math.hypot(w3[0], w3[1], w3[2]));
    res.maxSideM = Lmax;
    /* The triangle's smallest altitude is the lever arm for the cross-baseline
       tilt — three balls nearly in a line know no more about that axis than two. */
    res.minAltM = Lmax > 1e-9 ? area2 / Lmax : 0;
    var nb = unit(cr);
    /* Two distinct ways to fail, with two distinct fixes: a FLAT triangle
       (three balls nearly in a row — move one sideways) and a TINY one (a
       hand-span cluster — spread everything out). */
    if (!nb || res.minAltM < 0.12 * Lmax) {
      res.degenerate = 'collinear';
      res.camH = mean(res.hs);
      return res;
    }
    if (res.minAltM < 0.15) {
      res.degenerate = 'tiny';
      res.camH = mean(res.hs);
      return res;
    }
    if (dot(nb, n) < 0) nb = [-nb[0], -nb[1], -nb[2]];
    res.nPhoto = nb;
    res.disagreeDeg = Math.acos(clampd(dot(nb, n))) / DEG;
    var szM = Math.max(sz[0], sz[1], sz[2]);
    res.sigmaDeg = Math.atan(Math.SQRT2 * szM / Math.min(res.minAltM, Lmax)) / DEG;
    arbitrate(nb);
    res.camH = mean(hVs(res.n));
    return res;
  }

  /* ================= planar references with more than four corners =================

     A regular reference with N corners over-determines the homography, and the
     surplus is the value: four points always fit exactly and so say nothing
     about their own quality, while a fifth and sixth disagree by exactly the
     amount the taps and the print are wrong. Solved as a normalised linear
     least-squares (Hartley's normalisation — centre both point sets and scale
     to mean distance √2 — which turns a numerically vile system into a tame
     one; the standard prescription for DLT). */
  function homographyFromPoints(imgPts, refPts) {
    if (!imgPts || !refPts || imgPts.length < 4 || imgPts.length !== refPts.length) return null;
    var n = imgPts.length;

    var normalise = function (pts) {
      var cx = 0, cy = 0, i;
      for (i = 0; i < n; i++) { cx += pts[i].x; cy += pts[i].y; }
      cx /= n; cy /= n;
      var d = 0;
      for (i = 0; i < n; i++) d += Math.hypot(pts[i].x - cx, pts[i].y - cy);
      d /= n;
      var s = d > 1e-12 ? Math.SQRT2 / d : 1;
      return {
        s: s, cx: cx, cy: cy,
        pts: pts.map(function (p) { return { x: (p.x - cx) * s, y: (p.y - cy) * s }; })
      };
    };
    var A = normalise(imgPts), B = normalise(refPts);

    /* 2n equations in the 8 unknowns of H (h8 = 1), assembled straight into the
       normal equations. */
    var M = [], v = [], r, c;
    for (r = 0; r < 8; r++) { M.push([0, 0, 0, 0, 0, 0, 0, 0]); v.push(0); }
    var addRow = function (row, rhs) {
      for (r = 0; r < 8; r++) {
        for (c = 0; c < 8; c++) M[r][c] += row[r] * row[c];
        v[r] += row[r] * rhs;
      }
    };
    for (var i = 0; i < n; i++) {
      var x = A.pts[i].x, y = A.pts[i].y, X = B.pts[i].x, Y = B.pts[i].y;
      addRow([x, y, 1, 0, 0, 0, -x * X, -y * X], X);
      addRow([0, 0, 0, x, y, 1, -x * Y, -y * Y], Y);
    }
    var h = solveLinear(M, v);
    if (!h) return null;
    var Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];

    /* Denormalise: H = Tref^-1 · Hn · Timg. */
    var Timg = [A.s, 0, -A.s * A.cx, 0, A.s, -A.s * A.cy, 0, 0, 1];
    var TrefInv = [1 / B.s, 0, B.cx, 0, 1 / B.s, B.cy, 0, 0, 1];
    var H = mul3(TrefInv, mul3(Hn, Timg));
    if (!H.every(isFinite)) return null;

    /* Same sign convention as every other H in the app. */
    var mid = { x: 0, y: 0 };
    for (i = 0; i < n; i++) { mid.x += imgPts[i].x / n; mid.y += imgPts[i].y / n; }
    return orientH(H, mid);
  }

  /* Corners of a regular hexagon of the given side, anticlockwise, centred on
     the origin. The circumradius of a regular hexagon IS its side. */
  function hexCorners(side) {
    var out = [];
    for (var k = 0; k < 6; k++) {
      var a = k * 60 * DEG;
      out.push({ x: side * Math.cos(a), y: side * Math.sin(a) });
    }
    return out;
  }

  /* Shoelace, signed. In image coordinates (y down) a polygon walked clockwise
     on screen comes out positive — the sign is what the winding fix reads. */
  function signedArea(pts) {
    var s = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }

  /* Planar reference + trusted gravity, with the LENS as the unknown.

     The field data showed why this exists: a hexagon spanning 200-380 px fits a
     homography whose scale is fine but whose perspective terms are mush — its
     own two focal estimates disagreed by 26-40%, and its vanishing line sat 18°
     from gravity's. The cure is the same pairing that rescued the bank card,
     upgraded: take the PLANE from gravity, and instead of assuming a lens to
     project the taps onto it, SEARCH for the focal length that makes the
     projected shape best match the known reference. A wrong f shears and
     stretches the projected hexagon; the true f is where the similarity
     residual bottoms out — so a modest panel plus a trusted attitude measures
     the lens that the panel alone could not.

     Near nadir f degenerates into pure scale and the curve goes flat; the
     `identifiable` flag says whether the minimum was sharp enough to trust
     (both 1.2× and 1/1.2× of the best f must at least double the residual). */
  /* The search bracket is ABSOLUTE — every focal length a phone camera could
     plausibly deliver, 35° to 110° of field of view across the long edge —
     never a window around the currently-assumed lens. The field showed why: a
     poisoned assumption (100° written by an earlier bad solve) clamped the
     next solve to its own neighbourhood, and the wrong lens perpetuated
     itself. */
  function fBracket(imgW, imgH) {
    var half = Math.max(imgW, imgH) / 2;
    return { lo: half / Math.tan(55 * DEG), hi: half / Math.tan(17.5 * DEG) };
  }

  function fitPlanarByF(imgPts, refPts, R, deckNormal, imgW, imgH, screenAngle, Rof) {
    if (!imgPts || imgPts.length < 3) return null;
    var useRof = typeof Rof === 'function';
    var evalAt = function (f) {
      /* A horizon-locked attitude is itself a function of f: the lock is the
         alignment of the raw sensor to two tapped rays, and those rays move
         with the lens. Solving f while holding a lock computed at some OTHER
         f is how the field got a 28%-high lens at a 1 mm residual — the
         attitude error and the lens error cancelled each other into a lie.
         With Rof the lock is re-derived at every candidate f, so the two can
         no longer conspire. */
      var Rf = useRof ? Rof(f) : R;
      if (!Rf) return null;
      var unit = [];
      for (var i = 0; i < imgPts.length; i++) {
        var gp = groundPoint(rayForPixel(imgPts[i].x, imgPts[i].y, imgW, imgH, f, screenAngle),
          Rf, 1, 0, deckNormal);
        if (!gp) return null;
        unit.push(gp);
      }
      var fit = similarity2D(unit, refPts);
      if (!fit || !(fit.scale > 0.2 && fit.scale < 30)) return null;
      return { f: f, fit: fit, rms: fit.rms };
    };

    var br = fBracket(imgW, imgH);
    var lo = br.lo, hi = br.hi;
    var best = null, i2;
    for (i2 = 0; i2 <= 40; i2++) {
      var f2 = lo * Math.pow(hi / lo, i2 / 40);
      var e2 = evalAt(f2);
      if (e2 && (!best || e2.rms < best.rms)) best = e2;
    }
    if (!best) return null;
    var step = best.f * (Math.pow(hi / lo, 1 / 40) - 1);
    for (i2 = 0; i2 < 20; i2++) {
      var l2 = evalAt(best.f - step), r2 = evalAt(best.f + step);
      if (l2 && l2.rms < best.rms) best = l2;
      else if (r2 && r2.rms < best.rms) best = r2;
      else step /= 2;
      if (step < best.f * 1e-4) break;
    }

    /* Identifiability, the honest version: the interval of f whose residual
       stays within 1.5× of the best. Field curves proved a single shot at
       ordinary look-down angles has a valley ±20-40% wide — solving to a
       minimum is easy, TRUSTING it is what needs the narrow valley. The
       interval is returned either way so several shots can be fused: their
       curves multiply, and two shots at different pitches pin what one
       cannot. */
    var lim = best.rms * 1.5 + 1e-5;
    var fLo = best.f, fHi = best.f, e3;
    for (i2 = 1; i2 <= 30; i2++) {
      var fq = best.f * Math.pow(lo / best.f, i2 / 30);
      e3 = evalAt(fq);
      if (!e3 || e3.rms > lim) break;
      fLo = fq;
    }
    for (i2 = 1; i2 <= 30; i2++) {
      var fq2 = best.f * Math.pow(hi / best.f, i2 / 30);
      e3 = evalAt(fq2);
      if (!e3 || e3.rms > lim) break;
      fHi = fq2;
    }
    var halfWidth = (fHi - fLo) / 2 / best.f;
    var atEdge = fLo <= lo * 1.03 || fHi >= hi * 0.97;
    return {
      f: best.f, fit: best.fit, rms: best.rms,
      fLo: fLo, fHi: fHi,
      identifiable: !atEdge && halfWidth <= 0.15,
      evalAt: evalAt
    };
  }

  /* One lens, several shots: the same camera took them all, so their residual
     curves share a minimum even when each alone is too shallow to trust. The
     field proved it on real data — two shots whose single valleys spanned
     ±25-40% put their JOINT minimum within 5% of the camera's spec sheet.
     `shots`: [{imgPts, refPts, R, deckNormal, imgW, imgH, screenAngle}]. */
  function fuseLens(shots) {
    if (!shots || !shots.length) return null;
    var solos = [];
    for (var i = 0; i < shots.length; i++) {
      var s2 = shots[i];
      var solo = fitPlanarByF(s2.imgPts, s2.refPts, s2.R, s2.deckNormal, s2.imgW, s2.imgH, s2.screenAngle, s2.Rof);
      if (solo) solos.push(solo);
    }
    if (!solos.length) return null;
    var br = fBracket(shots[0].imgW, shots[0].imgH);
    var joint = function (f) {
      var sum = 0, n = 0;
      for (var j = 0; j < solos.length; j++) {
        var e = solos[j].evalAt(f);
        if (!e) return null;
        sum += e.rms * e.rms; n++;
      }
      return Math.sqrt(sum / n);
    };
    var best = null, i2;
    for (i2 = 0; i2 <= 60; i2++) {
      var f2 = br.lo * Math.pow(br.hi / br.lo, i2 / 60);
      var r2 = joint(f2);
      if (r2 != null && (!best || r2 < best.rms)) best = { f: f2, rms: r2 };
    }
    if (!best) return null;
    /* The grid is ~3% coarse; walk the minimum down, or the fused lens lands
       a percent-and-a-half off and every fixed-f fit inherits it. */
    var step = best.f * (Math.pow(br.hi / br.lo, 1 / 60) - 1);
    for (i2 = 0; i2 < 20; i2++) {
      var lr = joint(best.f - step), rr2 = joint(best.f + step);
      if (lr != null && lr < best.rms) best = { f: best.f - step, rms: lr };
      else if (rr2 != null && rr2 < best.rms) best = { f: best.f + step, rms: rr2 };
      else step /= 2;
      if (step < best.f * 1e-4) break;
    }
    var lim = best.rms * 1.5 + 1e-5;
    var fLo = best.f, fHi = best.f, rq;
    for (i2 = 1; i2 <= 40; i2++) {
      var fq = best.f * Math.pow(br.lo / best.f, i2 / 40);
      rq = joint(fq);
      if (rq == null || rq > lim) break;
      fLo = fq;
    }
    for (i2 = 1; i2 <= 40; i2++) {
      var fq2 = best.f * Math.pow(br.hi / best.f, i2 / 40);
      rq = joint(fq2);
      if (rq == null || rq > lim) break;
      fHi = fq2;
    }
    var halfWidth = (fHi - fLo) / 2 / best.f;
    return {
      f: best.f, rms: best.rms, n: solos.length,
      fLo: fLo, fHi: fHi,
      identifiable: fLo > br.lo * 1.03 && fHi < br.hi * 0.97 && halfWidth <= 0.15
    };
  }

  /* Convex hull of a point cloud, simplified to exactly n vertices by
     repeatedly dropping the vertex whose removal loses the least area — the
     shape-preserving way to turn a pixel-mask boundary into the polygon it
     came from. Powers the LIVE panel detector. */
  function hullSimplify(pts, n) {
    if (!pts || pts.length < n) return null;
    var P = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var cross2 = function (o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
    var lo = [], hi = [], i;
    for (i = 0; i < P.length; i++) {
      while (lo.length >= 2 && cross2(lo[lo.length - 2], lo[lo.length - 1], P[i]) <= 0) lo.pop();
      lo.push(P[i]);
    }
    for (i = P.length - 1; i >= 0; i--) {
      while (hi.length >= 2 && cross2(hi[hi.length - 2], hi[hi.length - 1], P[i]) <= 0) hi.pop();
      hi.push(P[i]);
    }
    lo.pop(); hi.pop();
    var h = lo.concat(hi);
    if (h.length < n) return null;
    var tri = function (a, b, c) {
      return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    };
    while (h.length > n) {
      var worst = Infinity, wi = -1, m = h.length;
      for (i = 0; i < m; i++) {
        var t = tri(h[(i - 1 + m) % m], h[i], h[(i + 1) % m]);
        if (t < worst) { worst = t; wi = i; }
      }
      h.splice(wi, 1);
    }
    return h.map(function (q) { return { x: q.x, y: q.y }; });
  }

  /* Tie two stations by the SAME physical hexagon they both calibrated on.

     Six corners, but which is which? A regular hexagon offers six rotations of
     correspondence; the expected frame-to-frame rotation (from each station's
     known plan-to-north offset) picks the right one, since candidates differ by
     60° and no compass or pose is that wrong. Returns the rigid placement of B
     into A's frame, the residual, and the similarity scale — which must be 1,
     because it is the same panel; a scale off by more than a few percent means
     the two calibrations disagree about its size. */
  function hexTie(groundA, groundB, expThetaRad) {
    if (!groundA || !groundB || groundA.length !== 6 || groundB.length !== 6) return null;
    var wrapPi = function (a) {
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return a;
    };
    var best = null;
    for (var k = 0; k < 6; k++) {
      var dst = [];
      for (var j = 0; j < 6; j++) dst.push(groundA[(j + k) % 6]);
      var fit = rigid2D(groundB, dst);
      if (!fit) continue;
      var dTh = Math.abs(wrapPi(fit.theta - (expThetaRad || 0)));
      if (!best || dTh < best.dTh) {
        var sim = similarity2D(groundB, dst);
        best = { reg: fit, k: k, dTh: dTh, scale: sim ? sim.scale : 1 };
      }
    }
    if (!best || best.dTh > 35 * DEG) return null;
    return { theta: best.reg.theta, tx: best.reg.tx, ty: best.reg.ty,
      rms: best.reg.rms, k: best.k, dThetaDeg: best.dTh / DEG, scale: best.scale };
  }

  /* ================= ARKit =================

     A native shell (eagle-eye-native/) runs an ARSession and streams the
     camera's pose and the lens's FACTORY intrinsics into this same web app.
     Both arrive in ARKit's conventions, and converting them is pure geometry
     — so it lives here, where the test suite can prove it, rather than in
     Swift where it could not be checked from this machine at all.

     Frames:
       ARKit world (.gravityAndHeading): X east, Y up, Z south.
       This app's world:                 X east, Y north, Z up.
     so v_app = C.v_ar with C = [1 0 0; 0 0 -1; 0 1 0].

       ARKit's camera-local frame is tied to landscapeRight: +X runs along the
       long axis from the front camera toward the home button, +Y is "up" in
       that orientation, +Z out of the glass. The W3C device frame this app's
       attitudes already use is portrait-fixed: +X right, +Y screen-top, +Z out
       of the glass. In portrait terms ARKit's +X is -Y and its +Y is +X, so
       v_device = M.v_arcam with M = [0 1 0; -1 0 0; 0 0 1].

     ARCamera.transform maps camera-local to ARKit world, so this app's
     device->world rotation is R = C.R_ar.M^T. Device-orientation angles are
     device-fixed rather than interface-fixed, so that holds in every interface
     orientation — the screen rotation stays where it has always been handled,
     in rayForPixel's screenAngle. */
  var AR_C = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  var AR_M = [0, 1, 0, -1, 0, 0, 0, 0, 1];

  function rotFromARKit(Rar) {
    return mul3(AR_C, mul3(Rar, transpose3(AR_M)));
  }

  /* A simd_float4x4 arrives column-major: m[0..3] is column 0. Returns the
     attitude in the SAME alpha/beta/gamma the sensor path produces — so every
     consumer downstream (attMatrix, homographyFromPose, the whole geometry)
     works unchanged — plus the thing the web never had: metric position. */
  function arkitPose(m) {
    if (!m || m.length < 16) return null;
    var Rar = [m[0], m[4], m[8],
               m[1], m[5], m[9],
               m[2], m[6], m[10]];
    var R = rotFromARKit(Rar);
    var e = orientationFromRot(R);
    return {
      R: R,
      alpha: ((e.alpha % 360) + 360) % 360, beta: e.beta, gamma: e.gamma,
      pos: { x: m[12], y: -m[14], z: m[13] }
    };
  }

  /* An ARPlaneAnchor as a rectangle in this app's frame.

     ARKit describes a plane in its own anchor space: a centre, an extent lying
     in the anchor's x/z axes, and a rotation about the anchor's y (its normal,
     which for a horizontal plane is up). The anchor's transform then places
     that in ARKit's world. Four corners come out of that; C brings them into
     this app's east/north frame, and the plane's height is the world y.

     Returned as the rectangle this app already draws and exports — centre,
     sides, rotation — plus the corners it came from. */
  function planeCornersFromARKit(m, cx, cy, cz, w, h, rotY) {
    if (!m || m.length < 16) return null;
    var cr = Math.cos(rotY || 0), sr = Math.sin(rotY || 0);
    var hw = w / 2, hh = h / 2;
    var local = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    var out = [], zs = 0;
    for (var i = 0; i < 4; i++) {
      var lx = local[i][0], lz = local[i][1];
      var ax = cx + lx * cr + lz * sr;
      var az = cz - lx * sr + lz * cr;
      var ay = cy;
      var wx = m[0] * ax + m[4] * ay + m[8] * az + m[12];
      var wy = m[1] * ax + m[5] * ay + m[9] * az + m[13];
      var wz = m[2] * ax + m[6] * ay + m[10] * az + m[14];
      out.push({ x: wx, y: -wz });          /* ARKit east/up/south -> east/north */
      zs += wy;
    }
    var mx = 0, my = 0;
    out.forEach(function (q) { mx += q.x / 4; my += q.y / 4; });
    var e1 = { x: out[1].x - out[0].x, y: out[1].y - out[0].y };
    var e2 = { x: out[2].x - out[1].x, y: out[2].y - out[1].y };
    return {
      corners: out, z: zs / 4, cx: mx, cy: my,
      w: Math.hypot(e1.x, e1.y), l: Math.hypot(e2.x, e2.y),
      rot: Math.atan2(e1.y, e1.x)
    };
  }

  /* Factory intrinsics -> the field of view this app stores. fx is already in
     pixels of the captured frame, and pixels are square, so the long-edge FOV
     follows directly — no assumption, no fusion, no search: the lens problem
     that cost this project four versions simply stops existing. */
  function fovFromIntrinsics(fx, imgW, imgH) {
    if (!(fx > 0) || !(imgW > 0)) return null;
    return fovFromFocalLong(fx, Math.max(imgW, imgH || 0));
  }

  /* ================= the horizon as an instrument =================

     Outdoors the true horizon is a gravity reference better than any MEMS
     sensor: two pixels on it give two rays that BOTH lie in the horizontal
     plane through the camera, so their cross product is vertical — the full
     gravity direction in the device frame, read from the photo. (The visible
     horizon dips below true horizontal by ~0.03° per √metre of height above
     the surrounding terrain — 0.2° from a 30 m roof — which is smaller than a
     tap and is noted rather than modelled.) */
  function gravityFromHorizon(p1, p2, imgW, imgH, f, screenAngle, gHintDev) {
    if (!p1 || !p2) return null;
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 40) return null;   /* too short to aim */
    var a = rayForPixel(p1.x, p1.y, imgW, imgH, f, screenAngle);
    var b = rayForPixel(p2.x, p2.y, imgW, imgH, f, screenAngle);
    var g = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    var m = Math.hypot(g[0], g[1], g[2]);
    if (m < 1e-9) return null;
    g = [g[0] / m, g[1] / m, g[2] / m];
    /* Two signs describe the same line; the sensor — however biased — is never
       wrong about which way is DOWN. Without a hint, screen-top-up is assumed. */
    var hint = gHintDev || [0, -1, 0];
    if (g[0] * hint[0] + g[1] * hint[1] + g[2] * hint[2] < 0) g = [-g[0], -g[1], -g[2]];
    return g;
  }

  /* Euler angles back out of a rotation matrix — the exact inverse of
     rotFromOrientation (Z-X'-Y'' order). Near beta = ±90° the alpha/gamma pair
     degenerates; the fallback pins gamma and puts the whole yaw in alpha. */
  function orientationFromRot(R) {
    var sB = Math.max(-1, Math.min(1, R[7]));
    var beta = Math.asin(sB);
    var cB = Math.cos(beta);
    if (Math.abs(cB) < 1e-6) {
      return { alpha: Math.atan2(R[2], R[0]) / DEG, beta: beta / DEG, gamma: 0 };
    }
    return {
      alpha: Math.atan2(-R[1], R[4]) / DEG,
      beta: beta / DEG,
      gamma: Math.atan2(-R[6], R[8]) / DEG
    };
  }

  /* Rotation about a unit axis (Rodrigues). */
  function rotAxisAngle(axis, ang) {
    var c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    var x = axis[0], y = axis[1], z = axis[2];
    return [
      t * x * x + c, t * x * y - s * z, t * x * z + s * y,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c
    ];
  }

  /* Correct an attitude so that device-frame down matches a measured direction
     (from the tapped horizon), disturbing the yaw as little as possible: the
     minimal rotation taking the measured down onto the sensor's down, composed
     on the device side. */
  function alignToGravity(Rsensor, gDevMeasured) {
    var d = [0, 0, -1];
    var gS = applyM3(transpose3(Rsensor), d);
    var gT = gDevMeasured;
    var dot = gT[0] * gS[0] + gT[1] * gS[1] + gT[2] * gS[2];
    dot = Math.max(-1, Math.min(1, dot));
    var ax = [gT[1] * gS[2] - gT[2] * gS[1], gT[2] * gS[0] - gT[0] * gS[2], gT[0] * gS[1] - gT[1] * gS[0]];
    var m = Math.hypot(ax[0], ax[1], ax[2]);
    if (m < 1e-9) return { R: Rsensor, movedDeg: 0 };
    var Q = rotAxisAngle([ax[0] / m, ax[1] / m, ax[2] / m], Math.acos(dot));
    return { R: mul3(Rsensor, Q), movedDeg: Math.acos(dot) / DEG };
  }

  /* The dominant colour axis of a patch — the direction RGB actually varies
     along, found by power iteration on the 3×3 covariance. For a two-material
     patch (panel corner against deck) this IS the material boundary's axis,
     whatever the colours are; projecting onto it concentrates the boundary's
     contrast into one channel the way luminance only manages by luck. */
  function principalAxis(rgbSamples) {
    if (!rgbSamples || rgbSamples.length < 8) return null;
    var n = rgbSamples.length, mean = [0, 0, 0], i, k;
    for (i = 0; i < n; i++) for (k = 0; k < 3; k++) mean[k] += rgbSamples[i][k] / n;
    var C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < n; i++) {
      var d = [rgbSamples[i][0] - mean[0], rgbSamples[i][1] - mean[1], rgbSamples[i][2] - mean[2]];
      for (var r2 = 0; r2 < 3; r2++) for (var c2 = 0; c2 < 3; c2++) C[r2 * 3 + c2] += d[r2] * d[c2] / n;
    }
    var w = [1, 1, 1];
    for (i = 0; i < 24; i++) {
      w = applyM3(C, w);
      var m2 = Math.hypot(w[0], w[1], w[2]);
      if (m2 < 1e-9) return null;
      w = [w[0] / m2, w[1] / m2, w[2] / m2];
    }
    var lambda = Math.hypot.apply(null, applyM3(C, w));
    if (lambda < 25) return null;              /* flat patch — nothing varies */
    return { w: w, strength: Math.sqrt(lambda) };
  }

  /* ================= adjusting the whole survey at once =================

     Shots are placed pairwise as they arrive, so tie error compounds along the
     chain. The fix — borrowed in spirit from global bundle adjustment — is to
     solve every pose and every landmark TOGETHER. In 2D the problem is kinder
     than the 3D original: writing each pose as a complex number z = s·e^{iθ}
     plus a translation makes "landmark k seen from station i" EXACTLY linear,
     so one least-squares solve lands the global optimum of the similarity
     version with no initial guess at all. A few closed-form alternation sweeps
     then tighten it to rigid (unit scale), which is the app's convention —
     the per-station |z| from the linear stage is reported as a scale check
     rather than silently applied.

     `stations`: [{ id, fixed, pts: [{name, x, y}] }] in each station's own
     frame; the first FIXED station defines the gauge. Returns per-station
     poses, fused landmarks, and residuals. */
  function adjust2D(stations) {
    if (!stations || stations.length < 2) return null;

    /* landmarks seen from at least two stations */
    var count = {}, i, j, k;
    stations.forEach(function (s) {
      s.pts.forEach(function (o) { count[o.name] = (count[o.name] || 0) + 1; });
    });
    var names = Object.keys(count).filter(function (nm) { return count[nm] >= 2; });
    if (names.length < 2) return null;
    var lmIdx = {};
    names.forEach(function (nm, ii) { lmIdx[nm] = ii; });

    var free = [], freeIdx = {};
    stations.forEach(function (s) {
      s.use = s.pts.filter(function (o) { return lmIdx[o.name] != null; });
      if (!s.fixed && s.use.length >= 2) { freeIdx[s.id] = free.length; free.push(s); }
    });
    var anyFixed = stations.some(function (s) { return s.fixed && s.use.length >= 1; });
    if (!anyFixed || !free.length) return null;

    /* unknowns: [a,b,tx,ty] per free station, then [px,py] per landmark */
    var NF = free.length, M = names.length, dim = 4 * NF + 2 * M;
    var A = [], b = [];
    for (i = 0; i < dim; i++) {
      var row0 = [];
      for (j = 0; j < dim; j++) row0.push(0);
      A.push(row0); b.push(0);
    }
    var addEq = function (idx, coef, rhs) {
      for (var r2 = 0; r2 < idx.length; r2++) {
        for (var c2 = 0; c2 < idx.length; c2++) A[idx[r2]][idx[c2]] += coef[r2] * coef[c2];
        b[idx[r2]] += coef[r2] * rhs;
      }
    };
    stations.forEach(function (s) {
      if (s.fixed) {
        s.use.forEach(function (o) {
          var L = 4 * NF + 2 * lmIdx[o.name];
          addEq([L], [1], o.x);          /* px = x (identity pose) */
          addEq([L + 1], [1], o.y);
        });
      } else if (freeIdx[s.id] != null) {
        var base = 4 * freeIdx[s.id];
        s.use.forEach(function (o) {
          var L = 4 * NF + 2 * lmIdx[o.name];
          /* a·x − b·y + tx − px = 0 ; b·x + a·y + ty − py = 0 */
          addEq([base, base + 1, base + 2, L], [o.x, -o.y, 1, -1], 0);
          addEq([base, base + 1, base + 3, L + 1], [o.y, o.x, 1, -1], 0);
        });
      }
    });
    var sol = solveLinear(A, b);
    if (!sol) return null;

    var poses = {};
    stations.forEach(function (s) {
      if (s.fixed) { poses[s.id] = { theta: 0, tx: 0, ty: 0, scaleLin: 1, fixed: true }; return; }
      var fi = freeIdx[s.id];
      if (fi == null) return;
      var a2 = sol[4 * fi], b2 = sol[4 * fi + 1];
      poses[s.id] = {
        theta: Math.atan2(b2, a2),
        tx: sol[4 * fi + 2], ty: sol[4 * fi + 3],
        scaleLin: Math.hypot(a2, b2)
      };
    });
    var lms = {};
    names.forEach(function (nm) {
      var L = 4 * NF + 2 * lmIdx[nm];
      lms[nm] = { x: sol[L], y: sol[L + 1] };
    });

    /* Tighten to rigid: landmarks from means, poses from rigid2D, thrice. */
    var xf = function (P, o) {
      var c = Math.cos(P.theta), s2 = Math.sin(P.theta);
      return { x: c * o.x - s2 * o.y + P.tx, y: s2 * o.x + c * o.y + P.ty };
    };
    for (var sweep = 0; sweep < 3; sweep++) {
      names.forEach(function (nm) {
        var sx = 0, sy = 0, n2 = 0;
        stations.forEach(function (s) {
          var P = poses[s.id]; if (!P) return;
          s.use.forEach(function (o) {
            if (o.name !== nm) return;
            var q = xf(P, o); sx += q.x; sy += q.y; n2++;
          });
        });
        if (n2) lms[nm] = { x: sx / n2, y: sy / n2 };
      });
      free.forEach(function (s) {
        var src = [], dst = [];
        s.use.forEach(function (o) {
          src.push({ x: o.x, y: o.y });
          dst.push(lms[o.name]);
        });
        var fit = rigid2D(src, dst);
        if (fit) poses[s.id] = { theta: fit.theta, tx: fit.tx, ty: fit.ty, scaleLin: poses[s.id].scaleLin };
      });
    }

    /* residuals */
    var total = 0, nObs = 0, worst = null;
    names.forEach(function (nm) {
      var seen = [];
      stations.forEach(function (s) {
        var P = poses[s.id]; if (!P) return;
        s.use.forEach(function (o) { if (o.name === nm) seen.push(xf(P, o)); });
      });
      if (seen.length < 2) return;
      var mx = 0, my = 0;
      seen.forEach(function (q) { mx += q.x / seen.length; my += q.y / seen.length; });
      var spread = 0;
      seen.forEach(function (q) { spread = Math.max(spread, Math.hypot(q.x - mx, q.y - my)); });
      lms[nm] = { x: mx, y: my, spread: spread, n: seen.length };
      seen.forEach(function (q) { total += (q.x - mx) * (q.x - mx) + (q.y - my) * (q.y - my); nObs++; });
      if (!worst || spread > worst.spread) worst = { name: nm, spread: spread };
    });

    return {
      poses: poses, landmarks: lms,
      rms: nObs ? Math.sqrt(total / nObs) : 0,
      worst: worst, nLandmarks: names.length, nStations: NF
    };
  }

  /* The best scalar channel for a given ball: the straight line in RGB space
     from "outside the circle" to "inside it".

     Luminance is one fixed projection and the field carries balls it is nearly
     blind to — a dark-yellow ball on grey membrane has almost no luminance
     contrast and a lot of colour contrast. Projecting every pixel onto the
     inside-outside axis is within a whisker of optimal for ANY ball colour, is
     computed per ball from the pixels themselves (no colour picker), and costs
     one dot product per pixel. Null when there is nothing to project onto —
     grey on grey, where luminance was already the best available try. */
  function colorAxis(innerSamples, outerSamples) {
    if (!innerSamples || !outerSamples || innerSamples.length < 4 || outerSamples.length < 4) return null;
    var med = function (arr, ch) {
      var v = [];
      for (var i = 0; i < arr.length; i++) v.push(arr[i][ch]);
      v.sort(function (a, b) { return a - b; });
      return v[Math.floor(v.length / 2)];
    };
    var w = [med(innerSamples, 0) - med(outerSamples, 0),
      med(innerSamples, 1) - med(outerSamples, 1),
      med(innerSamples, 2) - med(outerSamples, 2)];
    var m = Math.hypot(w[0], w[1], w[2]);
    if (m < 6) return null;
    return { w: [w[0] / m, w[1] / m, w[2] / m], sep: m };
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

  /* Refine a corner to sub-pixel, the way a fiducial detector would.

     bestCorner picks the right PIXEL; this finds where inside it the corner
     actually is. The idea is one line of geometry: at a true corner, the image
     gradient at every nearby pixel is perpendicular to the vector pointing back
     at the corner. So every pixel votes with grad.(q - p) = 0, and the
     least-squares solution of all those votes is the corner.

     This is what makes printed markers accurate — not the pattern, but that their
     edges are hard, straight and high-contrast, so the votes agree. It works just
     as well on a kerb edge, and it takes tap error from around 3 px to a fraction
     of one. */
  function refineCorner(gray, w, h, x0, y0, win, iters) {
    win = win || 5;
    iters = iters || 8;
    var px = x0, py = y0;
    var sigma2 = 2 * (win * 0.5) * (win * 0.5);

    for (var it = 0; it < iters; it++) {
      var cx = Math.round(px), cy = Math.round(py);
      var a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;

      for (var dy = -win; dy <= win; dy++) {
        for (var dx = -win; dx <= win; dx++) {
          var X = cx + dx, Y = cy + dy;
          if (X < 1 || Y < 1 || X >= w - 1 || Y >= h - 1) continue;
          var i = Y * w + X;
          var gx = (gray[i + 1] - gray[i - 1]) * 0.5;
          var gy = (gray[i + w] - gray[i - w]) * 0.5;
          var wt = Math.exp(-(dx * dx + dy * dy) / sigma2);
          var gxx = gx * gx * wt, gxy = gx * gy * wt, gyy = gy * gy * wt;
          a11 += gxx; a12 += gxy; a22 += gyy;
          b1 += gxx * X + gxy * Y;
          b2 += gxy * X + gyy * Y;
        }
      }

      var det = a11 * a22 - a12 * a12;
      if (Math.abs(det) < 1e-9) break;          /* an edge, not a corner */
      var nx = (a22 * b1 - a12 * b2) / det;
      var ny = (a11 * b2 - a12 * b1) / det;
      if (!isFinite(nx) || !isFinite(ny)) break;
      /* A solution that leaves the window is the fit diverging, not a discovery. */
      if (Math.hypot(nx - x0, ny - y0) > win + 1) break;

      var moved = Math.hypot(nx - px, ny - py);
      px = nx; py = ny;
      if (moved < 0.01) break;
    }
    return { x: px, y: py, moved: Math.hypot(px - x0, py - y0) };
  }

  /* Lock a user-seeded circle onto a ball's rim.

     This is deliberately refinement, not detection: the user says WHERE the ball
     is and roughly how big, and the pixels say exactly. Auto-detecting circles on
     a roof invites every drain, bolt head and membrane blister to volunteer;
     refining a circle someone placed cannot invent geometry, only sharpen it —
     the same argument that put corner snapping in and kept rectangle detection
     out.

     Method: walk outward along N spokes from the seeded centre, take the
     strongest radial gradient on each (sub-stepped by a parabola), fit a circle
     to the hits, reject outliers once, refit. The HORIZONTAL extremes are then
     re-probed from the refined centre and reported separately, because they are
     the two points the distance solve should use: a sphere's silhouette is
     radially elongated off-axis and its bottom edge is where the contact shadow
     lives, so the left-right chord is both the geometrically right measure and
     the cleanest one. */
  function refineCircleEdge(gray, w, h, cx0, cy0, r0) {
    if (!gray || !(r0 > 4) || w < 16 || h < 16) return null;

    var bil = function (x, y) {
      if (x < 0) x = 0; if (y < 0) y = 0;
      if (x > w - 1.001) x = w - 1.001;
      if (y > h - 1.001) y = h - 1.001;
      var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      var i = yi * w + xi;
      return gray[i] * (1 - fx) * (1 - fy) + gray[i + 1] * fx * (1 - fy) +
        gray[i + w] * (1 - fx) * fy + gray[i + w + 1] * fx * fy;
    };

    /* Where does this spoke cross from ball-coloured to background-coloured?

       Chasing the strongest gradient was the first design and the field killed
       it: on carpet, the strongest gradient along a spoke is a carpet fibre, and
       the ball's own rim — soft with defocus and bloom — loses the contest. So
       instead: measure what the inside and the outside actually look like, and
       find the FIRST sustained crossing of their midpoint walking outward. A
       dimple never crosses the midpoint; a fibre beyond the rim is never reached,
       because the walk stops at the first crossing. */
    var innerOuter = function (cx, cy, rc) {
      var inn = [], out = [];
      for (var i3 = 0; i3 < 24; i3++) {
        var a3 = i3 / 24 * 2 * Math.PI, c3 = Math.cos(a3), s3 = Math.sin(a3);
        inn.push(bil(cx + c3 * rc * 0.20, cy + s3 * rc * 0.20));
        inn.push(bil(cx + c3 * rc * 0.42, cy + s3 * rc * 0.42));
        out.push(bil(cx + c3 * rc * 1.32, cy + s3 * rc * 1.32));
        out.push(bil(cx + c3 * rc * 1.55, cy + s3 * rc * 1.55));
      }
      inn.sort(function (a4, b4) { return a4 - b4; });
      out.sort(function (a4, b4) { return a4 - b4; });
      return { inner: inn[Math.floor(inn.length / 2)], outer: out[Math.floor(out.length / 2)] };
    };

    var model = null;   /* set per pass */

    var edgeAlong = function (cx, cy, ang, rc) {
      if (!model) return null;
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var lo = 0.45 * rc, hi = 1.60 * rc, step = 0.5;
      var mid = (model.inner + model.outer) / 2;
      var sign = model.outer > model.inner ? 1 : -1;   /* which side of mid is "outside" */
      var wasInside = false, prevV = null, prevR = null;
      for (var r = lo; r <= hi; r += step) {
        var v = bil(cx + ca * r, cy + sa * r);
        var inside = sign * (v - mid) < 0;
        if (inside) wasInside = true;
        else if (wasInside && prevV != null) {
          /* confirm it stays outside for one more step — a single noisy sample
             must not read as the rim */
          var v2 = bil(cx + ca * (r + step), cy + sa * (r + step));
          if (sign * (v2 - mid) >= 0) {
            var f = (mid - prevV) / (v - prevV);
            if (!isFinite(f) || f < 0) f = 0; if (f > 1) f = 1;
            return { r: prevR + f * step, g: Math.abs(model.outer - model.inner) };
          }
        }
        prevV = v; prevR = r;
      }
      return null;
    };

    var N = 48;

    /* Probe all spokes from a given centre, robust-fit the hits. A corrupted arc
       — the contact shadow — is rejected as outliers, but a fit seeded from an
       off-centre guess still inherits a small bias from asymmetric sampling, so
       the whole pass is run again from the refined centre, where the spokes are
       symmetric. Two passes settle it. */
    var collectAndFit = function (cx, cy, rc) {
      model = innerOuter(cx, cy, rc);
      /* No contrast, no ball. Refusing beats guessing. */
      if (Math.abs(model.inner - model.outer) < 20) return null;
      var pts = [];
      for (var i2 = 0; i2 < N; i2++) {
        var ang = i2 / N * 2 * Math.PI;
        var e = edgeAlong(cx, cy, ang, rc);
        if (e) pts.push({ x: cx + Math.cos(ang) * e.r, y: cy + Math.sin(ang) * e.r });
      }
      if (pts.length < N * 0.5) return null;
      var fit0 = fitCircle(pts);
      if (!fit0 || !(fit0.r > 3)) return null;
      var tol = Math.max(1.5, 0.06 * fit0.r);
      var keep = [];
      for (var j = 0; j < pts.length; j++) {
        if (Math.abs(Math.hypot(pts[j].x - fit0.cx, pts[j].y - fit0.cy) - fit0.r) < tol) keep.push(pts[j]);
      }
      if (keep.length >= 8) {
        var f2 = fitCircle(keep);
        if (f2 && f2.r > 3) fit0 = f2;
      }
      var rms0 = 0;
      for (j = 0; j < keep.length; j++) {
        var dr = Math.hypot(keep[j].x - fit0.cx, keep[j].y - fit0.cy) - fit0.r;
        rms0 += dr * dr;
      }
      return { cx: fit0.cx, cy: fit0.cy, r: fit0.r, n: keep.length,
        rms: keep.length ? Math.sqrt(rms0 / keep.length) : Infinity };
    };

    var fit = collectAndFit(cx0, cy0, r0);
    if (!fit) return null;
    var fitB = collectAndFit(fit.cx, fit.cy, fit.r);
    if (fitB) fit = fitB;
    /* The field caught a fit that reported success with 3 of 48 spokes in
       agreement — the fit stage demanded half the spokes find SOME edge, but
       never demanded they agree with the answer. A lock most spokes disagree
       with is not a lock. */
    if (fit.n < N * 0.45) return null;
    var rms = fit.rms;

    /* The measurement itself: left and right rim, probed from the refined centre. */
    var eL = edgeAlong(fit.cx, fit.cy, Math.PI, fit.r);
    var eR = edgeAlong(fit.cx, fit.cy, 0, fit.r);
    var xL = eL ? fit.cx - eL.r : fit.cx - fit.r;
    var xR = eR ? fit.cx + eR.r : fit.cx + fit.r;

    return {
      cx: fit.cx, cy: fit.cy, r: fit.r,
      rms: rms, n: fit.n,
      xL: xL, xR: xR, dh: xR - xL,
      horizRefined: !!(eL && eR)
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

  /* Lat/lon -> east/north metres about an origin, with no bearing involved.

     This is the frame an aerial gives you: already north-aligned, so a survey
     calibrated from map points needs no separate georeferencing step — the plan
     IS in map coordinates from the first tap. */
  function latLonToEastNorth(ll, origin) {
    var m = metresPerDeg(origin.lat);
    return { e: (ll.lon - origin.lon) * m.lon, n: (ll.lat - origin.lat) * m.lat };
  }

  /* Worst and RMS disagreement between a homography and a set of correspondences.
     With exactly four points a homography fits perfectly and says nothing about
     its own quality; a fifth point is the first honest check available. */
  function homographyResidual(H, src, dst) {
    var n = Math.min(src.length, dst.length);
    if (!H || n < 1) return null;
    var worst = 0, sum = 0, used = 0;
    for (var i = 0; i < n; i++) {
      var p = applyH(H, src[i]);
      if (!p) return null;
      var d = Math.hypot(p.x - dst[i].x, p.y - dst[i].y);
      if (d > worst) worst = d;
      sum += d * d; used++;
    }
    return { worst: worst, rms: Math.sqrt(sum / used), n: used };
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
    focalFromHomography: focalFromHomography, horizonLine: horizonLine,
    referenceQuality: referenceQuality, steppedReferenceError: steppedReferenceError,
    meanAngleMod90: meanAngleMod90, bestCorner: bestCorner, refineCorner: refineCorner,
    refineCircleEdge: refineCircleEdge,
    normalFromAttitude: normalFromAttitude, deckTiltDeg: deckTiltDeg, deckBasis: deckBasis,
    jacobianAtPixel: jacobianAtPixel, gsdAtPixel: gsdAtPixel, wForGsd: wForGsd,
    clipHalfPlane: clipHalfPlane, frameFootprint: frameFootprint,
    rotFromOrientation: rotFromOrientation, focalFromFov: focalFromFov,
    fovFromFocalLong: fovFromFocalLong,
    quatMul: quatMul, quatFromOrientation: quatFromOrientation, quatToMatrix: quatToMatrix,
    quatSlerp: quatSlerp, quatAngleDeg: quatAngleDeg,
    rayForPixel: rayForPixel, groundPoint: groundPoint, projectToPixel: projectToPixel,
    heightFromBaseTop: heightFromBaseTop, camHeightFromKnown: camHeightFromKnown,
    sphereCenterDev: sphereCenterDev, ballPlane: ballPlane, colorAxis: colorAxis,
    homographyFromPoints: homographyFromPoints, hexCorners: hexCorners, signedArea: signedArea,
    fitPlanarByF: fitPlanarByF, hexTie: hexTie, fuseLens: fuseLens, fBracket: fBracket,
    rotFromARKit: rotFromARKit, arkitPose: arkitPose, fovFromIntrinsics: fovFromIntrinsics,
    planeCornersFromARKit: planeCornersFromARKit,
    hullSimplify: hullSimplify,
    gravityFromHorizon: gravityFromHorizon, orientationFromRot: orientationFromRot,
    rotAxisAngle: rotAxisAngle, alignToGravity: alignToGravity,
    principalAxis: principalAxis, adjust2D: adjust2D,
    layoverFactor: layoverFactor, reliefDisplacement: reliefDisplacement,
    maxSafeObjectHeight: maxSafeObjectHeight,
    bearingSensitivity: bearingSensitivity, positionSigma: positionSigma,
    maxTrustedRange: maxTrustedRange,
    hull: hull, fitOrientedRect: fitOrientedRect, rectCorners: rectCorners,
    fitCircle: fitCircle, circlePoly: circlePoly, polygonArea: polygonArea,
    rigid2D: rigid2D, applyRigid: applyRigid,
    similarity2D: similarity2D, applySimilarityInverse: applySimilarityInverse,
    metresPerDeg: metresPerDeg, localToLatLon: localToLatLon, latLonToLocal: latLonToLocal,
    latLonToEastNorth: latLonToEastNorth, homographyResidual: homographyResidual,
    anchorFromTwoPoints: anchorFromTwoPoints,
    buildKML: buildKML, fmtName: fmtName, xmlEsc: xmlEsc,
    planToEastNorth: planToEastNorth, eastNorthBox: eastNorthBox,
    buildGroundOverlayKML: buildGroundOverlayKML, groundOverlayFragment: groundOverlayFragment,
    fmtLen: fmtLen, fmtArea: fmtArea, toM: toM, fromM: fromM
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EE;
