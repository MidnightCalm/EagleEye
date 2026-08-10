/* Eagle Eye — roof survey PWA.

   Photos and device attitude in, a metric plan and a HelioScope-ready KML out.
   The geometry lives in geo.js; this file is state, screens and interaction.

   Deliberately no LiDAR: the iPhone's depth sensor is a 940 nm emitter that a
   bright roof washes out, and its useful range stops well short of the far side
   of a warehouse. Photographs plus a known reference survive full sun. */
'use strict';

var VERSION = '1.3.0';
var KEY = 'eagleeye.v1';

/* ================= persistence ================= */

/* Photos go to IndexedDB and everything else to localStorage. A 1440 px JPEG is
   a few hundred KB, base64 inflates it by a third, and localStorage gives up
   somewhere around 5 MB — a survey would hit the wall at roughly ten stations. */
var IDB = (function () {
  var dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('eagleeye', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('photos'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    }).catch(function () { return null; });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      if (!db) return null;
      return new Promise(function (res, rej) {
        var t = db.transaction('photos', mode);
        var rq = fn(t.objectStore('photos'));
        t.oncomplete = function () { res(rq ? rq.result : null); };
        t.onerror = function () { rej(t.error); };
      }).catch(function () { return null; });
    });
  }
  return {
    put: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }); },
    get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
    del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }); },
    keys: function () { return tx('readonly', function (s) { return s.getAllKeys(); }); },
    sizes: function () { return tx('readonly', function (s) { return s.getAll(); }); }
  };
})();

var DEFAULTS = {
  unit: 'm',
  fov: 68,                     /* deg across the long edge — iPhone main camera */
  camH: 1.55,                  /* phone held at chest height, metres above the roof */
  nameTemplate: '{name} h={h}{u}',
  nameUnit: 'm',
  circleSegments: 24,
  maxPx: 1440,
  jpegQ: 0.72,

  /* The survey's declared error model. These three numbers decide the trusted
     radius of every standpoint, and therefore where coverage is green. */
  labelLift: 1.0,      /* metres a floating name hangs above its object */
  tolerance: 0.25,     /* metres of position error the survey will accept */
  attSigma: 0.5,       /* degrees of attitude error assumed, 1-sigma */
  deckUnc: 0.08,       /* metres the deck may depart from the assumed plane */
  coverageCell: 0.5    /* metres per coverage grid cell */
};

function load() {
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.projects)) {
        d.settings = Object.assign({}, DEFAULTS, d.settings || {});
        return d;
      }
    }
  } catch (e) { /* corrupted — start fresh */ }
  return { projects: [], settings: Object.assign({}, DEFAULTS) };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Storage full — export a backup'); }
}
function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

var db = load();

/* ================= ephemeral state ================= */
var view = { screen: 'home', projectId: null, tab: 'plan' };
var ui = {
  cap: null,            /* live camera session */
  trace: null,          /* trace session */
  sheet: null,          /* modal sheet descriptor */
  toastTimer: null,
  sel: null,            /* selected object id, plan tab */
  plan: { s: 12, ox: 0, oy: 0, fitted: false },
  scene: { yaw: 0.6, elev: 0.62 },
  imgCache: {},         /* stationId -> HTMLImageElement */
  urlCache: {},         /* stationId -> object URL, for thumbnails */
  sensors: { alpha: 0, beta: 90, gamma: 0, heading: null, headingAcc: null, live: false, denied: false },
  gps: null,
  gpsWatch: null,
  storageBytes: null
};

/* ================= helpers ================= */
var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
var esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
var U = function () { return db.settings.unit; };
var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };

/* Signed to one decimal, without the "-0.0" that a tiny negative rounds to —
   a scale check reading -0.0% looks like a fault when it is a perfect result. */
function fmtSigned(v) {
  var s = v.toFixed(1);
  if (s === '-0.0' || s === '0.0') return '0.0';
  return (v > 0 ? '+' : '') + s;
}

function toast(msg) {
  var old = $('.toast'); if (old) old.remove();
  clearTimeout(ui.toastTimer);
  var el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  ui.toastTimer = setTimeout(function () { if (el.parentNode) el.remove(); }, 2600);
}

function currentProject() { return db.projects.find(function (p) { return p.id === view.projectId; }); }
function findStation(p, id) { return p ? p.stations.find(function (s) { return s.id === id; }) : null; }
function touchProject(p) { if (p) p.updatedAt = Date.now(); }

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return (window.orientation + 360) % 360;
  return 0;
}

/* ================= station frames =================
   Objects are stored in their own station's local frame and transformed on read.
   Storing project-frame coordinates instead would be simpler until the first
   re-registration, at which point every object captured from that station would
   be stranded in the wrong place. */

function stationXform(st) {
  return (st && st.reg) ? st.reg : null;
}
function toProj(st, p) {
  var t = stationXform(st);
  return t ? EE.applyRigid(t, p) : p;
}
function fromProj(st, p) {
  var t = stationXform(st);
  if (!t) return p;
  var c = Math.cos(-t.theta), s = Math.sin(-t.theta);
  var x = p.x - t.tx, y = p.y - t.ty;
  return { x: c * x - s * y, y: s * x + c * y };
}

/* An object with its coordinates lifted into the project frame. */
function projObj(p, o) {
  var st = findStation(p, o.stationId);
  var t = stationXform(st);
  if (!t) return null;                       /* station not yet placed */
  var out = Object.assign({}, o);
  if (o.kind === 'rect') {
    var c = EE.applyRigid(t, { x: o.cx, y: o.cy });
    out.cx = c.x; out.cy = c.y; out.rot = o.rot + t.theta;
  } else if (o.kind === 'cylinder') {
    var d = EE.applyRigid(t, { x: o.cx, y: o.cy });
    out.cx = d.x; out.cy = d.y;
  } else {
    out.pts = (o.pts || []).map(function (q) { return EE.applyRigid(t, q); });
  }
  return out;
}
function placedObjects(p) {
  if (!p) return [];
  return p.objects.map(function (o) { return projObj(p, o); }).filter(Boolean);
}
function objectsOf(p, stationId) {
  return p.objects.filter(function (o) { return o.stationId === stationId; });
}

/* Named landmark points, in the project frame, from every placed station. */
function tiePoints(p, excludeStationId) {
  var out = [];
  p.objects.forEach(function (o) {
    if (o.kind !== 'point' || !o.name || o.stationId === excludeStationId) return;
    var po = projObj(p, o);
    if (po && po.pts && po.pts[0]) out.push({ name: o.name.trim().toLowerCase(), pt: po.pts[0], label: o.name });
  });
  return out;
}

/* Places a station by matching its named points against points already in the
   project frame. Two matches give an exact fit; more give a residual, which is
   the only honest accuracy number the app can offer. */
function tryRegister(p, st) {
  if (!st || st.reg) return null;
  var known = tiePoints(p, st.id);
  if (!known.length) return null;
  var mine = objectsOf(p, st.id).filter(function (o) { return o.kind === 'point' && o.name; });

  var src = [], dst = [], names = [];
  mine.forEach(function (o) {
    var k = known.find(function (t) { return t.name === o.name.trim().toLowerCase(); });
    if (k && o.pts && o.pts[0]) { src.push(o.pts[0]); dst.push(k.pt); names.push(o.name); }
  });
  if (src.length < 2) return null;

  var t = EE.rigid2D(src, dst);
  if (!t) return null;
  t.method = 'tie'; t.names = names;
  st.reg = t;
  return t;
}

function ensureOrigin(p) {
  /* The first station defines the project frame. */
  if (!p.stations.length) return;
  var placed = p.stations.some(function (s) { return !!s.reg; });
  if (!placed) p.stations[0].reg = { theta: 0, tx: 0, ty: 0, rms: 0, n: 0, method: 'origin' };
}

/* ================= calibration ================= */

/* One interface over the two mapping engines, so every caller — the grid
   overlay, the tap handler, the shape painter — is written once. */
function calMap(st) {
  var c = st && st.cal;
  if (!c || !c.ok) return null;
  var R = st.att ? EE.rotFromOrientation(st.att.alpha, st.att.beta, st.att.gamma) : null;

  if (c.mode === 'quad') {
    var Hi = EE.invert3(c.H);
    return {
      mode: 'quad',
      has3D: !!(R && c.camH),
      /* The horizon test lives in applyH, so there is exactly one of it. */
      toGround: function (px, py) { return EE.applyH(c.H, { x: px, y: py }); },
      toImg: function (g) { return Hi ? EE.applyH(Hi, g) : null; },
      /* Height still needs a 3D pose, which the homography alone does not carry.
         camH was solved against the same reference quad at calibration time. */
      heightAt: function (basePt, topPx, topPy) {
        if (!R || !c.pose) return null;
        var ray = EE.rayForPixel(topPx, topPy, st.imgW, st.imgH, c.f, st.screenAngle);
        /* heightFromBaseTop works in the ray frame, whose origin sits under the
           camera; basePt arrives in the reference-rectangle frame.

           The pose was fitted against ray points evaluated at a nominal 1 m, so
           its inverse lands back in that unit-height frame. Multiplying by the
           pose scale — which is the camera height — restores true metres, which
           is the frame the camera height passed alongside it refers to. */
        var inv = EE.applySimilarityInverse(c.pose, basePt);
        var b = { x: inv.x * c.pose.scale, y: inv.y * c.pose.scale };
        return EE.heightFromBaseTop(b, ray, R, c.pose.scale);
      }
    };
  }

  if (!R) return null;
  return {
    mode: 'ray',
    has3D: true,
    toGround: function (px, py, planeZ) {
      return EE.groundPoint(EE.rayForPixel(px, py, st.imgW, st.imgH, c.f, st.screenAngle), R, c.camH, planeZ || 0);
    },
    toImg: function (g, planeZ) {
      return EE.projectToPixel(g, R, c.camH, st.imgW, st.imgH, c.f, st.screenAngle, planeZ || 0);
    },
    heightAt: function (basePt, topPx, topPy) {
      var ray = EE.rayForPixel(topPx, topPy, st.imgW, st.imgH, c.f, st.screenAngle);
      return EE.heightFromBaseTop(basePt, ray, R, c.camH);
    }
  };
}

/* Solves a quad calibration and, where attitude is available, recovers the
   camera pose alongside it so the height tool keeps working.

   The pose comes from fitting the ray model (evaluated at a nominal 1 m) onto
   the same four reference corners: the similarity scale of that fit IS the
   camera height, and its residual says whether the tilt can be trusted. */
function calibrateQuad(st, quadPix, refW, refL) {
  var ref = EE.rectRefCorners(refW, refL);
  var H = EE.homographyFromQuad(quadPix, ref);
  if (!H) return { ok: false, err: 'Those four points do not form a usable quad — retake them further apart.' };

  var cal = { mode: 'quad', H: H, quadPix: quadPix, refW: refW, refL: refL, f: EE.focalFromFov(db.settings.fov, Math.max(st.imgW, st.imgH)), ok: true };

  if (st.att) {
    var R = EE.rotFromOrientation(st.att.alpha, st.att.beta, st.att.gamma);
    var unit = quadPix.map(function (q) {
      return EE.groundPoint(EE.rayForPixel(q.x, q.y, st.imgW, st.imgH, cal.f, st.screenAngle), R, 1, 0);
    });
    if (unit.every(Boolean)) {
      /* Scale must be free here: it IS the camera height. */
      var fit = EE.similarity2D(unit, ref);
      if (fit && fit.scale > 0.2 && fit.scale < 30) {
        cal.pose = fit;
        cal.camH = fit.scale;
        cal.poseRms = fit.rms;               /* already metres, dst being metres */
      }
    }
  }
  return cal;
}

/* Golden-section search for the focal length that makes the ray model agree with
   a measured reference rectangle. Turns any quad calibration into a lens
   calibration, which is what makes the quick tilt-and-height mode trustworthy
   afterwards. */
function solveFocal(st, quadPix, refW, refL) {
  if (!st.att) return null;
  var R = EE.rotFromOrientation(st.att.alpha, st.att.beta, st.att.gamma);
  var ref = EE.rectRefCorners(refW, refL);
  var longPx = Math.max(st.imgW, st.imgH);

  var cost = function (fovDeg) {
    var f = EE.focalFromFov(fovDeg, longPx);
    var g = quadPix.map(function (q) {
      return EE.groundPoint(EE.rayForPixel(q.x, q.y, st.imgW, st.imgH, f, st.screenAngle), R, 1, 0);
    });
    if (!g.every(Boolean)) return Infinity;
    /* The unit-height ray points differ from the reference by exactly the camera
       height, so scale has to float or the residual measures that gap instead of
       the lens error the search is trying to null out. */
    var fit = EE.similarity2D(g, ref);
    if (!fit || !(fit.scale > 0)) return Infinity;
    return fit.rms;                          /* metres of disagreement */
  };

  var lo = 35, hi = 115, gr = (Math.sqrt(5) - 1) / 2;
  var a = hi - gr * (hi - lo), b = lo + gr * (hi - lo);
  var fa = cost(a), fb = cost(b);
  for (var i = 0; i < 60 && hi - lo > 1e-4; i++) {
    if (fa < fb) { hi = b; b = a; fb = fa; a = hi - gr * (hi - lo); fa = cost(a); }
    else { lo = a; a = b; fa = fb; b = lo + gr * (hi - lo); fb = cost(b); }
  }
  var fov = (lo + hi) / 2, rms = cost(fov);
  if (!isFinite(rms) || fov < 36 || fov > 114) return null;
  return { fov: fov, rms: rms };
}

/* ================= coverage =================

   What has actually been seen well enough to trust, and what has not.

   Coloured by POSITION error, never by ground sampling distance. GSD says how
   sharp a pixel is; it says nothing about where the thing in it is, and the two
   diverge quadratically with range — a cell 20 m out can resolve to 2 cm and
   still sit 2.3 m from where it is drawn. Colouring by sharpness would paint that
   cell green.

   Green here means "seen at adequate geometry", NOT "measured". An area can be
   fully green and contain nothing traced at all; that is what the checklist is
   for. */

var attSigmaRad = function () { return db.settings.attSigma * Math.PI / 180; };
function trustedRadius() {
  return EE.maxTrustedRange(db.settings.camH, attSigmaRad(), db.settings.tolerance, db.settings.deckUnc);
}

/* The ground-plane homography for a station, whichever way it was calibrated. */
function stationH(st) {
  var c = st && st.cal;
  if (!c || !c.ok) return null;
  if (c.mode === 'quad') return c.H;
  if (!st.att) return null;
  var R = EE.rotFromOrientation(st.att.alpha, st.att.beta, st.att.gamma);
  return EE.homographyFromPose(R, c.camH, c.f, st.imgW, st.imgH, st.screenAngle);
}

/* Where the camera stood, in that station's own frame.

   Ray mode puts it at the origin by construction. A quad calibration measures
   everything relative to the tapped rectangle instead, so the camera sits
   wherever the recovered pose says — which is only known when attitude was
   recorded alongside. */
function stationCameraLocal(st) {
  var c = st && st.cal;
  if (!c || !c.ok) return null;
  if (c.mode === 'ray') return { x: 0, y: 0 };
  return c.pose ? { x: c.pose.tx, y: c.pose.ty } : null;
}
function stationCamera(p, st) {
  var l = stationCameraLocal(st);
  var t = stationXform(st);
  return (l && t) ? EE.applyRigid(t, l) : null;
}

/* Successive half-planes tangent to a circle — an inscribed polygon, so the clip
   is slightly conservative rather than slightly generous. */
function clipToCircle(poly, cx, cy, r, n) {
  var out = poly;
  for (var i = 0; i < n && out.length >= 3; i++) {
    var a = (i / n) * Math.PI * 2;
    var nx = Math.cos(a), ny = Math.sin(a);
    out = EE.clipHalfPlane(out, -nx, -ny, nx * cx + ny * cy + r);
  }
  return out;
}

/* The patch of roof a station can be trusted for, in the project frame.
   Bounded by the trusted radius rather than by resolution: sharpness runs out
   long after position accuracy does. */
function stationFootprint(p, st) {
  var H = stationH(st);
  var cam = stationCameraLocal(st);
  var t = stationXform(st);
  if (!H || !cam || !t) return null;

  /* A generous resolution cap first, only to bound the polygon near the horizon. */
  var fp = EE.frameFootprint(H, st.imgW, st.imgH, 0.25);
  if (!fp) return null;

  var poly = clipToCircle(fp.ground, cam.x, cam.y, Math.max(0.5, trustedRadius()), 24);
  if (poly.length < 3) return null;
  return poly.map(function (q) { return EE.applyRigid(t, q); });
}

function convexContains(poly, x, y) {
  var pos = false, neg = false;
  for (var i = 0, n = poly.length; i < n; i++) {
    var a = poly[i], b = poly[(i + 1) % n];
    var cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cr > 1e-12) pos = true;
    else if (cr < -1e-12) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

/* Rasterises the best position error achieved at every cell.
   Cached against the project's edit stamp and the error settings, because it is
   recomputed on every plan repaint otherwise. */
var coverageCache = { key: null, val: null };

function coverageKey(p) {
  var s = db.settings;
  return [p.id, p.updatedAt, p.stations.length, s.tolerance, s.attSigma, s.deckUnc,
    s.coverageCell, s.camH].join('|');
}

function computeCoverage(p) {
  var key = coverageKey(p);
  if (coverageCache.key === key) return coverageCache.val;

  var shots = [];
  p.stations.forEach(function (st) {
    var poly = stationFootprint(p, st);
    var cam = stationCamera(p, st);
    var c = st.cal;
    if (poly && cam && c && c.camH) shots.push({ poly: poly, cam: cam, camH: c.camH });
  });

  var val = null;
  if (shots.length) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    shots.forEach(function (s) {
      s.poly.forEach(function (q) {
        if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
      });
    });

    var cell = Math.max(0.15, db.settings.coverageCell);
    var cols = Math.min(600, Math.ceil((maxX - minX) / cell) + 1);
    var rows = Math.min(600, Math.ceil((maxY - minY) / cell) + 1);
    var data = new Float32Array(cols * rows);
    for (var i = 0; i < data.length; i++) data[i] = Infinity;

    var sig = attSigmaRad(), deck = db.settings.deckUnc;
    shots.forEach(function (s) {
      var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      s.poly.forEach(function (q) {
        if (q.x < bx0) bx0 = q.x; if (q.x > bx1) bx1 = q.x;
        if (q.y < by0) by0 = q.y; if (q.y > by1) by1 = q.y;
      });
      var c0 = Math.max(0, Math.floor((bx0 - minX) / cell));
      var c1 = Math.min(cols - 1, Math.ceil((bx1 - minX) / cell));
      var r0 = Math.max(0, Math.floor((by0 - minY) / cell));
      var r1 = Math.min(rows - 1, Math.ceil((by1 - minY) / cell));

      for (var r = r0; r <= r1; r++) {
        var wy = minY + (r + 0.5) * cell;
        for (var c = c0; c <= c1; c++) {
          var wx = minX + (c + 0.5) * cell;
          if (!convexContains(s.poly, wx, wy)) continue;
          var d = Math.hypot(wx - s.cam.x, wy - s.cam.y);
          var e = EE.positionSigma(s.camH, d, sig, deck);
          var idx = r * cols + c;
          if (e < data[idx]) data[idx] = e;
        }
      }
    });
    val = { minX: minX, minY: minY, cell: cell, cols: cols, rows: rows, data: data };
  }

  coverageCache = { key: key, val: val };
  return val;
}

/* Coverage as an image, so the plan paints one drawImage rather than tens of
   thousands of rectangles. */
var coverageImgCache = { key: null, canvas: null };
function coverageCanvas(p) {
  var cov = computeCoverage(p);
  if (!cov) return null;
  var key = coverageKey(p);
  if (coverageImgCache.key === key) return coverageImgCache.canvas;

  var cv = document.createElement('canvas');
  cv.width = cov.cols; cv.height = cov.rows;
  var g = cv.getContext('2d');
  var img = g.createImageData(cov.cols, cov.rows);
  var tol = db.settings.tolerance;

  for (var r = 0; r < cov.rows; r++) {
    for (var c = 0; c < cov.cols; c++) {
      var e = cov.data[r * cov.cols + c];
      /* Image rows run downward; plan +Y runs up. */
      var o = ((cov.rows - 1 - r) * cov.cols + c) * 4;
      if (!isFinite(e)) { img.data[o + 3] = 0; continue; }
      var col;
      if (e <= tol) col = [110, 210, 154];
      else if (e <= tol * 2) col = [212, 175, 55];
      else col = [201, 106, 94];
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2];
      img.data[o + 3] = 90;
    }
  }
  g.putImageData(img, 0, 0);
  coverageImgCache = { key: key, canvas: cv };
  return cv;
}

/* ================= completeness =================

   Coverage answers "did I look at it". This answers "can I leave the roof",
   which is a different and more useful question. */

function objectRange(p, o) {
  var st = findStation(p, o.stationId);
  var cam = stationCameraLocal(st);
  if (!cam) return null;
  var c = o.kind === 'rect' || o.kind === 'cylinder'
    ? { x: o.cx, y: o.cy }
    : ((o.pts && o.pts[0]) || null);
  if (!c) return null;
  return Math.hypot(c.x - cam.x, c.y - cam.y);
}

function buildChecklist(p) {
  var items = [];
  var add = function (sev, title, detail, act, id) {
    items.push({ sev: sev, title: title, detail: detail, act: act, id: id });
  };

  if (!p.stations.length) {
    add('block', 'No shots yet', 'Capture the first one and calibrate it against something you have measured.', 'capture');
    return items;
  }

  var uncal = p.stations.filter(function (s) { return !(s.cal && s.cal.ok); });
  if (uncal.length) add('block', uncal.length + (uncal.length === 1 ? ' shot not calibrated' : ' shots not calibrated'),
    'An uncalibrated shot contributes nothing — it has no scale.', 'station', uncal[0].id);

  var unplaced = p.stations.filter(function (s) { return !s.reg; });
  if (unplaced.length) add('block', unplaced.length + (unplaced.length === 1 ? ' shot not placed' : ' shots not placed'),
    'Mark two landmarks it shares with another shot, or place it by hand.', 'place', unplaced[0].id);

  var noH = p.objects.filter(function (o) {
    return (o.kind === 'rect' || o.kind === 'cylinder') && !(o.h > 0);
  });
  if (noH.length) add('block', noH.length + (noH.length === 1 ? ' object has no height' : ' objects have no height'),
    'HelioScope needs a height for every obstruction. Measure with the height tool or type it.', 'object', noH[0].id);

  var far = [];
  var tr = trustedRadius();
  p.objects.forEach(function (o) {
    if (o.kind === 'point') return;
    var d = objectRange(p, o);
    if (d != null && d > tr) far.push({ o: o, d: d });
  });
  if (far.length) {
    far.sort(function (a, b) { return b.d - a.d; });
    add('warn', far.length + (far.length === 1 ? ' object traced beyond the trusted radius' : ' objects traced beyond the trusted radius'),
      'Furthest is ' + esc(far[0].o.name || 'unnamed') + ' at ' + EE.fmtLen(far[0].d, U(), 1) +
      ', past ' + EE.fmtLen(tr, U(), 1) + '. Re-trace it from closer.', 'object', far[0].o.id);
  }

  if (!p.objects.some(function (o) { return o.kind === 'outline'; }))
    add('warn', 'No roof outline', 'Without one there is no area and no boundary in the export.', 'tab', 'plan');

  if (p.objects.filter(function (o) { return o.kind === 'point'; }).length < 2)
    add('warn', 'Fewer than two landmarks', 'Two are needed to place the survey on the map, and to tie shots together.', 'tab', 'plan');

  if (!p.anchor) add('warn', 'Survey not located', 'Pin two landmarks to their coordinates before exporting a KML.', 'geo');
  else if (p.anchorMeta && p.anchorMeta.scaleError != null && Math.abs(p.anchorMeta.scaleError) > 0.02)
    add('warn', 'Scale disagrees with the map by ' + fmtSigned(p.anchorMeta.scaleError * 100) + '%',
      'The survey and the aerial do not agree on distance. One of them is wrong.', 'geo');

  if (!p.scaleRef) add('warn', 'No scale reference recorded',
    'Every length in the survey rides on one measured distance. Record which one, and how it was measured.', 'scale');

  var cov = computeCoverage(p);
  var outline = p.objects.find(function (o) { return o.kind === 'outline'; });
  if (cov && outline && (outline.pts || []).length >= 3) {
    var po = projObj(p, outline);
    if (po) {
      var area = EE.polygonArea(po.pts), inside = 0, good = 0;
      var cell = cov.cell;
      for (var r = 0; r < cov.rows; r++) {
        for (var c = 0; c < cov.cols; c++) {
          var wx = cov.minX + (c + 0.5) * cell, wy = cov.minY + (r + 0.5) * cell;
          if (!pointInPolygon(po.pts, wx, wy)) continue;
          inside++;
          if (cov.data[r * cov.cols + c] <= db.settings.tolerance) good++;
        }
      }
      /* Cells inside the outline are only a sample of it, so compare counts
         rather than trusting the raster to reproduce the polygon's area. */
      var pct = inside ? Math.round(good / inside * 100) : 0;
      if (inside && pct < 95) {
        var missM2 = (inside - good) * cell * cell;
        add(pct < 60 ? 'warn' : 'info', pct + '% of the roof covered at tolerance',
          Math.round(missM2) + ' m² still outside ' + EE.fmtLen(db.settings.tolerance, U(), 2) +
          '. Stand in the gaps and shoot again.', 'tab', 'plan');
      } else if (inside) {
        add('ok', 'Roof fully covered at tolerance', 'Every part of the outline was seen at adequate geometry.', null);
      }
      if (area > 0 && !inside) add('info', 'Coverage does not reach the outline',
        'No shot footprint overlaps the traced roof.', 'tab', 'plan');
    }
  }

  if (!items.length) add('ok', 'Nothing outstanding', 'Every check passes. Export when ready.', 'tab', 'export');
  return items;
}

/* Even-odd ray crossing; the roof outline is not necessarily convex. */
function pointInPolygon(pts, x, y) {
  var inside = false;
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    var a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* ================= photos ================= */

function photoKey(id) { return 'p:' + id; }

function loadImage(st) {
  if (!st) return Promise.resolve(null);
  if (ui.imgCache[st.id]) return Promise.resolve(ui.imgCache[st.id]);
  return IDB.get(photoKey(st.id)).then(function (blob) {
    if (!blob) return null;
    return new Promise(function (res) {
      var url = URL.createObjectURL(blob);
      var im = new Image();
      im.onload = function () { ui.imgCache[st.id] = im; ui.urlCache[st.id] = url; res(im); };
      im.onerror = function () { URL.revokeObjectURL(url); res(null); };
      im.src = url;
    });
  });
}

function thumbUrl(st) {
  if (ui.urlCache[st.id]) return ui.urlCache[st.id];
  IDB.get(photoKey(st.id)).then(function (b) {
    if (!b) return;
    ui.urlCache[st.id] = URL.createObjectURL(b);
    var el = document.querySelector('[data-thumb="' + st.id + '"]');
    if (el) el.src = ui.urlCache[st.id];
  });
  return '';
}

function refreshStorage() {
  return IDB.sizes().then(function (all) {
    var n = 0;
    (all || []).forEach(function (b) { n += (b && b.size) || 0; });
    ui.storageBytes = n;
    return n;
  });
}
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/* ================= sensors ================= */

function needsMotionPermission() {
  return typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function' &&
    !ui.sensors.live;
}

function onOrientation(e) {
  if (e.alpha == null && e.beta == null && e.gamma == null) return;
  ui.sensors.live = true;
  ui.sensors.alpha = e.alpha || 0;
  ui.sensors.beta = e.beta == null ? 90 : e.beta;
  ui.sensors.gamma = e.gamma || 0;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    ui.sensors.heading = e.webkitCompassHeading;
    ui.sensors.headingAcc = e.webkitCompassAccuracy;
  } else if (e.absolute && e.alpha != null) {
    ui.sensors.heading = (360 - e.alpha) % 360;
  }
  if (ui.cap) paintCaptureHud();
  /* The HUD is driven by the orientation event rather than by rAF: iOS polls
     CoreMotion at 60 Hz, so there is nothing new to draw between samples. */
  if (ui.live) paintLive();
}

function startSensors() {
  var attach = function () {
    window.addEventListener('deviceorientation', onOrientation, true);
    /* iOS fires the absolute variant only under this name on some builds. */
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
  };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    return DeviceOrientationEvent.requestPermission().then(function (r) {
      if (r === 'granted') { attach(); return true; }
      ui.sensors.denied = true; return false;
    }).catch(function () { ui.sensors.denied = true; return false; });
  }
  attach();
  return Promise.resolve(true);
}

function startGps() {
  if (!navigator.geolocation || ui.gpsWatch != null) return;
  ui.gpsWatch = navigator.geolocation.watchPosition(function (pos) {
    ui.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
    if (ui.cap) paintCaptureHud();
  }, function () { }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
}
function stopGps() {
  if (ui.gpsWatch != null) { navigator.geolocation.clearWatch(ui.gpsWatch); ui.gpsWatch = null; }
}

/* ================= render ================= */

function render() {
  var app = $('#app');
  var full = view.screen === 'capture' || view.screen === 'trace' || view.screen === 'live';
  app.className = full ? 'wide' : '';

  var html = '';
  if (view.screen === 'home') html = tplHome();
  else if (view.screen === 'project') html = tplProject();
  else if (view.screen === 'capture') html = tplCapture();
  else if (view.screen === 'live') html = tplLive();
  else if (view.screen === 'trace') html = tplTrace();
  html += tplSheet();
  app.innerHTML = html;
  bind();
  paint();
}

/* ---------- home ---------- */
function tplHome() {
  var cards = db.projects.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })
    .map(function (p) {
      var objs = p.objects.filter(function (o) { return o.kind !== 'point'; }).length;
      var outline = p.objects.find(function (o) { return o.kind === 'outline'; });
      var area = outline ? EE.polygonArea(outline.pts || []) : 0;
      return '<div class="proj-card" data-open="' + p.id + '">' +
        '<span class="watermark">' + esc((p.name || '?').charAt(0)) + '</span>' +
        '<span class="pc-name">' + esc(p.name) + '</span>' +
        (p.address ? '<span class="pc-addr">' + esc(p.address) + '</span>' : '') +
        '<span class="pc-meta">' + p.stations.length + (p.stations.length === 1 ? ' SHOT · ' : ' SHOTS · ') +
        objs + (objs === 1 ? ' OBJECT' : ' OBJECTS') +
        (area ? ' · ' + EE.fmtArea(area, U()) : '') +
        (p.anchor ? ' · LOCATED' : '') + '</span>' +
        '</div>';
    }).join('');

  return '<div class="screen home">' +
    '<div class="wordmark-wrap">' +
    '<div class="wordmark">Eagle Eye<span class="ver">' + VERSION + '</span></div>' +
    '<div class="gold-rule"></div>' +
    '<div class="stats">' + db.projects.length + ' SURVEYS</div>' +
    '</div>' +
    '<div class="card-list">' + cards +
    '<div class="add-card" data-act="new-project">＋ New survey</div>' +
    '</div>' +
    (db.projects.length === 0 ? '<div class="empty-note">Welcome to Eagle Eye.<br>Start a survey, photograph the roof<br>against something you have measured,<br>and trace what is on it.</div>' : '') +
    '<div class="foot-spacer"></div>' +
    '</div>' +
    '<div class="bottom-bar">' +
    '<button class="big-btn ghost" data-act="settings">Settings</button>' +
    '<button class="fab gold" data-act="new-project">＋</button>' +
    '</div>';
}

/* ---------- project ---------- */
function tplProject() {
  var p = currentProject();
  if (!p) { view.screen = 'home'; return tplHome(); }

  var body = '';
  if (view.tab === 'plan') body = tplPlan(p);
  else if (view.tab === 'check') body = tplCheck(p);
  else if (view.tab === 'scene') body = tplScene(p);
  else if (view.tab === 'objects') body = tplObjects(p);
  else body = tplExport(p);

  var blockers = buildChecklist(p).filter(function (i) { return i.sev === 'block'; }).length;
  var tab = function (k, label, badge) {
    return '<button class="' + (view.tab === k ? 'active' : '') + '" data-tab="' + k + '">' + label +
      (badge ? '<i class="tb-badge">' + badge + '</i>' : '') + '</button>';
  };

  return '<div style="flex:0 0 auto;padding:calc(var(--safe-top) + 18px) 20px 12px">' +
    '<div class="head">' +
    '<button class="icon-btn" data-act="home">‹</button>' +
    '<div class="titles"><span class="title">' + esc(p.name) + '</span>' +
    '<span class="sub">' + esc(p.address || 'No address') + '</span></div>' +
    '<button class="icon-btn dots" data-act="project-menu">···</button>' +
    '</div></div>' +
    '<div class="tabbar">' + tab('plan', 'Plan') + tab('check', 'Check', blockers) +
    tab('scene', 'Scene') + tab('objects', 'List') + tab('export', 'Export') + '</div>' +
    body +
    '<div class="bottom-bar">' +
    '<button class="big-btn ghost" data-act="live"' + (p.stations.some(function (s) { return s.reg && s.cal && s.cal.ok; }) ? '' : ' disabled') + '>◈  Live</button>' +
    '<button class="big-btn" data-act="capture">◎  Capture</button>' +
    '</div>';
}

function tplPlan(p) {
  var unplaced = p.stations.filter(function (s) { return !s.reg; });
  return '<div class="stage" id="stage-plan">' +
    '<canvas id="plan-canvas"></canvas>' +
    '<div class="stage-top">' +
    (unplaced.length ? '<button class="pill" style="border-color:rgba(201,106,94,.6);color:var(--red-light)" data-act="place-station" data-id="' + unplaced[0].id + '">' +
      unplaced.length + ' shot' + (unplaced.length > 1 ? 's' : '') + ' unplaced — tap to place</button>' : '') +
    (ui.sel ? '<button class="pill gold" data-act="edit-object" data-id="' + ui.sel + '">Edit selected</button>' : '') +
    '</div>' +
    '<div class="stage-chrome">' +
    '<button class="pill" data-act="plan-fit">Fit</button>' +
    '<button class="pill' + (ui.showCoverage ? ' on' : '') + '" data-act="toggle-coverage">Coverage</button>' +
    '<button class="pill" data-act="toggle-unit">' + (U() === 'm' ? 'metres' : 'feet') + '</button>' +
    '<div style="flex:1"></div>' +
    '<button class="pill gold" data-act="geo-sheet">' + (p.anchor ? '◈ Located' : '◈ Locate') + '</button>' +
    '</div>' +
    (ui.showCoverage ? '<div class="cov-legend">' +
      '<span><i style="background:#6ED29A"></i>≤ ' + EE.fmtLen(db.settings.tolerance, U(), 2) + '</span>' +
      '<span><i style="background:#D4AF37"></i>≤ ' + EE.fmtLen(db.settings.tolerance * 2, U(), 2) + '</span>' +
      '<span><i style="background:#C96A5E"></i>worse</span>' +
      '<em>seen, not measured</em></div>' : '') +
    '</div>' +
    '<div style="flex:0 0 auto;padding:10px 20px calc(var(--safe-bottom) + 86px)">' +
    '<div class="stn-list">' + p.stations.map(function (s, i) {
      return '<div class="stn-chip' + (s.reg ? '' : ' unreg') + '" data-station="' + s.id + '">' +
        '<img class="thumb" data-thumb="' + s.id + '" src="' + esc(thumbUrl(s)) + '" alt="">' +
        '<div class="sl">' + (s.reg ? '' : '⚠ ') + 'SHOT ' + (i + 1) + '</div></div>';
    }).join('') +
    (p.stations.length ? '' : '<div class="hint" style="padding:14px 4px">No shots yet — tap <b>Capture</b>.</div>') +
    '</div></div>';
}

function tplCheck(p) {
  var items = buildChecklist(p);
  var glyph = { block: '●', warn: '▲', info: '·', ok: '✓' };
  var rows = items.map(function (it) {
    return '<div class="chk ' + it.sev + '"' + (it.act ? ' data-chk="' + it.act + '" data-chkid="' + esc(it.id || '') + '"' : '') + '>' +
      '<span class="cg">' + glyph[it.sev] + '</span>' +
      '<div class="cmain"><span class="ct">' + esc(it.title) + '</span>' +
      '<span class="cd">' + esc(it.detail) + '</span></div>' +
      (it.act ? '<span class="cx">›</span>' : '') +
      '</div>';
  }).join('');

  var tr = trustedRadius();
  var s = db.settings;
  return '<div class="screen" style="padding-top:14px">' +
    '<div class="panel"><span class="p-tag">TRUSTED RADIUS</span>' +
    '<div class="kv"><span>From where you stand</span><span>' + EE.fmtLen(tr, U(), 1) + '</span></div>' +
    '<div class="kv"><span>At tolerance</span><span>±' + EE.fmtLen(s.tolerance, U(), 2) + '</span></div>' +
    '<div class="kv"><span>Assumed tilt error</span><span>' + s.attSigma.toFixed(1) + '°</span></div>' +
    '<div class="p-body">Position error grows with the <b>square</b> of range: ' +
    EE.fmtLen(EE.positionSigma(s.camH, 5, attSigmaRad(), s.deckUnc), U(), 2) + ' at ' + EE.fmtLen(5, U(), 0) +
    ', ' + EE.fmtLen(EE.positionSigma(s.camH, 20, attSigmaRad(), s.deckUnc), U(), 2) + ' at ' + EE.fmtLen(20, U(), 0) +
    '. Standing closer beats every other improvement.</div>' +
    '<button class="btn ghost-gold sm" data-act="error-sheet">Error model</button></div>' +
    '<div class="chk-list">' + rows + '</div>' +
    '<div class="foot-spacer"></div></div>';
}

function tplScene(p) {
  return '<div class="stage" id="stage-scene">' +
    '<canvas id="scene-canvas"></canvas>' +
    '<div class="stage-chrome">' +
    '<button class="pill" data-act="scene-spin" data-d="-1">↺</button>' +
    '<button class="pill" data-act="scene-spin" data-d="1">↻</button>' +
    '<div style="flex:1"></div>' +
    '<span class="pill">drag to orbit</span>' +
    '</div></div>' +
    '<div style="flex:0 0 auto;padding:12px 20px calc(var(--safe-bottom) + 86px)">' +
    '<div class="hint">The simplified scene — every object reduced to the box or ' +
    'cylinder HelioScope understands, at the height you gave it.</div></div>';
}

function tplObjects(p) {
  var placed = placedObjects(p);
  var rows = p.objects.map(function (o) {
    var po = placed.find(function (q) { return q.id === o.id; });
    var glyph = o.kind === 'cylinder' ? '<div class="obj-glyph cyl">●</div>'
      : o.kind === 'outline' ? '<div class="obj-glyph out">⬡</div>'
        : o.kind === 'point' ? '<div class="obj-glyph pt">✛</div>'
          : '<div class="obj-glyph">▭</div>';
    var dims = '';
    if (o.kind === 'rect') dims = EE.fmtLen(o.w, U()) + ' × ' + EE.fmtLen(o.l, U()) + ' · ' + (o.rot * 180 / Math.PI).toFixed(0) + '°';
    else if (o.kind === 'cylinder') dims = 'Ø ' + EE.fmtLen(o.r * 2, U());
    else if (o.kind === 'outline') dims = (o.pts || []).length + ' pts · ' + EE.fmtArea(EE.polygonArea(o.pts || []), U());
    else dims = 'landmark';
    if (!po) dims += ' · unplaced';
    return '<div class="obj-row' + (ui.sel === o.id ? ' sel' : '') + '" data-object="' + o.id + '">' +
      glyph +
      '<div class="obj-main"><span class="obj-name">' + esc(o.name || '(unnamed)') + '</span>' +
      '<span class="obj-dims">' + dims + '</span></div>' +
      (o.kind === 'point' || o.kind === 'outline' ? '' : '<span class="obj-h">' + EE.fmtLen(o.h || 0, U(), U() === 'ft' ? 1 : 2) + '</span>') +
      '</div>';
  }).join('');

  return '<div class="screen" style="padding-top:14px">' +
    (p.objects.length ? '<div class="obj-list">' + rows + '</div>'
      : '<div class="empty-note">Nothing traced yet.<br>Capture a shot, calibrate it,<br>then trace what sits on the roof.</div>') +
    '<div class="foot-spacer"></div></div>';
}

function tplExport(p) {
  var s = db.settings;
  var sample = EE.fmtName(s.nameTemplate, 'RTU-1', 1.22, s.nameUnit);
  var obst = p.objects.filter(function (o) { return o.kind !== 'point'; });
  var placedCount = placedObjects(p).filter(function (o) { return o.kind !== 'point'; }).length;
  var anchorPanel;

  if (p.anchor) {
    var meta = p.anchorMeta || {};
    var se = meta.scaleError;
    anchorPanel = '<div class="panel good"><span class="p-tag">GEOREFERENCED</span>' +
      '<div class="kv"><span>Anchor</span><span>' + p.anchor.lat.toFixed(6) + ', ' + p.anchor.lon.toFixed(6) + '</span></div>' +
      '<div class="kv"><span>Plan-up bearing</span><span>' + p.anchor.bearing.toFixed(1) + '° true</span></div>' +
      '<div class="kv"><span>Method</span><span>' + esc(meta.method || 'manual') + '</span></div>' +
      (se != null ? '<div class="kv ' + (Math.abs(se) < 0.02 ? 'good' : 'warn') + '"><span>Scale check</span><span>' +
        fmtSigned(se * 100) + '%</span></div>' : '') +
      '<button class="btn ghost-gold sm" data-act="geo-sheet">Change location</button></div>';
  } else {
    anchorPanel = '<div class="panel warn"><span class="p-tag">NOT LOCATED</span>' +
      '<div class="p-body">A KML needs real coordinates. Pin two traced landmarks to ' +
      'their latitude and longitude — read them off an aerial — and the whole plan ' +
      'falls into place.</div>' +
      '<button class="btn primary sm" data-act="geo-sheet">Set location</button></div>';
  }

  return '<div class="screen" style="padding-top:14px">' +
    anchorPanel +
    '<div class="panel"><span class="p-tag">SHAPE NAMES</span>' +
    '<div class="p-body">HelioScope carries the name through, so the height rides along with it.</div>' +
    '<div class="field"><label>TEMPLATE</label>' +
    '<input class="inp mono" id="name-tpl" value="' + esc(s.nameTemplate) + '" autocomplete="off"></div>' +
    '<div class="seg tight"><button class="' + (s.nameUnit === 'm' ? 'active' : '') + '" data-nameunit="m">metres</button>' +
    '<button class="' + (s.nameUnit === 'ft' ? 'active' : '') + '" data-nameunit="ft">feet</button></div>' +
    '<div class="kv"><span>Preview</span><span>' + esc(sample) + '</span></div></div>' +

    '<div class="panel"><span class="p-tag">CONTENTS</span>' +
    '<div class="kv"><span>Obstructions</span><span>' + obst.length + '</span></div>' +
    '<div class="kv ' + (placedCount === obst.length ? '' : 'warn') + '"><span>Placed</span><span>' + placedCount + ' of ' + obst.length + '</span></div>' +
    '<div class="kv"><span>Circle segments</span><span>' + s.circleSegments + '</span></div>' +
    '<div class="kv"><span>Photos on device</span><span>' + fmtBytes(ui.storageBytes) + '</span></div></div>' +

    '<div class="panel"><span class="p-tag">FLOATING LABELS</span>' +
    '<div class="p-body">Names hang <b>above</b> each object on a tether instead of being ' +
    'painted on the deck, so they stay readable once modules are placed over them.</div>' +
    '<div class="field"><label>HEIGHT ABOVE THE OBJECT</label><div class="unit-suffix">' +
    '<input class="inp mono" id="lbl-lift" inputmode="decimal" value="' +
    EE.fromM(s.labelLift, U()).toFixed(2) + '"><span>' + U() + '</span></div></div>' +
    '<button class="btn ghost-gold sm" data-act="save-lift">Apply</button></div>' +

    '<div class="btn-row"><button class="btn primary" data-act="export-kmz"' + (p.anchor ? '' : ' disabled') + '>Export KMZ</button></div>' +
    '<div class="hint">One file, three layers: the flat <b>deck raster</b> to trace on, the ' +
    '<b>3D volumes</b> standing on it, and the <b>names floating</b> clear of both.<br>' +
    'Confirmed 2026-08-10 — KMZ and KML both land at true scale; a bare PNG carries no ' +
    'coordinates and lands unscaled.</div>' +
    '<div class="btn-row"><button class="btn ghost-gold" data-act="export-kml"' + (p.anchor ? '' : ' disabled') + '>Vector KML only</button></div>' +
    '<div class="btn-row">' +
    '<button class="btn ghost-gold" data-act="export-csv">Schedule CSV</button>' +
    '<button class="btn ghost" data-act="export-json">Backup JSON</button></div>' +
    '<div class="hint">The vector KML opens in Google Earth as solid blocks at their real heights — ' +
    'worth a look before anything goes near a layout.</div>' +
    '<div class="foot-spacer"></div></div>';
}

/* ---------- capture ---------- */
function tplCapture() {
  var c = ui.cap || {};
  var needPerm = needsMotionPermission();

  var foot;
  if (c.err) {
    foot = '<div class="panel warn"><span class="p-tag">CAMERA</span><div class="p-body">' + esc(c.err) + '</div></div>';
  } else if (needPerm) {
    foot = '<div class="panel gold"><span class="p-tag">TILT SENSOR</span>' +
      '<div class="p-body">iOS asks before an app may read the tilt. Without it you can still ' +
      'measure from a rectangle you have tape-measured, which is the more accurate route anyway.</div>' +
      '<button class="btn primary sm" data-act="ask-motion">Enable tilt sensor</button></div>' +
      '<div class="shutter-row"><button class="shutter" data-act="shoot"' + (c.ready ? '' : ' disabled') + '><div></div></button></div>';
  } else {
    foot = '<div class="att-grid">' + attCell('TILT', tiltDeg().toFixed(0) + '°', tiltClass()) +
      attCell('ROLL', (ui.sensors.gamma || 0).toFixed(0) + '°', Math.abs(ui.sensors.gamma) < 8 ? 'good' : 'bad') +
      attCell('HEADING', ui.sensors.heading == null ? '—' : ui.sensors.heading.toFixed(0) + '°', '') +
      '</div>' +
      '<div class="tilt-bar"><div class="band" style="left:27.7%;width:44.4%"></div>' +
      '<div class="mark" id="tilt-mark" style="left:' + clamp(tiltDeg(), 0, 90) / 90 * 100 + '%"></div></div>' +
      '<div class="hint" id="cap-hint">' + captureHint() + '</div>' +
      '<div class="shutter-row"><button class="shutter" data-act="shoot"' + (c.ready ? '' : ' disabled') + '><div></div></button></div>';
  }

  return '<div class="full">' +
    '<div class="full-head"><span class="ftitle">CAPTURE</span>' +
    '<button class="close-btn" data-act="close-capture">×</button></div>' +
    '<div class="full-body">' +
    (c.err ? '' : '<video id="cam-video" autoplay playsinline muted></video>') +
    '</div>' +
    '<div class="full-foot">' + foot + '</div></div>';
}
function attCell(label, val, cls) {
  return '<div class="att-cell ' + (cls || '') + '"><div class="al">' + label + '</div><div class="av">' + val + '</div></div>';
}
/* beta is 90 when the phone stands upright, so depression below the horizon is
   the shortfall from 90. */
function tiltDeg() { return clamp(90 - (ui.sensors.beta || 0), -90, 90); }
function tiltClass() { var t = tiltDeg(); return (t >= 25 && t <= 65) ? 'good' : 'bad'; }
function captureHint() {
  var t = tiltDeg();
  if (!ui.sensors.live) return 'Tilt sensor idle — calibrate from a measured rectangle instead.';
  if (Math.abs(ui.sensors.gamma) > 8) return 'Level the phone — <b>roll ' + ui.sensors.gamma.toFixed(0) + '°</b>.';
  if (t < 25) return 'Tilt down a little — <b>too flat</b> and distance error runs away.';
  if (t > 65) return 'Tilt up a little — <b>too steep</b> and you cover almost no roof.';
  return 'Good angle. Keep something you have <b>measured</b> in frame.';
}
/* Repaints only the numbers, sixty times a second, without touching the DOM
   around the live video — re-rendering the whole screen would restart the camera. */
function paintCaptureHud() {
  var hint = $('#cap-hint'); if (!hint) return;
  var cells = $$('.att-cell .av');
  if (cells.length >= 3) {
    cells[0].textContent = tiltDeg().toFixed(0) + '°';
    cells[1].textContent = (ui.sensors.gamma || 0).toFixed(0) + '°';
    cells[2].textContent = ui.sensors.heading == null ? '—' : ui.sensors.heading.toFixed(0) + '°';
    cells[0].parentNode.className = 'att-cell ' + tiltClass();
    cells[1].parentNode.className = 'att-cell ' + (Math.abs(ui.sensors.gamma) < 8 ? 'good' : 'bad');
  }
  hint.innerHTML = captureHint();
  var mark = $('#tilt-mark');
  if (mark) mark.style.left = clamp(tiltDeg(), 0, 90) / 90 * 100 + '%';
}

/* ---------- live HUD ----------

   The survey drawn back over the live camera, from a standpoint whose position is
   already known. It is a DRIFT MONITOR, not a positioning system: nothing here
   can know where you are standing, so it assumes you are at the chosen shot and
   shows what the survey claims is in front of you. If the wireframe sits on the
   real units, the survey is consistent. If it has slid, something is wrong — and
   learning that on the roof is worth more than any number afterwards. */
function tplLive() {
  var p = currentProject();
  var l = ui.live;
  if (!p || !l) { view.screen = 'project'; return tplProject(); }
  var placed = p.stations.filter(function (s) { return s.reg && s.cal && s.cal.ok; });

  var foot;
  if (l.err) {
    foot = '<div class="panel warn"><span class="p-tag">CAMERA</span><div class="p-body">' + esc(l.err) + '</div></div>';
  } else if (needsMotionPermission()) {
    foot = '<div class="panel gold"><span class="p-tag">TILT SENSOR</span>' +
      '<div class="p-body">The overlay is driven by the tilt sensor. Without it there is nothing to draw.</div>' +
      '<button class="btn primary sm" data-act="ask-motion">Enable tilt sensor</button></div>';
  } else {
    var noH = p.objects.filter(function (o) { return (o.kind === 'rect' || o.kind === 'cylinder') && !(o.h > 0); }).length;
    foot =
      '<div class="live-row">' +
      '<select class="inp live-sel" id="live-station">' + placed.map(function (s) {
        return '<option value="' + s.id + '"' + (s.id === l.stationId ? ' selected' : '') +
          '>Standing at shot ' + (p.stations.indexOf(s) + 1) + '</option>';
      }).join('') + '</select>' +
      '<button class="pill' + (l.showCoverage ? ' on' : '') + '" data-act="live-coverage">Gaps</button>' +
      '</div>' +
      '<div class="field"><label>ALIGN — NUDGE UNTIL THE WIREFRAME SITS ON THE REAL UNITS</label>' +
      '<input type="range" class="slider" id="live-yaw" min="-180" max="180" step="0.5" value="' + (l.yaw || 0) + '"></div>' +
      '<div class="hint">' + (noH ? '<b>' + noH + '</b> object' + (noH === 1 ? '' : 's') + ' still need a height — drawn amber. ' : '') +
      'Trusted to <b>' + EE.fmtLen(trustedRadius(), U(), 1) + '</b> from here.</div>';
  }

  return '<div class="full">' +
    '<div class="full-head"><span class="ftitle">LIVE — DRIFT CHECK</span>' +
    '<button class="close-btn" data-act="close-live">×</button></div>' +
    '<div class="full-body">' +
    (l.err ? '' : '<video id="live-video" autoplay playsinline muted></video><canvas id="live-canvas"></canvas>') +
    '</div>' +
    '<div class="full-foot">' + foot + '</div></div>';
}

/* project frame -> the alpha-referenced world frame the live attitude lives in */
function projToWorld(p, st, q) {
  var local = fromProj(st, q);
  var c = st.cal;
  if (!c) return null;
  if (c.mode === 'ray') return local;
  if (!c.pose) return null;
  var inv = EE.applySimilarityInverse(c.pose, local);
  return { x: inv.x * c.pose.scale, y: inv.y * c.pose.scale };
}

function paintLive() {
  var p = currentProject(), l = ui.live;
  if (!p || !l) return;
  var v = $('#live-video'), cv = $('#live-canvas');
  if (!v || !cv || !v.videoWidth) return;
  var st = findStation(p, l.stationId);
  if (!st || !st.cal || !st.cal.ok) return;

  /* The canvas takes the video's own pixel dimensions and the same object-fit, so
     overlay and image align without ever computing the cover crop. */
  if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
  var W = cv.width, H = cv.height;
  var g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);

  var camH = st.cal.camH || db.settings.camH;
  var f = EE.focalFromFov(db.settings.fov, Math.max(W, H));
  var R = EE.rotFromOrientation(ui.sensors.alpha, ui.sensors.beta, ui.sensors.gamma);
  var Hm = EE.homographyFromPose(R, camH, f, W, H, screenAngle());
  var Hi = Hm && EE.invert3(Hm);
  if (!Hi) return;

  var yaw = (l.yaw || 0) * Math.PI / 180;
  var cw = Math.cos(yaw), sw = Math.sin(yaw);
  var world = function (q) {
    var w = projToWorld(p, st, q);
    if (!w) return null;
    return { x: w.x * cw - w.y * sw, y: w.x * sw + w.y * cw };
  };
  var toPix = function (q) { var w = world(q); return w ? EE.applyH(Hi, w) : null; };

  var lw = Math.max(2, W / 500), scale = W / 1000;

  if (Math.abs(Hm[7]) > 1e-12) {
    g.strokeStyle = 'rgba(244,240,232,0.25)'; g.lineWidth = lw * 0.6;
    g.beginPath();
    g.moveTo(0, -(Hm[8]) / Hm[7]);
    g.lineTo(W, -(Hm[8] + Hm[6] * W) / Hm[7]);
    g.stroke();
  }

  var cam = stationCamera(p, st);
  if (cam) {
    g.strokeStyle = 'rgba(110,210,154,0.5)'; g.lineWidth = lw;
    g.setLineDash([11 * scale, 9 * scale]);
    g.beginPath();
    strokeScreenPoly(g, EE.circlePoly(cam.x, cam.y, trustedRadius(), 72).map(toPix), true);
    g.stroke(); g.setLineDash([]);
  }

  if (l.showCoverage) {
    var cov = computeCoverage(p);
    if (cov) {
      g.fillStyle = 'rgba(201,106,94,0.32)';
      for (var r = 0; r < cov.rows; r++) {
        for (var c = 0; c < cov.cols; c++) {
          var e = cov.data[r * cov.cols + c];
          if (isFinite(e) && e <= db.settings.tolerance) continue;
          var wx = cov.minX + (c + 0.5) * cov.cell, wy = cov.minY + (r + 0.5) * cov.cell;
          if (cam && Math.hypot(wx - cam.x, wy - cam.y) > trustedRadius() * 1.7) continue;
          var q = toPix({ x: wx, y: wy });
          if (!q) continue;
          var sz = Math.max(3, 30 * scale);
          g.fillRect(q.x - sz / 2, q.y - sz / 2, sz, sz);
        }
      }
    }
  }

  placedObjects(p).forEach(function (o) {
    var needsH = (o.kind === 'rect' || o.kind === 'cylinder') && !(o.h > 0);
    var base = o.kind === 'rect' ? EE.rectCorners(o)
      : o.kind === 'cylinder' ? EE.circlePoly(o.cx, o.cy, o.r, 28)
        : (o.pts || []);
    if (base.length < 1) return;
    var bp = base.map(toPix);
    if (!bp.some(Boolean)) return;

    if (o.kind === 'point') {
      var q = bp[0]; if (!q) return;
      g.strokeStyle = '#6ED29A'; g.lineWidth = lw;
      g.beginPath();
      g.moveTo(q.x - 15 * scale, q.y); g.lineTo(q.x + 15 * scale, q.y);
      g.moveTo(q.x, q.y - 15 * scale); g.lineTo(q.x, q.y + 15 * scale);
      g.stroke();
      if (o.name) label(g, o.name, q.x + 18 * scale, q.y, '#6ED29A', scale);
      return;
    }

    var col = needsH ? '#E8C96A' : (o.kind === 'outline' ? 'rgba(244,240,232,0.7)' : '#D4AF37');
    g.strokeStyle = col; g.lineWidth = lw;
    if (needsH) g.setLineDash([10 * scale, 8 * scale]);
    g.beginPath(); strokeScreenPoly(g, bp, true); g.stroke();
    g.setLineDash([]);

    if (o.h > 0 && o.kind !== 'outline') {
      var top = base.map(function (q0) {
        var w = world(q0);
        return w ? EE.projectToPixel(w, R, camH, W, H, f, screenAngle(), o.h) : null;
      });
      g.globalAlpha = 0.85;
      g.beginPath(); strokeScreenPoly(g, top, true); g.stroke();
      g.globalAlpha = 0.4;
      g.beginPath();
      var stepN = Math.max(1, Math.floor(base.length / 8));
      for (var i = 0; i < base.length; i += stepN) {
        if (bp[i] && top[i]) { g.moveTo(bp[i].x, bp[i].y); g.lineTo(top[i].x, top[i].y); }
      }
      g.stroke(); g.globalAlpha = 1;
    }

    var a = bp.find(Boolean);
    if (o.name && a) {
      label(g, o.name + (needsH ? '  NEEDS HEIGHT' : (o.h ? '  ' + EE.fmtLen(o.h, U(), 1) : '')),
        a.x, a.y - 12 * scale, col, scale);
    }
  });
}

function strokeScreenPoly(g, pts, close) {
  var started = false, first = null;
  for (var i = 0; i < pts.length; i++) {
    var q = pts[i];
    if (!q || !isFinite(q.x) || !isFinite(q.y) || Math.abs(q.x) > 1e5 || Math.abs(q.y) > 1e5) { started = false; continue; }
    if (started) g.lineTo(q.x, q.y);
    else { g.moveTo(q.x, q.y); started = true; if (!first) first = q; }
  }
  if (close && first && started) g.lineTo(first.x, first.y);
}

function label(g, text, x, y, col, scale) {
  g.font = '600 ' + Math.round(22 * scale) + 'px -apple-system, system-ui, sans-serif';
  var w = g.measureText(text).width;
  g.fillStyle = 'rgba(12,10,16,0.72)';
  g.fillRect(x - 6 * scale, y - 19 * scale, w + 12 * scale, 26 * scale);
  g.fillStyle = col;
  g.fillText(text, x, y);
}

/* ---------- trace ---------- */
function tplTrace() {
  var t = ui.trace;
  var p = currentProject();
  if (!t || !p) { view.screen = 'project'; return tplProject(); }
  var st = findStation(p, t.stationId);
  if (!st) { view.screen = 'project'; return tplProject(); }

  var foot = t.step === 'cal' ? tplTraceCal(st, t) : tplTraceDraw(p, st, t);

  return '<div class="full">' +
    '<div class="full-head"><span class="ftitle">' + (t.step === 'cal' ? 'CALIBRATE' : 'TRACE') + '</span>' +
    '<button class="close-btn" data-act="close-trace">×</button></div>' +
    '<div class="full-body" id="trace-body"><canvas id="trace-canvas" class="fit"></canvas></div>' +
    '<div class="full-foot">' + foot + '</div></div>';
}

function tplTraceCal(st, t) {
  var dots = function (n, total) {
    var out = '<div class="step-dots">';
    for (var i = 0; i < total; i++) out += '<i class="' + (i < n ? 'done' : (i === n ? 'on' : '')) + '"></i>';
    return out + '</div>';
  };

  var modeSeg = '<div class="seg tight">' +
    '<button class="' + (t.calMode === 'quad' ? 'active' : '') + '" data-calmode="quad">Measured rectangle</button>' +
    '<button class="' + (t.calMode === 'ray' ? 'active' : '') + '" data-calmode="ray">Tilt + height</button>' +
    '</div>';

  if (t.calMode === 'quad') {
    var n = t.taps.length;
    var body;
    if (n < 4) {
      body = '<div class="hint">Tap the <b>four corners</b> of something rectangular you have ' +
        'measured — a curb, a paver, two tapes in an L. Go round in order.<br>' +
        'Corner <b>' + (n + 1) + ' of 4</b>. Hold and drag for the loupe.</div>' + dots(n, 4);
    } else {
      body = '<div class="row2">' +
        '<div class="field"><label>WIDTH (first edge)</label><div class="unit-suffix">' +
        '<input class="inp mono" id="ref-w" inputmode="decimal" value="' + esc(t.refW) + '"><span>' + U() + '</span></div></div>' +
        '<div class="field"><label>LENGTH (second edge)</label><div class="unit-suffix">' +
        '<input class="inp mono" id="ref-l" inputmode="decimal" value="' + esc(t.refL) + '"><span>' + U() + '</span></div></div>' +
        '</div>' +
        '<div class="hint">No lens data, no tilt, no guessed eye height — this route needs ' +
        'none of them. It is the accurate one.</div>';
    }
    return modeSeg + body +
      '<div class="btn-row">' +
      (n ? '<button class="btn ghost sm" data-act="undo-tap">Undo</button>' : '') +
      (n >= 4 ? '<button class="btn primary sm" data-act="apply-quad">Calibrate</button>' : '') +
      '</div>';
  }

  /* ray mode */
  var haveAtt = !!st.att;
  var scaleRow = t.taps.length >= 2
    ? '<div class="field"><label>DISTANCE BETWEEN THE TWO TAPS</label><div class="unit-suffix">' +
    '<input class="inp mono" id="known-len" inputmode="decimal" value="' + esc(t.knownLen) + '"><span>' + U() + '</span></div></div>'
    : '<div class="hint">Optional but far better: tap <b>two points</b> a known distance apart and ' +
    'let the app solve your camera height instead of trusting the number above.</div>';

  return modeSeg +
    (haveAtt ? '' : '<div class="panel warn"><span class="p-tag">NO TILT RECORDED</span>' +
      '<div class="p-body">This shot has no attitude, so it can only be calibrated from a measured rectangle.</div></div>') +
    '<div class="field"><label>CAMERA HEIGHT ABOVE THE ROOF</label><div class="unit-suffix">' +
    '<input class="inp mono" id="cam-h" inputmode="decimal" value="' + esc(t.camH) + '"><span>' + U() + '</span></div></div>' +
    scaleRow +
    '<div class="btn-row">' +
    (t.taps.length ? '<button class="btn ghost sm" data-act="undo-tap">Undo</button>' : '') +
    '<button class="btn primary sm" data-act="apply-ray"' + (haveAtt ? '' : ' disabled') + '>Calibrate</button>' +
    '</div>';
}

function tplTraceDraw(p, st, t) {
  var map = calMap(st);
  var tools = [
    { k: 'rect', i: '▭', l: 'Box' },
    { k: 'cylinder', i: '●', l: 'Cylinder' },
    { k: 'outline', i: '⬡', l: 'Outline' },
    { k: 'point', i: '✛', l: 'Landmark' }
  ];
  if (map && map.has3D) tools.push({ k: 'height', i: '↕', l: 'Height' });

  var rail = '<div class="tool-rail">' + tools.map(function (x) {
    return '<button class="tool' + (t.tool === x.k ? ' active' : '') + '" data-tool="' + x.k + '">' +
      '<span class="ti">' + x.i + '</span><span class="tl">' + x.l + '</span></button>';
  }).join('') + '</div>';

  var need = t.tool === 'point' ? 1 : (t.tool === 'height' ? 2 : 3);
  var n = t.taps.length;
  var ready = n >= need;

  var msg;
  if (t.tool === 'height') msg = n === 0 ? 'Tap where the object <b>meets the roof</b>.' : (n === 1 ? 'Now tap the <b>top</b> of the same object, directly above.' : 'Ready.');
  else if (t.tool === 'point') msg = 'Tap a landmark you can also see from other shots — a corner, a drain. Name it the same each time and the shots tie themselves together.';
  else if (t.tool === 'cylinder') msg = 'Tap <b>three or more points</b> around the base of the cylinder.';
  else if (t.tool === 'outline') msg = 'Walk the <b>roof edge or parapet</b>, tapping each corner.';
  else msg = 'Tap the <b>base corners</b> where the unit meets the roof — three is enough, four is better.';

  var unreg = !st.reg;
  var known = tiePoints(p, st.id);

  return rail +
    (unreg ? '<div class="panel warn"><span class="p-tag">SHOT NOT PLACED</span>' +
      '<div class="p-body">Mark <b>two landmarks</b> that already exist in the survey (' +
      (known.length ? known.slice(0, 4).map(function (k) { return esc(k.label); }).join(', ') : 'none yet') +
      ') and this shot will snap into the plan.</div></div>' : '') +
    '<div class="hint">' + msg + '</div>' +
    '<div class="btn-row">' +
    '<button class="btn ghost sm" data-act="recal">Recalibrate</button>' +
    (n ? '<button class="btn ghost sm" data-act="undo-tap">Undo</button>' : '') +
    '<button class="btn primary sm" data-act="commit-shape"' + (ready ? '' : ' disabled') + '>' +
    (t.tool === 'height' ? 'Measure' : 'Add') + '</button>' +
    '</div>';
}

/* ================= sheets ================= */
function tplSheet() {
  var s = ui.sheet;
  if (!s) return '';
  var inner = '';
  if (s.kind === 'project') inner = sheetProject(s);
  else if (s.kind === 'object') inner = sheetObject(s);
  else if (s.kind === 'geo') inner = sheetGeo(s);
  else if (s.kind === 'settings') inner = sheetSettings(s);
  else if (s.kind === 'menu') inner = sheetMenu(s);
  else if (s.kind === 'place') inner = sheetPlace(s);
  else if (s.kind === 'error') inner = sheetError(s);
  else if (s.kind === 'scale') inner = sheetScale(s);
  else if (s.kind === 'confirm') inner = sheetConfirm(s);
  return '<div class="scrim" data-act="close-sheet"></div><div class="sheet">' + inner + '</div>';
}

function sheetProject(s) {
  return '<div class="sheet-head"><span class="sh-title">' + (s.id ? 'Survey' : 'New survey') + '</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="field"><label>NAME</label><input class="inp" id="sp-name" value="' + esc(s.name || '') + '" placeholder="Teknion — 1150 Flint" autocomplete="off"></div>' +
    '<div class="field"><label>ADDRESS</label><input class="inp" id="sp-addr" value="' + esc(s.address || '') + '" placeholder="1150 Flint Rd, Toronto" autocomplete="off"></div>' +
    '<div class="btn-row"><button class="btn primary" data-act="save-project">Save</button></div>';
}

function sheetObject(s) {
  var p = currentProject();
  var o = p.objects.find(function (q) { return q.id === s.id; });
  if (!o) return '';
  var dims = '';
  if (o.kind === 'rect') {
    dims = '<div class="row2">' +
      '<div class="field"><label>WIDTH</label><div class="unit-suffix"><input class="inp mono" id="so-w" inputmode="decimal" value="' + EE.fromM(o.w, U()).toFixed(2) + '"><span>' + U() + '</span></div></div>' +
      '<div class="field"><label>LENGTH</label><div class="unit-suffix"><input class="inp mono" id="so-l" inputmode="decimal" value="' + EE.fromM(o.l, U()).toFixed(2) + '"><span>' + U() + '</span></div></div>' +
      '</div>';
  } else if (o.kind === 'cylinder') {
    dims = '<div class="field"><label>DIAMETER</label><div class="unit-suffix"><input class="inp mono" id="so-d" inputmode="decimal" value="' + EE.fromM(o.r * 2, U()).toFixed(2) + '"><span>' + U() + '</span></div></div>';
  }

  var presets = U() === 'ft' ? [1, 2, 3, 4, 6, 8] : [0.3, 0.6, 1, 1.2, 2, 2.5];
  var chips = (o.kind === 'point' || o.kind === 'outline') ? '' :
    '<div class="seg tight">' + presets.map(function (v) {
      return '<button data-setheight="' + v + '">' + v + ' ' + U() + '</button>';
    }).join('') + '</div>';

  return '<div class="sheet-head"><span class="sh-title">' + (o.kind === 'point' ? 'Landmark' : o.kind === 'outline' ? 'Outline' : o.kind === 'cylinder' ? 'Cylinder' : 'Box') + '</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="field"><label>NAME</label><input class="inp" id="so-name" value="' + esc(o.name || '') + '" placeholder="' +
    (o.kind === 'point' ? 'NE corner' : 'RTU-1') + '" autocomplete="off"></div>' +
    dims +
    ((o.kind === 'point' || o.kind === 'outline') ? '' :
      '<div class="field"><label>HEIGHT</label><div class="unit-suffix"><input class="inp mono" id="so-h" inputmode="decimal" value="' + EE.fromM(o.h || 0, U()).toFixed(2) + '"><span>' + U() + '</span></div></div>' + chips) +
    '<div class="field"><label>NOTE</label><input class="inp" id="so-note" value="' + esc(o.note || '') + '" autocomplete="off"></div>' +
    (o.kind === 'rect' || o.kind === 'cylinder' ? '<button class="btn ghost-gold sm" data-act="snap-dims">Round to the nearest ' + (U() === 'ft' ? 'inch' : '5 cm') + '</button>' : '') +
    '<div class="btn-row"><button class="btn primary" data-act="save-object">Save</button>' +
    '<button class="btn danger" data-act="delete-object">Delete</button></div>';
}

function sheetGeo(s) {
  var p = currentProject();
  var pts = p.objects.filter(function (o) { return o.kind === 'point' && projObj(p, o); });
  var opts = function (selId) {
    return pts.map(function (o) {
      return '<option value="' + o.id + '"' + (selId === o.id ? ' selected' : '') + '>' + esc(o.name || 'landmark') + '</option>';
    }).join('');
  };

  var body;
  if (s.method === 'two') {
    body = pts.length < 2
      ? '<div class="panel warn"><span class="p-tag">NEED TWO LANDMARKS</span><div class="p-body">' +
      'Trace at least two landmark points first — the far corners of the roof are ideal, ' +
      'because the further apart they are the less a misread coordinate rotates the plan.</div></div>'
      : '<div class="field"><label>LANDMARK A</label><select class="inp" id="ga-id">' + opts(s.aId) + '</select></div>' +
      '<div class="field"><label>ITS LATITUDE, LONGITUDE</label>' +
      '<input class="inp mono" id="ga-ll" value="' + esc(s.aLL || '') + '" placeholder="43.761500, -79.508300" autocomplete="off"></div>' +
      '<div class="field"><label>LANDMARK B</label><select class="inp" id="gb-id">' + opts(s.bId) + '</select></div>' +
      '<div class="field"><label>ITS LATITUDE, LONGITUDE</label>' +
      '<input class="inp mono" id="gb-ll" value="' + esc(s.bLL || '') + '" placeholder="43.762100, -79.507400" autocomplete="off"></div>' +
      '<div class="hint">Right-click the spot in Google Maps and the coordinates copy straight out. ' +
      'Paste them here.</div>' +
      '<div class="btn-row"><button class="btn primary" data-act="apply-geo-two">Place the survey</button></div>';
  } else if (s.method === 'gps') {
    var g = ui.gps;
    body = '<div class="panel ' + (g ? 'good' : '') + '"><span class="p-tag">DEVICE POSITION</span>' +
      (g ? '<div class="kv"><span>Fix</span><span>' + g.lat.toFixed(6) + ', ' + g.lon.toFixed(6) + '</span></div>' +
        '<div class="kv ' + (g.acc <= 8 ? 'good' : 'warn') + '"><span>Accuracy</span><span>±' + g.acc.toFixed(0) + ' m</span></div>'
        : '<div class="p-body">Waiting for a fix…</div>') +
      '</div>' +
      '<div class="field"><label>STAND ON THIS LANDMARK</label><select class="inp" id="gg-id">' + opts(s.aId) + '</select></div>' +
      '<div class="field"><label>BEARING OF PLAN-UP (° TRUE)</label><input class="inp mono" id="gg-br" inputmode="decimal" value="' +
      esc(s.bearing != null ? s.bearing : (ui.sensors.heading != null ? ui.sensors.heading.toFixed(0) : '0')) + '"></div>' +
      '<div class="hint">A phone GPS lands within a handful of metres and a compass sits ' +
      'badly on a steel roof. Good for a first placement; pin two landmarks when it matters.</div>' +
      '<div class="btn-row"><button class="btn primary" data-act="apply-geo-gps"' + (g && pts.length ? '' : ' disabled') + '>Use this fix</button></div>';
  } else {
    body = '<div class="field"><label>ANCHOR LATITUDE, LONGITUDE</label>' +
      '<input class="inp mono" id="gm-ll" value="' + esc(s.mLL || (p.anchor ? p.anchor.lat.toFixed(6) + ', ' + p.anchor.lon.toFixed(6) : '')) + '" placeholder="43.761500, -79.508300" autocomplete="off"></div>' +
      '<div class="field"><label>BEARING OF PLAN-UP (° TRUE)</label>' +
      '<input class="inp mono" id="gm-br" inputmode="decimal" value="' + esc(p.anchor ? p.anchor.bearing.toFixed(1) : '0') + '"></div>' +
      '<div class="hint">The anchor is the plan origin — where the first shot was calibrated.</div>' +
      '<div class="btn-row"><button class="btn primary" data-act="apply-geo-manual">Apply</button></div>';
  }

  return '<div class="sheet-head"><span class="sh-title">Locate the survey</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="seg tight">' +
    '<button class="' + (s.method === 'two' ? 'active' : '') + '" data-geomethod="two">Two landmarks</button>' +
    '<button class="' + (s.method === 'gps' ? 'active' : '') + '" data-geomethod="gps">GPS</button>' +
    '<button class="' + (s.method === 'manual' ? 'active' : '') + '" data-geomethod="manual">Manual</button>' +
    '</div>' + body;
}

function sheetPlace(s) {
  var p = currentProject();
  var st = findStation(p, s.id);
  if (!st) return '';
  var r = st.reg || { theta: 0, tx: 0, ty: 0 };
  return '<div class="sheet-head"><span class="sh-title">Place this shot</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="p-body">Two landmarks shared with another shot place it exactly. Failing that, ' +
    'nudge it into position by hand.</div>' +
    '<div class="field"><label>ROTATION (°)</label><input class="inp mono" id="pl-rot" inputmode="decimal" value="' + (r.theta * 180 / Math.PI).toFixed(1) + '"></div>' +
    '<div class="row2">' +
    '<div class="field"><label>OFFSET X</label><div class="unit-suffix"><input class="inp mono" id="pl-x" inputmode="decimal" value="' + EE.fromM(r.tx, U()).toFixed(2) + '"><span>' + U() + '</span></div></div>' +
    '<div class="field"><label>OFFSET Y</label><div class="unit-suffix"><input class="inp mono" id="pl-y" inputmode="decimal" value="' + EE.fromM(r.ty, U()).toFixed(2) + '"><span>' + U() + '</span></div></div>' +
    '</div>' +
    '<div class="btn-row"><button class="btn primary" data-act="apply-place">Place</button>' +
    '<button class="btn ghost" data-act="retry-tie">Retry landmarks</button></div>';
}

function sheetError() {
  var s = db.settings;
  var rows = [3, 5, 10, 15, 20, 30].map(function (d) {
    var e = EE.positionSigma(s.camH, d, attSigmaRad(), s.deckUnc);
    return '<div class="kv ' + (e <= s.tolerance ? 'good' : (e <= s.tolerance * 2 ? '' : 'warn')) + '">' +
      '<span>' + EE.fmtLen(d, U(), 0) + ' away</span><span>±' + EE.fmtLen(e, U(), 2) + '</span></div>';
  }).join('');

  return '<div class="sheet-head"><span class="sh-title">Error model</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="p-body">A ray leaving at depression θ lands at h/tan θ, so an attitude error moves ' +
    'the point by <b>(h² + d²)/h</b> per radian. It grows with the <b>square</b> of range and shrinks ' +
    'with camera height — which is why standing closer beats every other improvement.</div>' +
    rows +
    '<div class="kv"><span>Trusted radius</span><span>' + EE.fmtLen(trustedRadius(), U(), 1) + '</span></div>' +
    '<div class="row3">' +
    '<div class="field"><label>TOLERANCE</label><input class="inp mono" id="err-tol" inputmode="decimal" value="' + EE.fromM(s.tolerance, U()).toFixed(2) + '"></div>' +
    '<div class="field"><label>TILT σ (°)</label><input class="inp mono" id="err-att" inputmode="decimal" value="' + s.attSigma + '"></div>' +
    '<div class="field"><label>DECK ±</label><input class="inp mono" id="err-deck" inputmode="decimal" value="' + EE.fromM(s.deckUnc, U()).toFixed(2) + '"></div>' +
    '</div>' +
    '<div class="hint">Deck uncertainty is <b>declared, never measured</b> — it is how far the roof may ' +
    'depart from the flat plane every calculation assumes.</div>' +
    '<div class="btn-row"><button class="btn primary" data-act="save-error">Apply</button></div>';
}

function sheetScale(s) {
  var p = currentProject();
  var cur = p.scaleRef;
  var method = s.method || (cur && cur.method) || 'laser';
  var seg = [['laser', 'Laser'], ['tape', 'Tape'], ['paced', 'Paced']].map(function (m) {
    return '<button class="' + (method === m[0] ? 'active' : '') + '" data-srmethod="' + m[0] + '">' + m[1] + '</button>';
  }).join('');
  var sigma = { laser: 0.0015, tape: 0.01, paced: 0.25 }[method];

  return '<div class="sheet-head"><span class="sh-title">Scale reference</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="p-body">Every length in the survey rides on one measured distance. Scale is a ' +
    '<b>gauge freedom</b> — no amount of walking, photographing or correlating can recover it, so this ' +
    'number is an input, not an output.</div>' +
    '<div class="seg tight">' + seg + '</div>' +
    '<div class="field"><label>MEASURED DISTANCE</label><div class="unit-suffix">' +
    '<input class="inp mono" id="sr-len" inputmode="decimal" value="' +
    esc(cur ? EE.fromM(cur.lengthM, U()).toFixed(2) : '') + '"><span>' + U() + '</span></div></div>' +
    '<div class="field"><label>WHAT WAS MEASURED</label><input class="inp" id="sr-note" value="' +
    esc(cur ? cur.note : '') + '" placeholder="parapet inside face, NE to SW"></div>' +
    '<div class="hint">' + (method === 'laser'
      ? 'Shoot the <b>inside face of the far parapet</b> — a large matte near-vertical target that returns in full sun. White membrane will not return past about 15–20 m.'
      : method === 'tape' ? 'A 30 m fibreglass tape is about 0.05%. Keep the baseline over 10 m; a 2 m square is 0.5% and that lands on every dimension.'
        : 'A paced estimate is roughly 5%. It will not be visible in the plan, but it is 5% on every length and 10% on every area.') +
    '</div>' +
    (function () {
      var v = parseFloat(cur ? cur.lengthM : 0);
      if (!(v > 0)) return '';
      return '<div class="kv ' + (sigma / v < 0.002 ? 'good' : 'warn') + '"><span>Scale uncertainty</span>' +
        '<span>±' + (sigma / v * 100).toFixed(3) + '%</span></div>';
    })() +
    '<div class="btn-row"><button class="btn primary" data-act="save-scale">Save</button></div>';
}

function sheetSettings() {
  var s = db.settings;
  return '<div class="sheet-head"><span class="sh-title">Settings</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="field"><label>UNITS</label><div class="seg tight">' +
    '<button class="' + (s.unit === 'm' ? 'active' : '') + '" data-unit="m">metres</button>' +
    '<button class="' + (s.unit === 'ft' ? 'active' : '') + '" data-unit="ft">feet</button></div></div>' +
    '<div class="field"><label>CAMERA FIELD OF VIEW (° ACROSS THE LONG EDGE)</label>' +
    '<input class="inp mono" id="set-fov" inputmode="decimal" value="' + s.fov + '"></div>' +
    '<div class="hint">Only the tilt-and-height route uses this. Calibrate from a measured ' +
    'rectangle once and Eagle Eye solves it for you.</div>' +
    '<div class="field"><label>DEFAULT CAMERA HEIGHT</label><div class="unit-suffix">' +
    '<input class="inp mono" id="set-camh" inputmode="decimal" value="' + EE.fromM(s.camH, s.unit).toFixed(2) + '"><span>' + s.unit + '</span></div></div>' +
    '<div class="field"><label>CIRCLE SEGMENTS PER CYLINDER</label>' +
    '<input class="inp mono" id="set-seg" inputmode="numeric" value="' + s.circleSegments + '"></div>' +
    '<div class="field"><label>PHOTO LONG EDGE (PX)</label>' +
    '<input class="inp mono" id="set-maxpx" inputmode="numeric" value="' + s.maxPx + '"></div>' +
    '<div class="kv"><span>Photos stored</span><span>' + fmtBytes(ui.storageBytes) + '</span></div>' +
    '<div class="btn-row"><button class="btn primary" data-act="save-settings">Save</button></div>' +
    '<div class="btn-row"><button class="btn danger" data-act="purge-photos">Drop all photos</button></div>' +
    '<div class="hint">Dropping photos keeps every measurement and frees the space. You lose ' +
    'only the ability to go back and trace more from those shots.</div>';
}

function sheetMenu(s) {
  return '<div class="sheet-head"><span class="sh-title">' + esc(s.title || '') + '</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    (s.items || []).map(function (it) {
      return '<div class="m-item ' + (it.cls || '') + '" data-menu="' + it.act + '">' + esc(it.label) + '</div>';
    }).join('');
}

function sheetConfirm(s) {
  return '<div class="sheet-head"><span class="sh-title">' + esc(s.title) + '</span></div>' +
    '<div class="p-body">' + esc(s.body) + '</div>' +
    '<div class="btn-row"><button class="btn danger" data-act="confirm-yes">' + esc(s.yes || 'Delete') + '</button>' +
    '<button class="btn ghost" data-act="close-sheet">Cancel</button></div>';
}

/* ================= canvas painting ================= */

function fitCanvas(cv) {
  var r = cv.getBoundingClientRect();
  var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g: g, w: r.width, h: r.height };
}

function paint() {
  if (view.screen === 'project') {
    if (view.tab === 'plan') paintPlan();
    else if (view.tab === 'scene') paintScene();
  } else if (view.screen === 'trace') {
    paintTrace();
  }
}

/* ---------- plan ---------- */
function planFit(p, w, h) {
  var objs = placedObjects(p);
  var xs = [], ys = [];
  objs.forEach(function (o) {
    if (o.kind === 'rect') EE.rectCorners(o).forEach(function (c) { xs.push(c.x); ys.push(c.y); });
    else if (o.kind === 'cylinder') { xs.push(o.cx - o.r, o.cx + o.r); ys.push(o.cy - o.r, o.cy + o.r); }
    else (o.pts || []).forEach(function (c) { xs.push(c.x); ys.push(c.y); });
  });
  if (!xs.length) { ui.plan = { s: 12, ox: 0, oy: 0, fitted: true }; return; }
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  var pad = 34;
  var sx = (w - pad * 2) / Math.max(0.5, maxX - minX);
  var sy = (h - pad * 2) / Math.max(0.5, maxY - minY);
  ui.plan.s = clamp(Math.min(sx, sy), 0.4, 300);
  ui.plan.ox = (minX + maxX) / 2;
  ui.plan.oy = (minY + maxY) / 2;
  ui.plan.fitted = true;
}

function paintPlan() {
  var cv = $('#plan-canvas'); if (!cv) return;
  var p = currentProject(); if (!p) return;
  var c = fitCanvas(cv), g = c.g, w = c.w, h = c.h;
  if (!ui.plan.fitted) planFit(p, w, h);

  var S = ui.plan.s;
  var X = function (x) { return w / 2 + (x - ui.plan.ox) * S; };
  var Y = function (y) { return h / 2 - (y - ui.plan.oy) * S; };

  g.fillStyle = '#08060C'; g.fillRect(0, 0, w, h);

  /* adaptive grid: keep lines somewhere near 34–170 px apart */
  var step = 1;
  while (step * S < 34) step *= (step.toString()[0] === '1' ? 2.5 : 2);
  while (step * S > 170) step /= (step.toString()[0] === '5' ? 2.5 : 2);
  var x0 = Math.floor((ui.plan.ox - w / 2 / S) / step) * step;
  var x1 = ui.plan.ox + w / 2 / S;
  var y0 = Math.floor((ui.plan.oy - h / 2 / S) / step) * step;
  var y1 = ui.plan.oy + h / 2 / S;
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(244,240,232,0.055)';
  g.beginPath();
  for (var gx = x0; gx <= x1; gx += step) { g.moveTo(X(gx), 0); g.lineTo(X(gx), h); }
  for (var gy = y0; gy <= y1; gy += step) { g.moveTo(0, Y(gy)); g.lineTo(w, Y(gy)); }
  g.stroke();

  /* coverage raster, under the geometry — it is context, not content */
  if (ui.showCoverage) {
    var cov = computeCoverage(p), cimg = coverageCanvas(p);
    if (cov && cimg) {
      g.save();
      g.imageSmoothingEnabled = false;
      var x0 = X(cov.minX), y0 = Y(cov.minY + cov.rows * cov.cell);
      g.drawImage(cimg, x0, y0, cov.cols * cov.cell * S, cov.rows * cov.cell * S);
      g.restore();
    }
    /* where each shot was taken from, and how far it reaches */
    p.stations.forEach(function (st) {
      var cam = stationCamera(p, st);
      if (!cam) return;
      var sx = X(cam.x), sy = Y(cam.y);
      g.strokeStyle = 'rgba(244,240,232,0.35)'; g.lineWidth = 1; g.setLineDash([3, 4]);
      g.beginPath(); g.arc(sx, sy, trustedRadius() * S, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(244,240,232,0.85)';
      g.beginPath(); g.arc(sx, sy, 4, 0, Math.PI * 2); g.fill();
    });
  }

  /* objects */
  placedObjects(p).forEach(function (o) {
    var sel = ui.sel === o.id;
    if (o.kind === 'outline') {
      var pts = o.pts || []; if (pts.length < 2) return;
      g.beginPath();
      pts.forEach(function (q, i) { i ? g.lineTo(X(q.x), Y(q.y)) : g.moveTo(X(q.x), Y(q.y)); });
      g.closePath();
      g.fillStyle = 'rgba(244,240,232,0.05)'; g.fill();
      g.strokeStyle = sel ? '#D4AF37' : 'rgba(244,240,232,0.6)'; g.lineWidth = sel ? 3 : 2; g.stroke();
    } else if (o.kind === 'point') {
      var q0 = (o.pts || [])[0]; if (!q0) return;
      var px = X(q0.x), py = Y(q0.y);
      g.strokeStyle = sel ? '#D4AF37' : '#6ED29A'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(px - 7, py); g.lineTo(px + 7, py); g.moveTo(px, py - 7); g.lineTo(px, py + 7); g.stroke();
      if (o.name) { g.fillStyle = 'rgba(110,210,154,0.9)'; g.font = '10px ui-monospace, monospace'; g.fillText(o.name, px + 9, py - 5); }
    } else {
      var poly = o.kind === 'cylinder' ? EE.circlePoly(o.cx, o.cy, o.r, 40) : EE.rectCorners(o);
      g.beginPath();
      poly.forEach(function (q, i) { i ? g.lineTo(X(q.x), Y(q.y)) : g.moveTo(X(q.x), Y(q.y)); });
      g.closePath();
      g.fillStyle = o.kind === 'cylinder' ? 'rgba(138,99,210,0.28)' : 'rgba(212,175,55,0.22)';
      g.fill();
      g.strokeStyle = sel ? '#F4F0E8' : (o.kind === 'cylinder' ? '#B79CE8' : '#D4AF37');
      g.lineWidth = sel ? 3 : 1.6; g.stroke();

      var ctr = o.kind === 'cylinder' ? { x: o.cx, y: o.cy } : { x: o.cx, y: o.cy };
      if (o.name && S > 3) {
        g.fillStyle = '#F4F0E8'; g.font = '600 11px -apple-system, system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(o.name, X(ctr.x), Y(ctr.y) + 3);
        if (o.h) {
          g.fillStyle = 'rgba(212,175,55,0.85)'; g.font = '10px ui-monospace, monospace';
          g.fillText(EE.fmtLen(o.h, U(), U() === 'ft' ? 1 : 2), X(ctr.x), Y(ctr.y) + 16);
        }
        g.textAlign = 'left';
      }
    }
  });

  /* north arrow */
  if (p.anchor) {
    var cxN = w - 34, cyN = 40;
    var a = -p.anchor.bearing * Math.PI / 180;   /* plan-up bearing -> screen angle of north */
    g.save(); g.translate(cxN, cyN); g.rotate(a);
    g.strokeStyle = '#D4AF37'; g.fillStyle = '#D4AF37'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, 14); g.lineTo(0, -14); g.stroke();
    g.beginPath(); g.moveTo(0, -18); g.lineTo(-5, -8); g.lineTo(5, -8); g.closePath(); g.fill();
    g.restore();
    g.fillStyle = 'rgba(212,175,55,0.9)'; g.font = '10px ui-monospace, monospace'; g.textAlign = 'center';
    g.fillText('N', cxN, cyN + 28); g.textAlign = 'left';
  }

  /* scale bar */
  var barM = step;
  var barPx = barM * S;
  var bx = 16, by = h - 26;
  g.strokeStyle = 'rgba(244,240,232,0.8)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + barPx, by);
  g.moveTo(bx, by - 4); g.lineTo(bx, by + 4);
  g.moveTo(bx + barPx, by - 4); g.lineTo(bx + barPx, by + 4); g.stroke();
  g.fillStyle = 'rgba(244,240,232,0.8)'; g.font = '10px ui-monospace, monospace';
  g.fillText(EE.fmtLen(barM, U(), U() === 'ft' ? 0 : (barM < 1 ? 2 : 0)), bx, by - 8);
}

/* ---------- scene (isometric) ---------- */
function paintScene() {
  var cv = $('#scene-canvas'); if (!cv) return;
  var p = currentProject(); if (!p) return;
  var c = fitCanvas(cv), g = c.g, w = c.w, h = c.h;
  g.fillStyle = '#08060C'; g.fillRect(0, 0, w, h);

  var objs = placedObjects(p);
  if (!objs.length) {
    g.fillStyle = 'rgba(244,240,232,0.35)'; g.font = '13px -apple-system, system-ui, sans-serif';
    g.textAlign = 'center'; g.fillText('Nothing traced yet.', w / 2, h / 2); g.textAlign = 'left';
    return;
  }

  var yaw = ui.scene.yaw, elev = ui.scene.elev;
  var cy_ = Math.cos(yaw), sy_ = Math.sin(yaw), se = Math.sin(elev), ce = Math.cos(elev);

  /* Orthographic: spin about the vertical, then tip. Depth is the rotated Y, so
     larger means further from the eye and must be painted first. */
  var proj = function (x, y, z) {
    var rx = x * cy_ - y * sy_, ry = x * sy_ + y * cy_;
    return { x: rx, y: -(ry * se) - z * ce, d: ry };
  };

  var all = [], xs = [], ys = [];
  objs.forEach(function (o) {
    var foot = o.kind === 'cylinder' ? EE.circlePoly(o.cx, o.cy, o.r, 20)
      : o.kind === 'rect' ? EE.rectCorners(o)
        : (o.pts || []);
    if (foot.length < 2) return;
    var hh = o.kind === 'outline' ? 0 : (o.h || 0);
    var pr = foot.map(function (q) { return proj(q.x, q.y, 0); });
    var pt = foot.map(function (q) { return proj(q.x, q.y, hh); });
    pr.concat(pt).forEach(function (q) { xs.push(q.x); ys.push(q.y); });
    var depth = pr.reduce(function (a, q) { return a + q.d; }, 0) / pr.length;
    all.push({ o: o, foot: foot, hh: hh, depth: depth });
  });
  if (!xs.length) return;

  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  var S = Math.min((w - 60) / Math.max(0.5, maxX - minX), (h - 80) / Math.max(0.5, maxY - minY));
  var offX = w / 2 - (minX + maxX) / 2 * S;
  var offY = h / 2 - (minY + maxY) / 2 * S;
  var P = function (x, y, z) { var q = proj(x, y, z); return { x: q.x * S + offX, y: q.y * S + offY, d: q.d }; };

  all.sort(function (a, b) { return b.depth - a.depth; });

  all.forEach(function (it) {
    var o = it.o, foot = it.foot, hh = it.hh;
    var isCyl = o.kind === 'cylinder';

    if (o.kind === 'outline') {
      g.beginPath();
      foot.forEach(function (q, i) { var s = P(q.x, q.y, 0); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); });
      g.closePath();
      g.fillStyle = 'rgba(244,240,232,0.05)'; g.fill();
      g.strokeStyle = 'rgba(244,240,232,0.5)'; g.lineWidth = 1.5; g.stroke();
      return;
    }
    if (o.kind === 'point') {
      var s0 = P(foot[0].x, foot[0].y, 0);
      g.strokeStyle = '#6ED29A'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(s0.x - 5, s0.y); g.lineTo(s0.x + 5, s0.y);
      g.moveTo(s0.x, s0.y - 5); g.lineTo(s0.x, s0.y + 5); g.stroke();
      return;
    }

    /* Side walls, near-face last so the silhouette stays clean. */
    var walls = [];
    for (var i = 0; i < foot.length; i++) {
      var a = foot[i], b = foot[(i + 1) % foot.length];
      var pa = P(a.x, a.y, 0), pb = P(b.x, b.y, 0);
      walls.push({ d: (pa.d + pb.d) / 2, a: a, b: b });
    }
    walls.sort(function (x, y) { return y.d - x.d; });
    walls.forEach(function (wl) {
      var a0 = P(wl.a.x, wl.a.y, 0), b0 = P(wl.b.x, wl.b.y, 0);
      var a1 = P(wl.a.x, wl.a.y, hh), b1 = P(wl.b.x, wl.b.y, hh);
      g.beginPath();
      g.moveTo(a0.x, a0.y); g.lineTo(b0.x, b0.y); g.lineTo(b1.x, b1.y); g.lineTo(a1.x, a1.y); g.closePath();
      g.fillStyle = isCyl ? 'rgba(88,62,138,0.85)' : 'rgba(120,94,32,0.9)';
      g.fill();
      if (!isCyl) { g.strokeStyle = 'rgba(12,10,16,0.5)'; g.lineWidth = 1; g.stroke(); }
    });

    g.beginPath();
    foot.forEach(function (q, i) { var s = P(q.x, q.y, hh); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); });
    g.closePath();
    g.fillStyle = isCyl ? 'rgba(183,156,232,0.95)' : 'rgba(212,175,55,0.95)';
    g.fill();
    g.strokeStyle = 'rgba(12,10,16,0.6)'; g.lineWidth = 1; g.stroke();

    if (o.name) {
      var ctr = P(o.cx != null ? o.cx : foot[0].x, o.cy != null ? o.cy : foot[0].y, hh);
      g.fillStyle = '#0C0A10'; g.font = '600 10px -apple-system, system-ui, sans-serif';
      g.textAlign = 'center'; g.fillText(o.name, ctr.x, ctr.y + 3); g.textAlign = 'left';
    }
  });
}

/* ---------- trace ---------- */
function traceView(st, w, h) {
  var t = ui.trace;
  if (!t.view) {
    var s = Math.min(w / st.imgW, h / st.imgH);
    t.view = { s: s, ox: (w - st.imgW * s) / 2, oy: (h - st.imgH * s) / 2, base: s };
  }
  return t.view;
}
function img2cv(v, p) { return { x: p.x * v.s + v.ox, y: p.y * v.s + v.oy }; }
function cv2img(v, p) { return { x: (p.x - v.ox) / v.s, y: (p.y - v.oy) / v.s }; }

function paintTrace() {
  var cv = $('#trace-canvas'); if (!cv) return;
  var p = currentProject(); var t = ui.trace; if (!p || !t) return;
  var st = findStation(p, t.stationId); if (!st) return;
  var im = ui.imgCache[st.id];
  var c = fitCanvas(cv), g = c.g, w = c.w, h = c.h;

  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  if (!im) {
    g.fillStyle = 'rgba(244,240,232,0.4)'; g.font = '13px -apple-system, system-ui, sans-serif';
    g.textAlign = 'center'; g.fillText('Loading photo…', w / 2, h / 2); g.textAlign = 'left';
    return;
  }

  var v = traceView(st, w, h);
  g.drawImage(im, v.ox, v.oy, st.imgW * v.s, st.imgH * v.s);

  var map = calMap(st);

  /* Metric grid warped back onto the photo. Nothing else tells you at a glance
     that a calibration is sound — if these squares do not sit flat and square on
     the roof, no number taken from this shot is worth having. */
  if (map && t.step === 'trace') {
    var span = 20, gs = 1;
    if (map.mode === 'quad') { span = Math.max(st.cal.refW, st.cal.refL) * 6; gs = span > 24 ? 2 : 1; }
    g.strokeStyle = 'rgba(110,210,154,0.35)'; g.lineWidth = 1;
    g.beginPath();
    for (var a = -span; a <= span; a += gs) {
      var seg = [];
      for (var b = -span; b <= span; b += gs / 2) {
        var q = map.toImg({ x: a, y: b }); seg.push(q);
      }
      strokePolyline(g, seg, v);
      seg = [];
      for (b = -span; b <= span; b += gs / 2) { seg.push(map.toImg({ x: b, y: a })); }
      strokePolyline(g, seg, v);
    }
    g.stroke();
  }

  /* already-traced shapes from this station */
  if (map && t.step === 'trace') {
    objectsOf(p, st.id).forEach(function (o) {
      var poly = o.kind === 'rect' ? EE.rectCorners(o)
        : o.kind === 'cylinder' ? EE.circlePoly(o.cx, o.cy, o.r, 32)
          : (o.pts || []);
      var img = poly.map(function (q) { return map.toImg(q); });
      g.strokeStyle = o.kind === 'point' ? 'rgba(110,210,154,0.95)' : 'rgba(212,175,55,0.95)';
      g.lineWidth = 2;
      if (o.kind === 'point') {
        var s0 = img[0]; if (!s0) return;
        var sp = img2cv(v, s0);
        g.beginPath(); g.moveTo(sp.x - 8, sp.y); g.lineTo(sp.x + 8, sp.y);
        g.moveTo(sp.x, sp.y - 8); g.lineTo(sp.x, sp.y + 8); g.stroke();
        if (o.name) { g.fillStyle = 'rgba(110,210,154,0.95)'; g.font = '11px ui-monospace, monospace'; g.fillText(o.name, sp.x + 10, sp.y - 6); }
      } else {
        g.beginPath(); strokePolyline(g, img.concat([img[0]]), v); g.stroke();
      }
    });
  }

  /* live taps */
  var pts = t.taps.map(function (q) { return img2cv(v, q); });
  if (pts.length > 1) {
    g.strokeStyle = '#D4AF37'; g.lineWidth = 2;
    g.beginPath();
    pts.forEach(function (q, i) { i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    var closes = (t.step === 'cal' && t.calMode === 'quad' && pts.length === 4) ||
      (t.step === 'trace' && (t.tool === 'rect' || t.tool === 'cylinder' || t.tool === 'outline') && pts.length >= 3);
    if (closes) g.closePath();
    g.stroke();
  }
  pts.forEach(function (q, i) {
    g.beginPath(); g.arc(q.x, q.y, 7, 0, Math.PI * 2);
    g.fillStyle = 'rgba(12,10,16,0.75)'; g.fill();
    g.strokeStyle = '#D4AF37'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#D4AF37'; g.font = '10px ui-monospace, monospace'; g.textAlign = 'center';
    g.fillText(String(i + 1), q.x, q.y + 3.5); g.textAlign = 'left';
  });

  /* preview of the shape the current taps would produce */
  if (t.step === 'trace' && map && t.taps.length >= 3 && (t.tool === 'rect' || t.tool === 'cylinder')) {
    var gpts = t.taps.map(function (q) { return map.toGround(q.x, q.y); }).filter(Boolean);
    if (gpts.length >= 3) {
      var shape = t.tool === 'rect' ? EE.fitOrientedRect(gpts) : EE.fitCircle(gpts);
      if (shape) {
        var outline = t.tool === 'rect' ? EE.rectCorners(shape) : EE.circlePoly(shape.cx, shape.cy, shape.r, 36);
        var imgPts = outline.map(function (q) { return map.toImg(q); });
        g.strokeStyle = '#6ED29A'; g.lineWidth = 2.5;
        g.beginPath(); strokePolyline(g, imgPts.concat([imgPts[0]]), v); g.stroke();

        var lbl = t.tool === 'rect'
          ? EE.fmtLen(shape.w, U()) + ' × ' + EE.fmtLen(shape.l, U())
          : 'Ø ' + EE.fmtLen(shape.r * 2, U());
        var mid = img2cv(v, map.toImg({ x: shape.cx, y: shape.cy }) || { x: 0, y: 0 });
        g.font = '600 13px ui-monospace, monospace';
        var tw = g.measureText(lbl).width;
        g.fillStyle = 'rgba(12,10,16,0.82)';
        g.fillRect(mid.x - tw / 2 - 7, mid.y - 11, tw + 14, 22);
        g.fillStyle = '#6ED29A'; g.textAlign = 'center';
        g.fillText(lbl, mid.x, mid.y + 4); g.textAlign = 'left';
      }
    }
  }

  /* live length readout while calibrating a scale bar */
  if (t.step === 'cal' && t.calMode === 'quad' && t.taps.length >= 2 && t.taps.length < 4) {
    var last = pts[pts.length - 1], prev = pts[pts.length - 2];
    g.strokeStyle = 'rgba(110,210,154,0.6)'; g.setLineDash([5, 4]); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(last.x, last.y); g.stroke(); g.setLineDash([]);
  }

  if (t.loupe) paintLoupe(st, im, v);
}

function strokePolyline(g, pts, v) {
  var started = false;
  for (var i = 0; i < pts.length; i++) {
    var q = pts[i];
    if (!q) { started = false; continue; }
    var s = img2cv(v, q);
    if (!isFinite(s.x) || !isFinite(s.y) || Math.abs(s.x) > 1e5 || Math.abs(s.y) > 1e5) { started = false; continue; }
    if (started) g.lineTo(s.x, s.y); else { g.moveTo(s.x, s.y); started = true; }
  }
}

/* A finger covers roughly a centimetre of roof at arm's length; the loupe is the
   difference between tapping a corner and tapping near one. */
function paintLoupe(st, im, v) {
  var t = ui.trace;
  var lc = $('#loupe-canvas'); if (!lc) return;
  var box = lc.getBoundingClientRect();
  var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  lc.width = Math.round(box.width * dpr); lc.height = Math.round(box.height * dpr);
  var g = lc.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  var zoom = 4;
  var half = box.width / (2 * zoom * v.s);
  var ip = t.loupe.img;
  g.fillStyle = '#000'; g.fillRect(0, 0, box.width, box.height);
  g.imageSmoothingEnabled = true;
  g.drawImage(im, ip.x - half, ip.y - half, half * 2, half * 2, 0, 0, box.width, box.height);
  g.strokeStyle = '#D4AF37'; g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(box.width / 2 - 14, box.height / 2); g.lineTo(box.width / 2 + 14, box.height / 2);
  g.moveTo(box.width / 2, box.height / 2 - 14); g.lineTo(box.width / 2, box.height / 2 + 14);
  g.stroke();
  g.strokeStyle = 'rgba(110,210,154,0.9)'; g.lineWidth = 1;
  g.beginPath(); g.arc(box.width / 2, box.height / 2, 3, 0, Math.PI * 2); g.stroke();
}

/* ================= pointer handling ================= */

/* One pinch/pan recogniser for the plan, the scene and the trace canvases. */
function attachGestures(el, opts) {
  var pts = {};
  var last = null;

  var pos = function (e) {
    var r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  var count = function () { return Object.keys(pts).length; };
  var centroid = function () {
    var k = Object.keys(pts), sx = 0, sy = 0;
    k.forEach(function (i) { sx += pts[i].x; sy += pts[i].y; });
    return { x: sx / k.length, y: sy / k.length };
  };
  var spread = function () {
    var k = Object.keys(pts);
    if (k.length < 2) return 0;
    return Math.hypot(pts[k[0]].x - pts[k[1]].x, pts[k[0]].y - pts[k[1]].y);
  };

  el.addEventListener('pointerdown', function (e) {
    el.setPointerCapture(e.pointerId);
    pts[e.pointerId] = pos(e);
    if (count() === 1 && opts.onDown) opts.onDown(pts[e.pointerId]);
    last = { c: centroid(), d: spread() };
  });
  el.addEventListener('pointermove', function (e) {
    if (!(e.pointerId in pts)) return;
    pts[e.pointerId] = pos(e);
    var c = centroid(), d = spread();
    if (count() === 1) {
      if (opts.onMove) opts.onMove(c, last ? { x: c.x - last.c.x, y: c.y - last.c.y } : { x: 0, y: 0 });
    } else if (count() >= 2 && last && last.d > 0) {
      if (opts.onPinch) opts.onPinch(c, { x: c.x - last.c.x, y: c.y - last.c.y }, d / last.d);
    }
    last = { c: c, d: d };
  });
  var end = function (e) {
    if (!(e.pointerId in pts)) return;
    var p = pts[e.pointerId];
    delete pts[e.pointerId];
    if (count() === 0) { if (opts.onUp) opts.onUp(p); last = null; }
    else last = { c: centroid(), d: spread() };
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (opts.onPinch) opts.onPinch(pos(e), { x: 0, y: 0 }, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
}

/* ================= binding ================= */

function bind() {
  var app = $('#app');

  app.onclick = function (e) {
    /* Every attribute handle() dispatches on has to be listed here or the row is
       silently inert — the delegated listener never sees it. */
    var el = e.target.closest('[data-act],[data-open],[data-tab],[data-tool],[data-calmode],' +
      '[data-unit],[data-nameunit],[data-geomethod],[data-srmethod],[data-menu],[data-object],' +
      '[data-station],[data-setheight],[data-chk]');
    if (!el) return;
    handle(el, e);
  };

  if (view.screen === 'capture') bindCapture();
  if (view.screen === 'live') bindLive();
  if (view.screen === 'trace') bindTrace();
  if (view.screen === 'project' && view.tab === 'plan') bindPlan();
  if (view.screen === 'project' && view.tab === 'scene') bindScene();

  if (ui.storageBytes == null) refreshStorage().then(function () {
    if (view.screen === 'project' && view.tab === 'export') render();
  });
}

function bindPlan() {
  var st = $('#stage-plan'); if (!st) return;
  var moved = false;
  attachGestures(st, {
    onDown: function () { moved = false; },
    onMove: function (c, d) {
      if (Math.abs(d.x) + Math.abs(d.y) > 1) moved = true;
      ui.plan.ox -= d.x / ui.plan.s; ui.plan.oy += d.y / ui.plan.s;
      paintPlan();
    },
    onPinch: function (c, d, k) {
      moved = true;
      ui.plan.s = clamp(ui.plan.s * k, 0.4, 400);
      ui.plan.ox -= d.x / ui.plan.s; ui.plan.oy += d.y / ui.plan.s;
      paintPlan();
    },
    onUp: function (p) { if (!moved) selectAt(p, st); }
  });
}

function selectAt(p, stageEl) {
  var proj = currentProject(); if (!proj) return;
  var r = stageEl.getBoundingClientRect();
  var wx = ui.plan.ox + (p.x - r.width / 2) / ui.plan.s;
  var wy = ui.plan.oy - (p.y - r.height / 2) / ui.plan.s;
  var best = null, bestD = Infinity;
  placedObjects(proj).forEach(function (o) {
    var d;
    if (o.kind === 'cylinder') d = Math.abs(Math.hypot(wx - o.cx, wy - o.cy) - o.r);
    else if (o.kind === 'rect') d = Math.hypot(wx - o.cx, wy - o.cy) - Math.max(o.w, o.l) / 2;
    else if (o.kind === 'point') d = Math.hypot(wx - (o.pts[0] || {}).x, wy - (o.pts[0] || {}).y);
    else return;
    if (d < bestD) { bestD = d; best = o; }
  });
  var tol = 22 / ui.plan.s;
  ui.sel = (best && bestD < tol) ? best.id : null;
  render();
}

function bindScene() {
  var st = $('#stage-scene'); if (!st) return;
  attachGestures(st, {
    onMove: function (c, d) {
      ui.scene.yaw += d.x * 0.008;
      ui.scene.elev = clamp(ui.scene.elev - d.y * 0.006, 0.12, 1.5);
      paintScene();
    }
  });
}

function bindCapture() {
  var v = $('#cam-video');
  if (!v || !ui.cap) return;
  if (ui.cap.stream) { v.srcObject = ui.cap.stream; return; }
  startCamera();
}

function bindLive() {
  var l = ui.live; if (!l) return;

  var sel = $('#live-station');
  if (sel) sel.onchange = function () { l.stationId = sel.value; paintLive(); };

  /* The slider must not re-render: innerHTML would tear down the <video> and
     restart the camera on every drag. */
  var yaw = $('#live-yaw');
  if (yaw) yaw.oninput = function () { l.yaw = parseFloat(yaw.value) || 0; paintLive(); };

  var v = $('#live-video');
  if (!v) return;
  if (l.stream) { v.srcObject = l.stream; v.onloadedmetadata = function () { paintLive(); }; return; }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    l.err = 'This browser exposes no camera. Open Eagle Eye over https in Safari.';
    return render();
  }
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false
  }).then(function (stream) {
    if (!ui.live) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    ui.live.stream = stream;
    var vv = $('#live-video');
    if (vv) { vv.srcObject = stream; vv.onloadedmetadata = function () { paintLive(); }; }
  }).catch(function (err) {
    if (!ui.live) return;
    ui.live.err = (err && err.name === 'NotAllowedError')
      ? 'Camera permission was declined. Allow it in Settings › Safari, then reopen.'
      : 'Could not open the camera: ' + (err && err.message ? err.message : 'unknown');
    render();
  });
}

function bindTrace() {
  var body = $('#trace-body'); if (!body) return;
  var t = ui.trace;
  var p = currentProject();
  var st = findStation(p, t.stationId);

  if (!ui.imgCache[st.id]) { loadImage(st).then(function () { paintTrace(); }); }

  var moved = false, downAt = null;
  attachGestures(body, {
    onDown: function (c) {
      moved = false; downAt = c;
      var cv = $('#trace-canvas'); if (!cv) return;
      var r = cv.getBoundingClientRect();
      var v = traceView(st, r.width, r.height);
      t.loupe = { at: c, img: cv2img(v, c) };
      showLoupe(c);
      paintTrace();
    },
    onMove: function (c, d) {
      if (!t.loupe) return;
      if (Math.abs(c.x - downAt.x) + Math.abs(c.y - downAt.y) > 3) moved = true;
      var cv = $('#trace-canvas'); if (!cv) return;
      var r = cv.getBoundingClientRect();
      var v = traceView(st, r.width, r.height);
      t.loupe = { at: c, img: cv2img(v, c) };
      showLoupe(c);
      paintTrace();
    },
    onPinch: function (c, d, k) {
      t.loupe = null; hideLoupe(); moved = true;
      var cv = $('#trace-canvas'); if (!cv) return;
      var r = cv.getBoundingClientRect();
      var v = traceView(st, r.width, r.height);
      var before = cv2img(v, c);
      v.s = clamp(v.s * k, v.base * 0.5, v.base * 14);
      v.ox = c.x - before.x * v.s + d.x;
      v.oy = c.y - before.y * v.s + d.y;
      paintTrace();
    },
    onUp: function () {
      if (t.loupe) {
        var ip = t.loupe.img;
        if (ip.x >= 0 && ip.y >= 0 && ip.x <= st.imgW && ip.y <= st.imgH) addTap(ip);
      }
      t.loupe = null; hideLoupe();
      render();
    }
  });
}

function showLoupe(c) {
  var body = $('#trace-body'); if (!body) return;
  var el = $('#loupe');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loupe'; el.className = 'loupe';
    el.innerHTML = '<canvas id="loupe-canvas"></canvas>';
    body.appendChild(el);
  }
  var r = body.getBoundingClientRect();
  /* Sit the loupe above the finger, and flip it below near the top edge. */
  var lx = clamp(c.x - 64, 6, r.width - 134);
  var ly = c.y - 158;
  if (ly < 6) ly = c.y + 34;
  el.style.left = lx + 'px'; el.style.top = ly + 'px';
}
function hideLoupe() { var el = $('#loupe'); if (el) el.remove(); }

function addTap(ip) {
  var t = ui.trace;
  var lim = t.step === 'cal' ? (t.calMode === 'quad' ? 4 : 2)
    : (t.tool === 'point' ? 1 : (t.tool === 'height' ? 2 : 64));
  if (t.taps.length >= lim) t.taps.shift();
  t.taps.push(ip);
}

/* ================= actions ================= */

function handle(el, e) {
  var p = currentProject();
  var act = el.dataset.act;

  if (el.dataset.open) { view.projectId = el.dataset.open; view.screen = 'project'; view.tab = 'plan'; ui.plan.fitted = false; ui.sel = null; return render(); }
  if (el.dataset.tab) { view.tab = el.dataset.tab; return render(); }
  if (el.dataset.tool) { ui.trace.tool = el.dataset.tool; ui.trace.taps = []; return render(); }
  if (el.dataset.calmode) { ui.trace.calMode = el.dataset.calmode; ui.trace.taps = []; return render(); }
  if (el.dataset.unit) { db.settings.unit = el.dataset.unit; save(); return render(); }
  if (el.dataset.nameunit) { db.settings.nameUnit = el.dataset.nameunit; save(); return render(); }
  if (el.dataset.geomethod) { ui.sheet.method = el.dataset.geomethod; return render(); }
  if (el.dataset.srmethod) { ui.sheet.method = el.dataset.srmethod; return render(); }
  if (el.dataset.station) return openStation(el.dataset.station);
  if (el.dataset.object) { ui.sel = el.dataset.object; ui.sheet = { kind: 'object', id: el.dataset.object }; return render(); }
  if (el.dataset.setheight) {
    var hv = $('#so-h'); if (hv) hv.value = parseFloat(el.dataset.setheight).toFixed(2);
    return;
  }
  if (el.dataset.menu) return runMenu(el.dataset.menu);
  if (el.dataset.chk) {
    var a = el.dataset.chk, id = el.dataset.chkid;
    if (a === 'tab') { view.tab = id; return render(); }
    if (a === 'capture') return openCapture();
    if (a === 'geo') { ui.sheet = { kind: 'geo', method: 'two' }; startGps(); return render(); }
    if (a === 'scale') { ui.sheet = { kind: 'scale' }; return render(); }
    if (a === 'place') { ui.sheet = { kind: 'place', id: id }; return render(); }
    if (a === 'object') { ui.sel = id; ui.sheet = { kind: 'object', id: id }; return render(); }
    if (a === 'station') return openStation(id);
    return;
  }

  switch (act) {
    case 'home': view.screen = 'home'; ui.sel = null; return render();
    case 'close-sheet': ui.sheet = null; return render();
    case 'settings': ui.sheet = { kind: 'settings' }; refreshStorage().then(render); return render();
    case 'new-project': ui.sheet = { kind: 'project' }; return render();
    case 'save-project': return saveProjectSheet();
    case 'project-menu':
      ui.sheet = {
        kind: 'menu', title: p.name, items: [
          { label: 'Rename / edit address', act: 'edit-project', cls: 'gold' },
          { label: 'Settings', act: 'settings', cls: '' },
          { label: 'Delete survey', act: 'del-project', cls: 'red' }
        ]
      };
      return render();

    case 'toggle-unit': db.settings.unit = U() === 'm' ? 'ft' : 'm'; save(); return render();
    case 'plan-fit': ui.plan.fitted = false; return render();
    case 'scene-spin': ui.scene.yaw += 0.35 * parseFloat(el.dataset.d); return paintScene();

    case 'capture': return openCapture();
    case 'close-capture': return closeCapture();
    case 'live': return openLive();
    case 'close-live': return closeLive();
    case 'live-coverage': ui.live.showCoverage = !ui.live.showCoverage; return render();
    case 'toggle-coverage': ui.showCoverage = !ui.showCoverage; return render();
    case 'error-sheet': ui.sheet = { kind: 'error' }; return render();
    case 'scale': ui.sheet = { kind: 'scale' }; return render();
    case 'save-scale': return saveScaleRef();
    case 'ask-motion': return startSensors().then(function (okd) {
      if (!okd) toast('Tilt sensor refused — use the rectangle route');
      render();
    });
    case 'shoot': return shoot();

    case 'close-trace': ui.trace = null; view.screen = 'project'; ui.plan.fitted = false; return render();
    case 'undo-tap': ui.trace.taps.pop(); return render();
    case 'apply-quad': return applyQuad();
    case 'apply-ray': return applyRay();
    case 'recal': ui.trace.step = 'cal'; ui.trace.taps = []; return render();
    case 'commit-shape': return commitShape();

    case 'edit-object': ui.sheet = { kind: 'object', id: el.dataset.id || ui.sel }; return render();
    case 'save-object': return saveObjectSheet();
    case 'delete-object': return deleteObject();
    case 'snap-dims': return snapDims();

    case 'geo-sheet': ui.sheet = { kind: 'geo', method: 'two' }; startGps(); return render();
    case 'apply-geo-two': return applyGeoTwo();
    case 'apply-geo-gps': return applyGeoGps();
    case 'apply-geo-manual': return applyGeoManual();

    case 'place-station': ui.sheet = { kind: 'place', id: el.dataset.id }; return render();
    case 'apply-place': return applyPlace();
    case 'retry-tie': {
      var stn = findStation(p, ui.sheet.id);
      stn.reg = null;
      var t = tryRegister(p, stn);
      save();
      toast(t ? 'Placed from ' + t.n + ' landmarks (±' + (t.rms * 100).toFixed(0) + ' cm)' : 'Still needs two matching landmark names');
      ui.sheet = null; ui.plan.fitted = false;
      return render();
    }

    case 'save-error': {
      var t2 = EE.toM(parseFloat($('#err-tol').value), U());
      var a2 = parseFloat($('#err-att').value);
      var d2 = EE.toM(parseFloat($('#err-deck').value), U());
      if (t2 > 0) db.settings.tolerance = t2;
      if (a2 > 0 && a2 < 30) db.settings.attSigma = a2;
      if (d2 >= 0) db.settings.deckUnc = d2;
      save(); ui.sheet = null;
      toast('Trusted radius now ' + EE.fmtLen(trustedRadius(), U(), 1));
      return render();
    }
    case 'save-settings': return saveSettings();
    case 'purge-photos': ui.sheet = { kind: 'confirm', title: 'Drop all photos?', body: 'Every measurement is kept. You lose only the ability to trace more from the shots already taken.', yes: 'Drop photos', on: 'purge' }; return render();
    case 'confirm-yes': return confirmYes();

    case 'export-kml': return exportKml();
    case 'export-kmz': return exportKmz();
    case 'save-lift': {
      var lv = EE.toM(parseFloat($('#lbl-lift').value), U());
      if (lv >= 0 && lv < 30) { db.settings.labelLift = lv; save(); toast('Labels float ' + EE.fmtLen(lv, U(), 2) + ' above'); }
      return render();
    }
    case 'export-csv': return exportCsv();
    case 'export-json': return exportJson();
  }
}

function runMenu(a) {
  var p = currentProject();
  if (a === 'edit-project') { ui.sheet = { kind: 'project', id: p.id, name: p.name, address: p.address }; return render(); }
  if (a === 'settings') { ui.sheet = { kind: 'settings' }; refreshStorage().then(render); return render(); }
  if (a === 'del-project') { ui.sheet = { kind: 'confirm', title: 'Delete ' + p.name + '?', body: 'Every shot, object and measurement in this survey goes with it.', yes: 'Delete survey', on: 'del-project' }; return render(); }
}

function confirmYes() {
  var s = ui.sheet, p = currentProject();
  if (s.on === 'purge') {
    var jobs = [];
    db.projects.forEach(function (pr) {
      pr.stations.forEach(function (st) { jobs.push(IDB.del(photoKey(st.id))); });
    });
    Promise.all(jobs).then(function () {
      ui.imgCache = {}; ui.urlCache = {};
      refreshStorage().then(function () { toast('Photos dropped'); render(); });
    });
    ui.sheet = null; return render();
  }
  if (s.on === 'del-project') {
    p.stations.forEach(function (st) { IDB.del(photoKey(st.id)); });
    db.projects = db.projects.filter(function (q) { return q.id !== p.id; });
    save();
    ui.sheet = null; view.screen = 'home'; return render();
  }
  ui.sheet = null; return render();
}

function saveProjectSheet() {
  var name = ($('#sp-name').value || '').trim();
  var addr = ($('#sp-addr').value || '').trim();
  if (!name) { toast('Give the survey a name'); return; }
  if (ui.sheet.id) {
    var p = db.projects.find(function (q) { return q.id === ui.sheet.id; });
    p.name = name; p.address = addr; touchProject(p);
  } else {
    var np = {
      id: uid('p'), name: name, address: addr,
      createdAt: Date.now(), updatedAt: Date.now(),
      anchor: null, anchorMeta: null, stations: [], objects: []
    };
    db.projects.push(np);
    view.projectId = np.id; view.screen = 'project'; view.tab = 'plan';
    ui.plan.fitted = false;
  }
  save(); ui.sheet = null; render();
}

function saveSettings() {
  var s = db.settings;
  var fov = parseFloat($('#set-fov').value);
  if (fov > 20 && fov < 140) s.fov = fov;
  var ch = parseFloat($('#set-camh').value);
  if (ch > 0) s.camH = EE.toM(ch, s.unit);
  var seg = parseInt($('#set-seg').value, 10);
  if (seg >= 6 && seg <= 128) s.circleSegments = seg;
  var mp = parseInt($('#set-maxpx').value, 10);
  if (mp >= 640 && mp <= 4032) s.maxPx = mp;
  save(); ui.sheet = null; toast('Settings saved'); render();
}

/* ---------- capture ---------- */
function openCapture() {
  ui.cap = { stream: null, ready: false, err: null };
  view.screen = 'capture';
  startGps();
  if (!needsMotionPermission()) startSensors();
  render();
}

function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    ui.cap.err = 'This browser exposes no camera. Open Eagle Eye over https in Safari.';
    return render();
  }
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false
  }).then(function (stream) {
    if (!ui.cap) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    ui.cap.stream = stream;
    var v = $('#cam-video');
    if (v) {
      v.srcObject = stream;
      v.onloadedmetadata = function () { ui.cap.ready = true; render(); };
    }
  }).catch(function (err) {
    ui.cap.err = (err && err.name === 'NotAllowedError')
      ? 'Camera permission was declined. Allow it in Settings › Safari, then reopen.'
      : 'Could not open the camera: ' + (err && err.message ? err.message : 'unknown');
    render();
  });
}

function openLive() {
  var p = currentProject();
  var st = p.stations.filter(function (s) { return s.reg && s.cal && s.cal.ok; })[0];
  if (!st) return toast('Calibrate and place a shot first');
  ui.live = { stationId: st.id, stream: null, err: null, yaw: 0, showCoverage: true };
  view.screen = 'live';
  if (!needsMotionPermission()) startSensors();
  render();
}

function closeLive() {
  if (ui.live && ui.live.stream) ui.live.stream.getTracks().forEach(function (t) { t.stop(); });
  ui.live = null;
  view.screen = 'project';
  render();
}

/* Scale rides on one measured distance, and which one it was matters as much as
   the number. A laser to the inside face of a far parapet is ~0.005%; a 2 m tape
   square is ~0.5%, and that 100x lands on every length and doubles on every area. */
function saveScaleRef() {
  var p = currentProject();
  var v = parseFloat(($('#sr-len') || {}).value);
  if (!(v > 0)) return toast('Enter the measured distance');
  var m = EE.toM(v, U());
  var method = (document.querySelector('.seg [data-srmethod].active') || {}).dataset;
  var sigma = { laser: 0.0015, tape: 0.01, paced: 0.25 }[(ui.sheet.method || 'laser')];
  p.scaleRef = {
    lengthM: m,
    method: ui.sheet.method || 'laser',
    note: (($('#sr-note') || {}).value || '').trim(),
    relSigma: sigma / m,
    at: Date.now()
  };
  touchProject(p); save();
  ui.sheet = null;
  toast('Scale reference: ' + EE.fmtLen(m, U()) + ' · ±' + (p.scaleRef.relSigma * 100).toFixed(3) + '%');
  render();
}

function closeCapture() {
  if (ui.cap && ui.cap.stream) ui.cap.stream.getTracks().forEach(function (t) { t.stop(); });
  ui.cap = null;
  stopGps();
  view.screen = 'project';
  render();
}

function shoot() {
  var p = currentProject();
  var v = $('#cam-video');
  if (!v || !v.videoWidth) return toast('Camera is not ready yet');

  var s = db.settings;
  var scale = Math.min(1, s.maxPx / Math.max(v.videoWidth, v.videoHeight));
  var W = Math.round(v.videoWidth * scale), H = Math.round(v.videoHeight * scale);
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.getContext('2d').drawImage(v, 0, 0, W, H);

  var st = {
    id: uid('s'), createdAt: Date.now(),
    imgW: W, imgH: H, screenAngle: screenAngle(),
    att: ui.sensors.live ? {
      alpha: ui.sensors.alpha, beta: ui.sensors.beta, gamma: ui.sensors.gamma,
      heading: ui.sensors.heading, headingAcc: ui.sensors.headingAcc
    } : null,
    gps: ui.gps ? Object.assign({}, ui.gps) : null,
    cal: null, reg: null
  };

  cv.toBlob(function (blob) {
    if (!blob) return toast('Could not save the frame');
    IDB.put(photoKey(st.id), blob).then(function () {
      p.stations.push(st);
      ensureOrigin(p);
      touchProject(p); save();
      refreshStorage();

      if (ui.cap && ui.cap.stream) ui.cap.stream.getTracks().forEach(function (t) { t.stop(); });
      ui.cap = null; stopGps();
      openTrace(st.id);
    });
  }, 'image/jpeg', s.jpegQ);
}

/* ---------- trace ---------- */
function openStation(id) {
  var p = currentProject();
  var st = findStation(p, id);
  if (!st) return;
  if (!st.reg && p.stations.length > 1) { ui.sheet = { kind: 'place', id: id }; return render(); }
  openTrace(id);
}

function openTrace(stationId) {
  var p = currentProject();
  var st = findStation(p, stationId);
  ui.trace = {
    stationId: stationId,
    step: st.cal && st.cal.ok ? 'trace' : 'cal',
    calMode: st.att ? 'quad' : 'quad',
    tool: 'rect',
    taps: [],
    view: null,
    loupe: null,
    refW: EE.fromM(2.4, U()).toFixed(2),
    refL: EE.fromM(1.2, U()).toFixed(2),
    knownLen: '',
    camH: EE.fromM(db.settings.camH, U()).toFixed(2)
  };
  view.screen = 'trace';
  render();
  loadImage(st).then(function () { paintTrace(); });
}

function applyQuad() {
  var p = currentProject(), t = ui.trace;
  var st = findStation(p, t.stationId);
  var w = EE.toM(parseFloat($('#ref-w').value), U());
  var l = EE.toM(parseFloat($('#ref-l').value), U());
  if (!(w > 0) || !(l > 0)) return toast('Enter both sides of the rectangle');

  var cal = calibrateQuad(st, t.taps.slice(0, 4), w, l);
  if (!cal.ok) return toast(cal.err);

  st.cal = cal;
  touchProject(p); save();

  /* A measured rectangle plus a recorded tilt is exactly what the lens needs, so
     take the free calibration while it is on offer. */
  var msg = 'Calibrated from ' + EE.fmtLen(w, U()) + ' × ' + EE.fmtLen(l, U());
  var f = solveFocal(st, t.taps.slice(0, 4), w, l);
  if (f && f.rms < 0.25) {
    db.settings.fov = f.fov;
    st.cal.f = EE.focalFromFov(f.fov, Math.max(st.imgW, st.imgH));
    save();
    msg += ' · lens solved at ' + f.fov.toFixed(1) + '°';
  }
  if (cal.poseRms != null && cal.poseRms > 0.3) {
    msg += ' · tilt looks off, heights may be unreliable';
  }
  toast(msg);

  t.step = 'trace'; t.taps = [];
  render();
}

function applyRay() {
  var p = currentProject(), t = ui.trace;
  var st = findStation(p, t.stationId);
  if (!st.att) return toast('This shot has no tilt recorded');

  var f = EE.focalFromFov(db.settings.fov, Math.max(st.imgW, st.imgH));
  var R = EE.rotFromOrientation(st.att.alpha, st.att.beta, st.att.gamma);
  var camH = EE.toM(parseFloat($('#cam-h').value), U());

  var knownEl = $('#known-len');
  if (t.taps.length >= 2 && knownEl) {
    var known = EE.toM(parseFloat(knownEl.value), U());
    if (known > 0) {
      var a = EE.rayForPixel(t.taps[0].x, t.taps[0].y, st.imgW, st.imgH, f, st.screenAngle);
      var b = EE.rayForPixel(t.taps[1].x, t.taps[1].y, st.imgW, st.imgH, f, st.screenAngle);
      var solved = EE.camHeightFromKnown(a, b, R, known);
      if (solved && solved > 0.2 && solved < 60) {
        camH = solved;
        toast('Camera height solved: ' + EE.fmtLen(camH, U()));
      } else {
        toast('Could not solve from those two taps — using the height you typed');
      }
    }
  }
  if (!(camH > 0)) return toast('Enter the camera height');

  st.cal = { mode: 'ray', camH: camH, f: f, ok: true };
  db.settings.camH = camH;
  touchProject(p); save();
  t.step = 'trace'; t.taps = [];
  render();
}

function commitShape() {
  var p = currentProject(), t = ui.trace;
  var st = findStation(p, t.stationId);
  var map = calMap(st);
  if (!map) return toast('Calibrate this shot first');

  if (t.tool === 'height') {
    var base = map.toGround(t.taps[0].x, t.taps[0].y);
    if (!base) return toast('That base point is above the horizon');
    var hgt = map.heightAt(base, t.taps[1].x, t.taps[1].y);
    if (!hgt || hgt <= 0) return toast('Could not measure that — the top must sit above the base');
    t.taps = [];
    toast('Height ' + EE.fmtLen(hgt, U()) + ' — tap an object to apply it');
    ui.lastHeight = hgt;
    return render();
  }

  var gpts = t.taps.map(function (q) { return map.toGround(q.x, q.y); }).filter(Boolean);
  if (gpts.length < (t.tool === 'point' ? 1 : 3)) return toast('Some taps fell above the horizon — trace nearer the camera');

  var o = { id: uid('o'), stationId: st.id, kind: t.tool, name: '', h: ui.lastHeight || 0, note: '' };
  if (t.tool === 'rect') {
    var r = EE.fitOrientedRect(gpts);
    if (!r) return toast('Those taps do not enclose an area');
    o.cx = r.cx; o.cy = r.cy; o.w = r.w; o.l = r.l; o.rot = r.rot;
    o.name = 'RTU-' + (p.objects.filter(function (q) { return q.kind === 'rect'; }).length + 1);
  } else if (t.tool === 'cylinder') {
    var c = EE.fitCircle(gpts);
    if (!c) return toast('Those taps do not describe a circle');
    o.cx = c.cx; o.cy = c.cy; o.r = c.r;
    o.name = 'Cyl-' + (p.objects.filter(function (q) { return q.kind === 'cylinder'; }).length + 1);
  } else {
    o.pts = gpts.map(function (q) { return { x: q.x, y: q.y }; });
    o.h = 0;
    o.name = t.tool === 'outline' ? 'Roof outline' : '';
  }

  p.objects.push(o);
  ui.lastHeight = 0;
  touchProject(p); save();
  t.taps = [];

  if (t.tool === 'point') {
    var reg = tryRegister(p, st);
    save();
    ui.sheet = { kind: 'object', id: o.id };
    if (reg) toast('Shot placed from ' + reg.n + ' landmarks · ±' + (reg.rms * 100).toFixed(0) + ' cm');
  } else {
    ui.sheet = { kind: 'object', id: o.id };
  }
  render();
}

function saveObjectSheet() {
  var p = currentProject();
  var o = p.objects.find(function (q) { return q.id === ui.sheet.id; });
  if (!o) return;
  var nameEl = $('#so-name');
  if (nameEl) o.name = nameEl.value.trim();
  var hEl = $('#so-h');
  if (hEl) { var hv = parseFloat(hEl.value); if (hv >= 0) o.h = EE.toM(hv, U()); }
  var nEl = $('#so-note'); if (nEl) o.note = nEl.value.trim();

  if (o.kind === 'rect') {
    var wv = parseFloat(($('#so-w') || {}).value), lv = parseFloat(($('#so-l') || {}).value);
    if (wv > 0) o.w = EE.toM(wv, U());
    if (lv > 0) o.l = EE.toM(lv, U());
  } else if (o.kind === 'cylinder') {
    var dv = parseFloat(($('#so-d') || {}).value);
    if (dv > 0) o.r = EE.toM(dv, U()) / 2;
  }

  /* A renamed landmark may be the second match a floating shot was waiting for. */
  if (o.kind === 'point') {
    p.stations.forEach(function (st) { if (!st.reg) tryRegister(p, st); });
  }

  touchProject(p); save();
  ui.sheet = null; ui.plan.fitted = false;
  render();
}

function snapDims() {
  var stepM = U() === 'ft' ? EE.M_PER_FT / 12 : 0.05;
  ['so-w', 'so-l', 'so-d'].forEach(function (id) {
    var el = $('#' + id); if (!el) return;
    var v = parseFloat(el.value); if (!(v > 0)) return;
    var m = EE.toM(v, U());
    el.value = EE.fromM(Math.round(m / stepM) * stepM, U()).toFixed(2);
  });
  toast('Rounded');
}

function deleteObject() {
  var p = currentProject();
  p.objects = p.objects.filter(function (q) { return q.id !== ui.sheet.id; });
  if (ui.sel === ui.sheet.id) ui.sel = null;
  touchProject(p); save();
  ui.sheet = null; ui.plan.fitted = false;
  render();
}

/* ---------- placement ---------- */
function applyPlace() {
  var p = currentProject();
  var st = findStation(p, ui.sheet.id);
  var rot = parseFloat($('#pl-rot').value) || 0;
  var tx = EE.toM(parseFloat($('#pl-x').value) || 0, U());
  var ty = EE.toM(parseFloat($('#pl-y').value) || 0, U());
  st.reg = { theta: rot * Math.PI / 180, tx: tx, ty: ty, rms: null, n: 0, method: 'manual' };
  touchProject(p); save();
  ui.sheet = null; ui.plan.fitted = false;
  render();
}

/* ---------- georeference ---------- */
/* Accepts what people actually paste.

   Right-clicking a spot in Google Maps copies decimal degrees, and that is the
   documented route. But degree symbols and N/S/E/W suffixes arrive too, and so
   does degrees-minutes-seconds. Reading only the first two numbers out of a DMS
   string would take 43°45'41"N and call it 43, 45 — a silently plausible
   coordinate on the wrong continent. So minutes and seconds are parsed rather
   than skipped past. */
var LL_COMPONENT = /(-?\d+(?:\.\d+)?)(?:\s*(\d+(?:\.\d+)?)\s*['′])?(?:\s*(\d+(?:\.\d+)?)\s*["″])?\s*([NSEWnsew])?/g;

function parseLL(s) {
  if (!s) return null;
  var t = String(s).replace(/[°º]/g, ' ').trim();
  if (!t) return null;

  LL_COMPONENT.lastIndex = 0;
  var parts = [], m;
  while (parts.length < 2 && (m = LL_COMPONENT.exec(t)) !== null) {
    if (!m[0].trim()) break;
    var v = Math.abs(parseFloat(m[1])) + (parseFloat(m[2]) || 0) / 60 + (parseFloat(m[3]) || 0) / 3600;
    var neg = m[1].charAt(0) === '-' || /[SsWw]/.test(m[4] || '');
    parts.push({ v: neg ? -v : v, hemi: (m[4] || '').toUpperCase() });
  }
  if (parts.length < 2) return null;

  var a = parts[0], b = parts[1];
  /* "79.5083 W, 43.7615 N" is the wrong way round but unambiguous — take it. */
  if (a.hemi === 'E' || a.hemi === 'W' || b.hemi === 'N' || b.hemi === 'S') {
    var t2 = a; a = b; b = t2;
  }
  if (!isFinite(a.v) || !isFinite(b.v)) return null;
  if (Math.abs(a.v) > 90 || Math.abs(b.v) > 180) return null;
  return { lat: a.v, lon: b.v };
}

function planPointOf(p, objId) {
  var o = p.objects.find(function (q) { return q.id === objId; });
  if (!o) return null;
  var po = projObj(p, o);
  return po && po.pts ? po.pts[0] : null;
}

function applyGeoTwo() {
  var p = currentProject();
  var aId = $('#ga-id').value, bId = $('#gb-id').value;
  if (aId === bId) return toast('Pick two different landmarks');
  var a = planPointOf(p, aId), b = planPointOf(p, bId);
  var lla = parseLL($('#ga-ll').value), llb = parseLL($('#gb-ll').value);
  if (!a || !b) return toast('Those landmarks are not placed yet');
  if (!lla || !llb) return toast('Enter both coordinates as "lat, lon"');

  var fit = EE.anchorFromTwoPoints(a, lla, b, llb);
  if (!fit) return toast('Those two points are too close together');

  p.anchor = fit.anchor;
  p.anchorMeta = { method: 'two landmarks', scaleError: fit.scaleError };
  touchProject(p); save();
  ui.sheet = null;
  var pct = (fit.scaleError * 100).toFixed(1);
  toast(Math.abs(fit.scaleError) < 0.02
    ? 'Located · scale agrees to ' + pct + '%'
    : 'Located · but the survey is ' + pct + '% off the map distance');
  render();
}

function applyGeoGps() {
  var p = currentProject();
  var g = ui.gps;
  if (!g) return toast('No GPS fix yet');
  var pt = planPointOf(p, $('#gg-id').value);
  if (!pt) return toast('That landmark is not placed yet');
  var br = parseFloat($('#gg-br').value) || 0;

  /* Back the anchor off so the chosen landmark lands on the fix. */
  var probe = { lat: g.lat, lon: g.lon, bearing: br };
  var off = EE.localToLatLon(pt, probe);
  p.anchor = { lat: g.lat - (off.lat - g.lat), lon: g.lon - (off.lon - g.lon), bearing: br };
  p.anchorMeta = { method: 'GPS ±' + g.acc.toFixed(0) + ' m', scaleError: null };
  touchProject(p); save();
  ui.sheet = null;
  toast('Located from GPS — ±' + g.acc.toFixed(0) + ' m');
  render();
}

function applyGeoManual() {
  var p = currentProject();
  var ll = parseLL($('#gm-ll').value);
  if (!ll) return toast('Enter the anchor as "lat, lon"');
  p.anchor = { lat: ll.lat, lon: ll.lon, bearing: parseFloat($('#gm-br').value) || 0 };
  p.anchorMeta = { method: 'manual', scaleError: null };
  touchProject(p); save();
  ui.sheet = null; toast('Located'); render();
}

/* ================= export ================= */

function deliver(filename, text, mime) {
  deliverBlob(filename, new Blob([text], { type: mime }));
}

function deliverBlob(filename, blob) {
  var file = null;
  var mime = blob.type || 'application/octet-stream';
  try { file = new File([blob], filename, { type: mime }); } catch (e) { /* older Safari */ }

  /* The iOS share sheet is the only route that reaches Files, Mail and AirDrop;
     a plain download link is the desktop fallback. */
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: filename }).catch(function () { downloadBlob(filename, blob); });
    return;
  }
  downloadBlob(filename, blob);
}
function downloadBlob(filename, blob) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  toast('Saved ' + filename);
}
function slug(s) { return String(s || 'survey').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase(); }

function exportKml() {
  var p = currentProject();
  if (!p.anchor) return toast('Locate the survey first');
  var placed = placedObjects(p).filter(function (o) { return o.kind !== 'point'; });
  if (!placed.length) return toast('Nothing placed to export');

  var kml = EE.buildKML({ name: p.name, address: p.address, anchor: p.anchor, objects: placed }, {
    unit: db.settings.nameUnit,
    nameTemplate: db.settings.nameTemplate,
    circleSegments: db.settings.circleSegments,
    labels: true,
    labelLift: db.settings.labelLift
  });
  if (!kml) return toast('Could not build the KML');
  deliver(slug(p.name) + '.kml', kml, 'application/vnd.google-earth.kml+xml');
}

function exportCsv() {
  var p = currentProject();
  var rows = [['name', 'type', 'width_m', 'length_m', 'diameter_m', 'height_m', 'rotation_deg', 'area_m2', 'note']];
  placedObjects(p).forEach(function (o) {
    if (o.kind === 'point') return;
    if (o.kind === 'rect') rows.push([o.name, 'rectangle', o.w.toFixed(3), o.l.toFixed(3), '', (o.h || 0).toFixed(3), (o.rot * 180 / Math.PI).toFixed(1), (o.w * o.l).toFixed(2), o.note || '']);
    else if (o.kind === 'cylinder') rows.push([o.name, 'cylinder', '', '', (o.r * 2).toFixed(3), (o.h || 0).toFixed(3), '', (Math.PI * o.r * o.r).toFixed(2), o.note || '']);
    else rows.push([o.name, 'outline', '', '', '', '', '', EE.polygonArea(o.pts || []).toFixed(2), o.note || '']);
  });
  var csv = rows.map(function (r) {
    return r.map(function (c) { return /[",\n]/.test(c) ? '"' + String(c).replace(/"/g, '""') + '"' : c; }).join(',');
  }).join('\n');
  deliver(slug(p.name) + '-schedule.csv', csv, 'text/csv');
}

/* ================= KMZ overlay =================

   A KMZ is a plain zip, so writing one needs no library — and STORE (no
   compression) is the right method here because the payload is a PNG, which is
   already deflated. Compressing it again would cost CPU on a phone to save
   nothing. */

var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(entries) {
  var enc = new TextEncoder();
  var parts = [], central = [], offset = 0;

  var dosTime = 0, dosDate = 0;
  (function () {
    var d = new Date();
    dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  })();

  entries.forEach(function (e) {
    var name = enc.encode(e.name);
    var data = e.data instanceof Uint8Array ? e.data : enc.encode(e.data);
    var crc = crc32(data);

    var lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);          /* version needed */
    lh.setUint16(6, 0, true);           /* flags */
    lh.setUint16(8, 0, true);           /* method 0 = store */
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);

    var ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + data.length;
  });

  var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
  var eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);

  return new Blob(parts.concat(central, [new Uint8Array(eocd.buffer)]),
    { type: 'application/vnd.google-earth.kmz' });
}

/* The traced plan as a north-up transparent raster, in east/north metres.

   Drawn in east/north rather than plan coordinates because a LatLonBox cannot be
   rotated safely, so the image itself has to carry the rotation. Colours are for
   an overlay on an AERIAL: magenta and cyan read on both pale concrete and dark
   membrane, and every mark carries a dark underlay. */
function renderPlanRaster(p) {
  var objs = placedObjects(p);
  if (!objs.length || !p.anchor) return null;

  var pts = [];
  objs.forEach(function (o) {
    var poly = o.kind === 'rect' ? EE.rectCorners(o)
      : o.kind === 'cylinder' ? EE.circlePoly(o.cx, o.cy, o.r, 32)
        : (o.pts || []);
    poly.forEach(function (q) { pts.push(EE.planToEastNorth(q, p.anchor)); });
  });
  if (!pts.length) return null;

  var pad = 4;
  var minE = Math.min.apply(null, pts.map(function (q) { return q.e; })) - pad;
  var maxE = Math.max.apply(null, pts.map(function (q) { return q.e; })) + pad;
  var minN = Math.min.apply(null, pts.map(function (q) { return q.n; })) - pad - 4;
  var maxN = Math.max.apply(null, pts.map(function (q) { return q.n; })) + pad;

  /* HelioScope publishes ~3600x2400 and under 10 MB as guidance, so the sampling
     is chosen to fit rather than fixed. */
  var wM = maxE - minE, hM = maxN - minN;
  var gsd = Math.max(0.01, Math.max(wM / 3400, hM / 2300));
  var W = Math.round(wM / gsd), H = Math.round(hM / gsd);

  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var g = cv.getContext('2d');
  var X = function (e) { return (e - minE) / gsd; };
  var Y = function (n) { return (maxN - n) / gsd; };
  var EN = function (q) { var a = EE.planToEastNorth(q, p.anchor); return { x: X(a.e), y: Y(a.n) }; };
  var s = Math.max(1, W / 1200);

  var stroked = function (text, x, y, col, px) {
    g.font = '600 ' + Math.round(px) + 'px -apple-system, system-ui, sans-serif';
    g.lineWidth = Math.max(3, px * 0.22); g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.lineJoin = 'round'; g.strokeText(text, x, y);
    g.fillStyle = col; g.fillText(text, x, y);
  };

  /* 5 m grid */
  g.strokeStyle = 'rgba(0,210,255,0.5)'; g.lineWidth = 2 * s;
  g.beginPath();
  for (var e0 = Math.ceil(minE / 5) * 5; e0 <= maxE; e0 += 5) { g.moveTo(X(e0), 0); g.lineTo(X(e0), H); }
  for (var n0 = Math.ceil(minN / 5) * 5; n0 <= maxN; n0 += 5) { g.moveTo(0, Y(n0)); g.lineTo(W, Y(n0)); }
  g.stroke();

  objs.forEach(function (o) {
    var poly = o.kind === 'rect' ? EE.rectCorners(o)
      : o.kind === 'cylinder' ? EE.circlePoly(o.cx, o.cy, o.r, 48)
        : (o.pts || []);
    if (poly.length < 2) return;
    var sc = poly.map(EN);

    g.beginPath();
    sc.forEach(function (q, i) { i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    g.closePath();

    if (o.kind === 'outline') {
      g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineWidth = 10 * s; g.stroke();
      g.strokeStyle = '#FF3DAE'; g.lineWidth = 5 * s; g.stroke();
      return;
    }
    if (o.kind === 'point') {
      var q0 = sc[0];
      g.strokeStyle = '#6ED29A'; g.lineWidth = 4 * s;
      g.beginPath();
      g.moveTo(q0.x - 12 * s, q0.y); g.lineTo(q0.x + 12 * s, q0.y);
      g.moveTo(q0.x, q0.y - 12 * s); g.lineTo(q0.x, q0.y + 12 * s); g.stroke();
      return;
    }
    /* Barely-there fill. This raster is a tracing base: the roof underneath has
       to stay visible, because the whole job is drawing HelioScope's own
       obstructions on top of it. A heavy fill hides the thing being traced. */
    g.fillStyle = 'rgba(212,175,55,0.16)'; g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineWidth = 7 * s; g.stroke();
    g.strokeStyle = '#E8C96A'; g.lineWidth = 3.5 * s; g.stroke();

    /* No name painted here. A label baked into the ground image is underneath
       everything the moment modules are placed over it, which is exactly the
       complaint. Names ride in the vector layer instead, floating above each
       object on a tether. */
  });

  /* Scale bar, alternating 5 m blocks — the one mark that has to be unambiguous
     on any background, and the thing to measure if the import is ever doubted. */
  var barM = 20, bx = X(minE + 2), by = Y(minN + 2.2), bw = barM / gsd, bh = 0.6 / gsd;
  for (var i = 0; i < 4; i++) {
    g.fillStyle = i % 2 === 0 ? '#FFFFFF' : '#000000';
    g.fillRect(bx + i * bw / 4, by, bw / 4, bh);
  }
  g.strokeStyle = '#000000'; g.lineWidth = 3 * s; g.strokeRect(bx, by, bw, bh);
  stroked(barM + '.000 m', bx, by - 10 * s, '#FFFFFF', 26 * s);

  /* North arrow — up, by construction */
  var ax = X(maxE - 3), ay = Y(maxN - 3);
  g.fillStyle = '#FFFFFF'; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 4 * s;
  g.beginPath();
  g.moveTo(ax, ay - 26 * s); g.lineTo(ax - 10 * s, ay + 12 * s); g.lineTo(ax + 10 * s, ay + 12 * s);
  g.closePath(); g.fill(); g.stroke();
  stroked('N', ax - 9 * s, ay + 42 * s, '#FFFFFF', 30 * s);

  stroked(p.name + '  —  ' + gsd.toFixed(3) + ' m/px  —  north up',
    8 * s, 30 * s, '#FFFFFF', 26 * s);

  return { canvas: cv, bounds: { minE: minE, maxE: maxE, minN: minN, maxN: maxN }, gsd: gsd, w: W, h: H };
}

function exportKmz() {
  var p = currentProject();
  if (!p.anchor) return toast('Locate the survey first');
  var r = renderPlanRaster(p);
  if (!r) return toast('Nothing placed to export');

  r.canvas.toBlob(function (png) {
    if (!png) return toast('Could not render the overlay');
    png.arrayBuffer().then(function (buf) {
      var box = EE.eastNorthBox(r.bounds, p.anchor);

      /* One archive, three layers, drawn in the order they are wanted:
         the flat tracing base, the 3D volumes standing on it, and the names
         floating clear of both. */
      var doc = EE.buildKML(
        {
          name: p.name, address: p.address, anchor: p.anchor,
          objects: placedObjects(p).filter(function (o) { return o.kind !== 'point'; })
        },
        {
          unit: db.settings.nameUnit,
          nameTemplate: db.settings.nameTemplate,
          circleSegments: db.settings.circleSegments,
          labels: true,
          labelLift: db.settings.labelLift,
          groundOverlay: EE.groundOverlayFragment(box, {
            name: p.name + ' — deck', href: 'files/plan.png'
          })
        });
      if (!doc) return toast('Could not build the KMZ');

      var blob = zipStore([
        { name: 'doc.kml', data: doc },
        { name: 'files/plan.png', data: new Uint8Array(buf) }
      ]);
      deliverBlob(slug(p.name) + '.kmz', blob);
      toast('KMZ · overlay + 3D + floating labels · ' + r.w + '×' + r.h);
    });
  }, 'image/png');
}

function exportJson() {
  var p = currentProject();
  deliver(slug(p.name) + '.json', JSON.stringify({ app: 'eagle-eye', version: VERSION, project: p }, null, 1), 'application/json');
}

/* ================= boot ================= */

window.addEventListener('resize', function () { paint(); });
if (screen.orientation && screen.orientation.addEventListener) {
  screen.orientation.addEventListener('change', function () { setTimeout(paint, 120); });
}

/* Sensors need no prompt on desktop and on Android, so attach immediately;
   iOS gets a button in the capture screen. */
if (!needsMotionPermission()) startSensors();

render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  });
}
