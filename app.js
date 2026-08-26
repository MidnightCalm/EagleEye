/* Eagle Eye — roof survey PWA.

   Photos and device attitude in, a metric plan and a HelioScope-ready KML out.
   The geometry lives in geo.js; this file is state, screens and interaction.

   Deliberately no LiDAR: the iPhone's depth sensor is a 940 nm emitter that a
   bright roof washes out, and its useful range stops well short of the far side
   of a warehouse. Photographs plus a known reference survive full sun. */
'use strict';

var VERSION = '1.21.0';
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
  cornerSnap: true,
  circleSegments: 24,
  maxPx: 1440,
  jpegQ: 0.72,

  /* The survey's declared error model. These three numbers decide the trusted
     radius of every standpoint, and therefore where coverage is green. */
  labelLift: 1.0,      /* metres a floating name hangs above its object */
  pitchTrim: 0,        /* degrees added to every sensor pitch — a per-device bias knob */
  rollTrim: 0,
  phoneW: 0.0716,      /* your handset, measured once — a table would only guess */
  phoneL: 0.1476,
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

/* Things you can calibrate against when there is no tape to hand.

   A bank card is the standout: ISO/IEC 7810 ID-1 fixes it at 85.60 x 53.98 mm
   worldwide, to a tighter tolerance than anything else in a pocket — and unlike a
   phone it needs no lookup and no trust in a spec sheet. All of them are SMALL
   though, which the quality readout will say plainly: a pocket reference is a
   rescue, not a plan. Measure your own phone once and it beats any table here. */
var REF_PRESETS = [
  { label: 'Card', w: 0.0540, l: 0.0856 },
  { label: 'A4 sheet', w: 0.2100, l: 0.2970 },
  { label: 'Letter', w: 0.2159, l: 0.2794 },
  { label: 'Phone', w: null, l: null },      /* filled from settings */
  { label: 'Paver', w: 0.6096, l: 0.6096 }
];

/* Below this many pixels on its shortest edge, a reference cannot pin the
   vanishing line down and its recovered lens is noise. One number, used
   everywhere a "big enough" judgement is made. */
var SMALL_REF_PX = 150;

var db = load();

/* ================= ephemeral state ================= */
var view = { screen: 'home', projectId: null, tab: 'plan' };
var ui = {
  cap: null,            /* live camera session */
  trace: null,          /* trace session */
  sheet: null,          /* modal sheet descriptor */
  toastTimer: null,
  sel: null,            /* selected object id, plan tab */
  swipe: null,          /* survey card whose delete tray is open */
  plan: { s: 12, ox: 0, oy: 0, fitted: false },
  scene: { yaw: 0.6, elev: 0.62 },
  imgCache: {},         /* stationId -> HTMLImageElement */
  urlCache: {},         /* stationId -> object URL, for thumbnails */
  level: null,          /* deck-levelling countdown in progress */
  levelTimer: null,
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

/* Haptics are a nicety and a policy minefield — blocked without a prior tap, and
   absent entirely on iOS Safari. Never let one abort the thing it was confirming. */
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* not important */ }
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

/* How far apart the copies of each named landmark currently sit — the honest
   "before" number for the global adjustment. */
function landmarkSpread(p) {
  var groups = {};
  tiePoints(p).forEach(function (k) {
    (groups[k.name] || (groups[k.name] = [])).push(k.pt);
  });
  var total = 0, n = 0;
  Object.keys(groups).forEach(function (nm) {
    var g = groups[nm];
    if (g.length < 2) return;
    var mx = 0, my = 0;
    g.forEach(function (q) { mx += q.x / g.length; my += q.y / g.length; });
    g.forEach(function (q) { total += (q.x - mx) * (q.x - mx) + (q.y - my) * (q.y - my); n++; });
  });
  return n ? Math.sqrt(total / n) : null;
}

/* Every pose and every landmark, solved TOGETHER.

   Shots are placed pairwise as they arrive, so each new tie inherits the error
   of the shot it tied to and the chain drifts. The global adjustment — the
   idea, if not the machinery, of global bundle adjustment — re-solves all the
   tied shots against all the shared landmarks at once. In 2D the similarity
   version is exactly linear (complex-number poses), so it needs no initial
   guess and cannot land in a local minimum; a few closed-form sweeps then
   tighten it to the app's rigid convention. Manually-placed shots and the
   origin stay put; only tie-placed shots move. */
function runAdjust(p, verbose) {
  var sts = [];
  p.stations.forEach(function (st) {
    if (!st.reg) return;
    var pts = objectsOf(p, st.id)
      .filter(function (o) { return o.kind === 'point' && o.name && o.pts && o.pts[0]; })
      .map(function (o) { return { name: o.name.trim().toLowerCase(), x: o.pts[0].x, y: o.pts[0].y }; });
    sts.push({ id: st.id, fixed: st.reg.method !== 'tie', pts: pts });
  });

  var before = landmarkSpread(p);
  var res = EE.adjust2D(sts);
  if (!res) {
    if (verbose) toast('Nothing to adjust yet — it needs two or more shots sharing named landmarks.');
    return null;
  }

  var moved = 0, scaleWorst = 0;
  p.stations.forEach(function (st) {
    var P = res.poses[st.id];
    if (!P || P.fixed || !st.reg || st.reg.method !== 'tie') return;
    st.reg.theta = P.theta; st.reg.tx = P.tx; st.reg.ty = P.ty;
    st.reg.adjusted = true;
    moved++;
    if (P.scaleLin) scaleWorst = Math.max(scaleWorst, Math.abs(P.scaleLin - 1));
  });
  if (!moved) { if (verbose) toast('Only one tied shot — nothing to redistribute yet.'); return null; }

  touchProject(p); save();
  coverageCache = { key: null, val: null };
  ui.plan.fitted = false;

  if (verbose || (before != null && before - res.rms > 0.01)) {
    var msg = 'Survey adjusted globally — ' + moved + ' shot' + (moved === 1 ? '' : 's') +
      ' and ' + res.nLandmarks + ' landmarks solved together. Landmark agreement ' +
      (before != null ? '±' + (before * 100).toFixed(0) + ' cm → ' : '') +
      '±' + (res.rms * 100).toFixed(0) + ' cm' +
      (res.worst && res.worst.spread > 0.25
        ? '. Worst is "' + esc(res.worst.name) + '" at ±' + (res.worst.spread * 100).toFixed(0) +
        ' cm — that landmark was likely tapped on different features in different shots'
        : '');
    if (scaleWorst > 0.05) {
      msg += '. One shot wants to be ' + (scaleWorst * 100).toFixed(0) +
        '% bigger than the rest — a calibration disagrees; see the scale check.';
    }
    toast(msg);
  }
  return res;
}

/* Worth running silently once three or more shots are tied together. */
function maybeAutoAdjust(p) {
  var tied = p.stations.filter(function (s) { return s.reg && s.reg.method === 'tie'; }).length;
  var placed = p.stations.filter(function (s) { return !!s.reg; }).length;
  if (tied >= 2 && placed >= 3) runAdjust(p, false);
}

/* ================= calibration ================= */

/* One interface over the two mapping engines, so every caller — the grid
   overlay, the tap handler, the shape painter — is written once. */
function calMap(st) {
  var c = st && st.cal;
  if (!c || !c.ok) return null;
  var R = st.att ? attMatrix(st.att) : null;

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
        var ray = EE.rayForPixel(topPx, topPy, st.imgW, st.imgH, c.f, effAngle(st));
        /* heightFromBaseTop works in the ray frame, whose origin sits under the
           camera; basePt arrives in the reference-rectangle frame.

           The pose was fitted against ray points evaluated at a nominal 1 m, so
           its inverse lands back in that unit-height frame. Multiplying by the
           pose scale — which is the camera height — restores true metres, which
           is the frame the camera height passed alongside it refers to. */
        var inv = EE.applySimilarityInverse(c.pose, basePt);
        var b = { x: inv.x * c.pose.scale, y: inv.y * c.pose.scale };
        return EE.heightFromBaseTop(b, ray, R, c.pose.scale, deckNormalOf(st));
      }
    };
  }

  if (!R) return null;
  return {
    mode: 'ray',
    has3D: true,
    toGround: function (px, py, planeZ) {
      return EE.groundPoint(EE.rayForPixel(px, py, st.imgW, st.imgH, c.f, effAngle(st)), R, c.camH, planeZ || 0, deckNormalOf(st));
    },
    toImg: function (g, planeZ) {
      return EE.projectToPixel(g, R, c.camH, st.imgW, st.imgH, c.f, effAngle(st), planeZ || 0, deckNormalOf(st));
    },
    heightAt: function (basePt, topPx, topPy) {
      var ray = EE.rayForPixel(topPx, topPy, st.imgW, st.imgH, c.f, effAngle(st));
      return EE.heightFromBaseTop(basePt, ray, R, c.camH, deckNormalOf(st));
    }
  };
}

/* Solves a quad calibration and, where attitude is available, recovers the
   camera pose alongside it so the height tool keeps working.

   The pose comes from fitting the ray model (evaluated at a nominal 1 m) onto
   the same four reference corners: the similarity scale of that fit IS the
   camera height, and its residual says whether the tilt can be trusted. */
/* Which tapped edge is which physical dimension.

   The old fields asked for "width (first edge)" and "length (second edge)", which
   silently required the tap order to match the order the numbers were typed. Tap
   a bank card starting along its LONG side while the fields say 54 mm then
   85.6 mm, and the plane is told the image is 1.59x squashed in one axis. The
   quad still looks perfect on the photo — every corner is exactly where it was
   put — while the vanishing line, and therefore everything measured from it, is
   wrong. A real 0.5 m square then traces as 0.35 x 0.52.

   Nothing about that is the user's mistake to make. The projected edges already
   say which is longer, so assign the longer real dimension to the longer tapped
   edge and show the result. A rectangle would have to be viewed at an extreme
   angle for the projection to invert the order, and the swap control covers it. */
function assignRefEdges(quadPix, a, b, swap) {
  var d = function (p, q) { return Math.hypot(q.x - p.x, q.y - p.y); };
  var e1 = d(quadPix[0], quadPix[1]);      /* the "first" edge, 1 -> 2 */
  var e2 = d(quadPix[1], quadPix[2]);      /* the "second" edge, 2 -> 3 */
  var lo = Math.min(a, b), hi = Math.max(a, b);
  var firstIsLong = e1 >= e2;
  if (swap) firstIsLong = !firstIsLong;
  return {
    first: firstIsLong ? hi : lo,
    second: firstIsLong ? lo : hi,
    e1: e1, e2: e2, firstIsLong: firstIsLong,
    projAspect: e2 > 0 ? e1 / e2 : Infinity,
    realAspect: lo > 0 ? hi / lo : Infinity
  };
}

function calibrateQuad(st, quadPix, refW, refL) {
  var ref = EE.rectRefCorners(refW, refL);
  var H = EE.homographyFromQuad(quadPix, ref);
  if (!H) return { ok: false, err: 'Those four points do not form a usable quad — retake them further apart.' };

  var cal = { mode: 'quad', H: H, quadPix: quadPix, refW: refW, refL: refL, f: stationF(st), ok: true };

  /* The lens, straight out of the same four corners. No attitude, no search.
     Whatever Safari actually handed us — main, ultra-wide, cropped — this is its
     real focal length, and it replaces the assumed field of view that governs
     every tilt-and-height measurement. */
  cal.focal = EE.focalFromHomography(H, st.imgW, st.imgH);
  if (cal.focal) {
    cal.fovMeasured = EE.fovFromFocalLong(cal.focal.f, Math.max(st.imgW, st.imgH));
    cal.f = cal.focal.f;
  }

  if (st.att) {
    var R = attMatrix(st.att);
    var unit = quadPix.map(function (q) {
      return EE.groundPoint(EE.rayForPixel(q.x, q.y, st.imgW, st.imgH, cal.f, effAngle(st)), R, 1, 0, deckNormalOf(st));
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

/* An N-cornered planar reference — the hexagon path. Same contract as
   calibrateQuad, plus the thing four corners can never give: a residual. Four
   points always fit a homography exactly, so they cannot criticise themselves;
   a fifth and sixth disagree by exactly what the taps and the print are wrong,
   and that number is reported instead of hidden. */
function calibratePlanar(st, imgPts, refPts, refW, refL) {
  var H = EE.homographyFromPoints(imgPts, refPts);
  if (!H) return { ok: false, err: 'Those corners do not form a usable shape — retake them, spread apart.' };

  var cal = { mode: 'quad', H: H, quadPix: imgPts.slice(), refW: refW, refL: refL, f: stationF(st), ok: true };
  var res = EE.homographyResidual(H, imgPts, refPts);
  if (res) cal.planarRms = res.rms;

  cal.focal = EE.focalFromHomography(H, st.imgW, st.imgH);
  if (cal.focal) {
    cal.fovMeasured = EE.fovFromFocalLong(cal.focal.f, Math.max(st.imgW, st.imgH));
    cal.f = cal.focal.f;
  }

  if (st.att) {
    var R = attMatrix(st.att);
    var unit2 = imgPts.map(function (q) {
      return EE.groundPoint(EE.rayForPixel(q.x, q.y, st.imgW, st.imgH, cal.f, effAngle(st)), R, 1, 0, deckNormalOf(st));
    });
    if (unit2.every(Boolean)) {
      var fit2 = EE.similarity2D(unit2, refPts);
      if (fit2 && fit2.scale > 0.2 && fit2.scale < 30) {
        cal.pose = fit2;
        cal.camH = fit2.scale;
        cal.poseRms = fit2.rms;
      }
    }
  }
  return cal;
}

/* Write a measured lens into settings — shared by every planar calibration.
   Only from a reference big enough to mean it, and only when the two
   independent focal estimates agree. */
function adoptMeasuredLens(st, cal, q0) {
  if (cal.fovMeasured && q0 && q0.minSpanPx >= SMALL_REF_PX &&
    (cal.focal.disagree == null || cal.focal.disagree < 0.06)) {
    db.settings.fov = cal.fovMeasured;
    db.settings.fovFrom = (st.cam && st.cam.label) || 'this camera';
    db.settings.fovAt = Date.now();
    (db.settings.fovByFrame || (db.settings.fovByFrame = {}))[st.imgW + 'x' + st.imgH] = cal.fovMeasured;
    save();
    return ' · lens measured at ' + cal.fovMeasured.toFixed(1) + '°';
  }
  if (cal.fovMeasured) return ' · lens reads ' + cal.fovMeasured.toFixed(1) + '°, reference too small to trust it';
  return '';
}

/* Calibrate a shot straight from an aerial.

   The longest reference on any site is the roof itself, and it is already
   measured — by whoever flew the imagery. Tapping four points in the photo and
   pasting their coordinates solves the same plane homography a tape-measured
   rectangle would, over a baseline of tens of metres instead of a couple. It
   needs no tape, no camera height, no tilt and no lens data, and because the
   reference frame IS east/north the survey lands georeferenced with bearing 0.

   The honest caveats, both real:

   - Read error. Google's aerial runs about 0.15 m/px in town, so a corner is
     good to roughly half a metre. Over 40 m that is ~1%, which is comparable to
     a well-tapped 2.4 m kerb — the long baseline is doing the work.
   - Building lean. An orthophoto is rectified to the GROUND, so a roof h above it
     is thrown outward from the image nadir. Across a roof of extent L the
     differential is about h.L/H for flying height H: a 10 m building, 40 m
     across, shot from 600 m, distorts by ~0.7 m end to end. Satellite imagery is
     nearly immune (H is hundreds of km) but coarser per pixel.

   The lean also shifts the whole roof sideways from its true ground position —
   which for this purpose is a feature, since the layout tool draws on the same
   kind of imagery and inherits the same shift. */
function calibrateFromMap(st, pixPts, lls) {
  if (!pixPts || pixPts.length < 4 || !lls || lls.length < 4) {
    return { ok: false, err: 'Four points with coordinates are needed.' };
  }
  var origin = lls[0];
  var ground = lls.map(function (ll) {
    var en = EE.latLonToEastNorth(ll, origin);
    return { x: en.e, y: en.n };
  });

  var spread = 0;
  for (var i = 0; i < ground.length; i++) {
    for (var j = i + 1; j < ground.length; j++) {
      spread = Math.max(spread, Math.hypot(ground[i].x - ground[j].x, ground[i].y - ground[j].y));
    }
  }
  if (spread < 2) return { ok: false, err: 'Those points are within ' + spread.toFixed(1) + ' m of each other — spread them across the roof.' };

  var H = EE.homographyFromQuad(pixPts.slice(0, 4), ground.slice(0, 4));
  if (!H) return { ok: false, err: 'Those four points do not form a usable quad — avoid a straight line.' };

  var cal = {
    mode: 'quad', H: H, quadPix: pixPts.slice(0, 4),
    refW: spread, refL: spread,
    f: stationF(st),
    ok: true, source: 'map', originLL: origin, spread: spread
  };

  /* A fifth correspondence is the first thing that can disagree — four always
     fit exactly, so four tell you nothing about their own quality. */
  if (pixPts.length > 4 && lls.length > 4) {
    var res = EE.homographyResidual(H, pixPts.slice(4), ground.slice(4));
    if (res) cal.mapCheck = res;
  }

  /* Recover the camera pose the same way the tape route does, so the height tool
     and the coverage model keep working. */
  if (st.att) {
    var R = attMatrix(st.att);
    var unit = cal.quadPix.map(function (q) {
      return EE.groundPoint(EE.rayForPixel(q.x, q.y, st.imgW, st.imgH, cal.f, effAngle(st)),
        R, 1, 0, deckNormalOf(st));
    });
    if (unit.every(Boolean)) {
      var fit = EE.similarity2D(unit, ground.slice(0, 4));
      if (fit && fit.scale > 0.2 && fit.scale < 30) {
        cal.pose = fit; cal.camH = fit.scale; cal.poseRms = fit.rms;
      }
    }
  }
  return cal;
}


/* ================= the deck plane =================

   Gravity says where flat is; nothing else in the app can. Capturing it fixes the
   two homography terms that ARE the vanishing line — the pair a small reference
   like a bank card cannot pin down. After this, the card only has to supply a
   length, which is the one thing it is good at.

   Face-down is the better placement (the camera bump lifts a face-up phone by a
   degree or so) but you cannot read the screen, so it runs on a countdown and
   verifies the phone was actually still. */
function levelSamples() {
  var l = ui.level;
  if (!l || !l.samples.length) return null;
  var qs = l.samples.map(function (s) { return EE.quatFromOrientation(s.a, s.b, s.g); });
  var ref = qs[0], spread = 0;
  qs.forEach(function (q) { spread = Math.max(spread, EE.quatAngleDeg(ref, q)); });
  var mid = l.samples[Math.floor(l.samples.length / 2)];
  return { att: mid, spreadDeg: spread, n: qs.length };
}

/* Waits for the phone to be still, rather than counting down at it.

   A countdown is a guess about how long it takes to put a phone down, and it is
   wrong in both directions — it fires while you are still moving, or it makes you
   wait after you have finished. Stillness is the thing that actually matters, so
   watch for it: once the attitude has held within a fraction of a degree for a
   second and a half, take the reading. */
/* Gravity seen from inside the phone, raw — the bias must not be pre-corrected
   when the point is to measure it. */
function gravityDev(a, b, g2) {
  return EE.applyM3(EE.transpose3(EE.rotFromOrientation(a, b, g2)), [0, 0, -1]);
}

/* The sensor check: read the deck, spin the phone half a turn flat, read again.
   The true deck slope reverses in the device frame under the spin; a sensor bias
   does not. Half the sum is the bias, half the difference is the slope — the
   same trick Apple's Measure uses to calibrate, and the reason its level asks
   you to flip the phone. Sets the trims from measurement instead of eyeballing,
   and stores the bias-free deck plane. */
function finishFlipCheck(l, mid, now) {
  var p = currentProject();
  var g1 = l.phase1.gdev, g2v = gravityDev(mid.a, mid.b, mid.g);
  var bias = [(g1[0] + g2v[0]) / 2, (g1[1] + g2v[1]) / 2];

  /* Convert the device-frame gravity bias into Euler trims numerically, at the
     phase-1 attitude — convention-proof, no small-angle sign gymnastics. */
  var a1 = l.phase1.att;
  var base = gravityDev(a1.a, a1.b, a1.g);
  var hstep = 0.25;
  var db1 = gravityDev(a1.a, a1.b + hstep, a1.g);
  var dg1 = gravityDev(a1.a, a1.b, a1.g + hstep);
  var J = [(db1[0] - base[0]) / hstep, (dg1[0] - base[0]) / hstep,
           (db1[1] - base[1]) / hstep, (dg1[1] - base[1]) / hstep];
  var det = J[0] * J[3] - J[1] * J[2];
  if (Math.abs(det) < 1e-9) { toast('Sensor check failed to solve — try again'); return false; }
  var dBeta = (J[3] * bias[0] - J[1] * bias[1]) / det;
  var dGamma = (-J[2] * bias[0] + J[0] * bias[1]) / det;

  var biasTilt = Math.hypot(dBeta, dGamma);
  if (biasTilt > 8) {
    toast('Sensor check read a ' + biasTilt.toFixed(1) + '° bias — that is beyond any normal sensor. Check for a magnetic case, and retry on a truly still surface.');
    return false;
  }

  db.settings.pitchTrim = +(-dBeta).toFixed(2);
  db.settings.rollTrim = +(-dGamma).toFixed(2);
  db.settings.biasMeasured = { p: +dBeta.toFixed(2), r: +dGamma.toFixed(2), at: now };

  /* The deck plane, with the bias removed: recompute the phase-1 reading through
     the freshly set trims — exactly the path every future shot will use. */
  p.deck = {
    n: EE.normalFromAttitude(a1.a, a1.b + db.settings.pitchTrim,
      a1.g + db.settings.rollTrim, l.faceDown),
    faceDown: l.faceDown, spreadDeg: l.spread || 0, at: now, checked: true
  };
  p.deck.tiltDeg = EE.deckTiltDeg(p.deck.n);
  touchProject(p); save();
  buzz([40, 60, 40, 60, 40]);
  toast('Sensor bias ' + fmtSigned(dBeta) + '° pitch, ' + fmtSigned(dGamma) +
    '° roll — trims set. Deck ' + p.deck.tiltDeg.toFixed(2) + '° off level.');
  return true;
}

function startLevel(faceDown, check) {
  var go = function () {
    clearInterval(ui.levelTimer);
    ui.level = { faceDown: !!faceDown, check: !!check, phase: 1, phase1: null,
      samples: [], started: Date.now(), spread: null, held: 0 };
    ui.levelTimer = setInterval(tickLevel, 100);
    render();
  };
  /* The button press IS the user gesture iOS requires, so ask here rather than
     making someone open the camera just to get the prompt. */
  if (!ui.sensors.live) {
    startSensors().then(function (granted) {
      if (!granted || !ui.sensors.live) {
        return toast('Motion access is needed to read the deck — allow it and tap again');
      }
      go();
    });
    return;
  }
  go();
}

var LEVEL_WINDOW = 1500;   /* ms of stillness required */
var LEVEL_SPREAD = 0.8;    /* degrees of wobble tolerated within it */

function tickLevel() {
  var l = ui.level;
  if (!l) { clearInterval(ui.levelTimer); return; }

  var now = Date.now();
  l.samples.push({
    q: EE.quatFromOrientation(ui.sensors.alpha, ui.sensors.beta, ui.sensors.gamma),
    a: ui.sensors.alpha, b: ui.sensors.beta, g: ui.sensors.gamma, t: now
  });
  while (l.samples.length && l.samples[0].t < now - LEVEL_WINDOW) l.samples.shift();

  var spread = 0;
  for (var i = 1; i < l.samples.length; i++) {
    spread = Math.max(spread, EE.quatAngleDeg(l.samples[0].q, l.samples[i].q));
  }
  l.spread = spread;
  var span = l.samples.length > 1 ? l.samples[l.samples.length - 1].t - l.samples[0].t : 0;
  l.held = (spread < LEVEL_SPREAD) ? span : 0;

  if (l.samples.length >= 8 && span >= LEVEL_WINDOW - 150 && spread < LEVEL_SPREAD) {
    var mid = l.samples[Math.floor(l.samples.length / 2)];

    if (l.check && l.phase === 1) {
      /* Phase one banked; now the half-turn. Accept phase two only once the yaw
         has actually moved ~180°, so putting it down unturned cannot pass. */
      l.phase1 = { att: mid, gdev: gravityDev(mid.a, mid.b, mid.g) };
      l.phase = 2; l.samples = []; l.started = now; l.held = 0;
      buzz([30, 50, 30]);
      paintLevelHud();
      return;
    }
    if (l.check && l.phase === 2) {
      var da = ((mid.a - l.phase1.att.a + 540) % 360) - 180;
      if (Math.abs(da) < 140) {
        /* still, but not spun — keep waiting */
        l.samples = []; l.held = 0;
        paintLevelHud();
        return;
      }
      clearInterval(ui.levelTimer);
      l.spread = spread;
      var okd = finishFlipCheck(l, mid, now);
      ui.level = null;
      render();
      return;
    }

    clearInterval(ui.levelTimer);
    var p = currentProject();
    p.deck = {
      n: EE.normalFromAttitude(mid.a, mid.b + (db.settings.pitchTrim || 0),
        mid.g + (db.settings.rollTrim || 0), l.faceDown),
      faceDown: l.faceDown, spreadDeg: spread, at: now
    };
    p.deck.tiltDeg = EE.deckTiltDeg(p.deck.n);
    touchProject(p); save();
    ui.level = null;
    buzz([40, 60, 40]);
    toast('Deck read: ' + p.deck.tiltDeg.toFixed(2) + '° off level');
    render();
    return;
  }

  if (now - l.started > 45000) {
    clearInterval(ui.levelTimer);
    ui.level = null;
    toast('Gave up waiting for it to settle — try resting it on something flat');
    render();
    return;
  }
  paintLevelHud();
}

/* Patched in place rather than re-rendered: this runs ten times a second. */
function paintLevelHud() {
  var l = ui.level; if (!l) return;
  var bar = $('#level-bar'), txt = $('#level-txt');
  if (bar) bar.style.width = Math.min(100, l.held / LEVEL_WINDOW * 100) + '%';
  if (txt) {
    if (l.check && l.phase === 2) {
      txt.textContent = 'now SPIN it half a turn, flat, same spot — then let it settle';
    } else {
      txt.textContent = l.spread == null ? 'waiting for the sensor…'
        : l.spread < LEVEL_SPREAD ? 'holding still — ' + (l.held / 1000).toFixed(1) + ' s'
          : 'still moving — ' + l.spread.toFixed(1) + '°';
    }
  }
}

/* The normal a shot should be measured against.

   A multi-ball calibration stores the plane it measured in the DEVICE frame
   (cal.deckDev) and it is converted to world coordinates here, freshly, through
   the same attMatrix the homography build uses. That makes the attitude cancel
   exactly: the plane-in-camera the geometry actually consumes is the one the
   balls measured, however wrong the sensor was and however the trims change
   later. Storing a world normal instead would freeze today's attitude error
   into the plane. */
function deckNormalOf(st) {
  if (st && st.cal && st.cal.deckDev && st.att) {
    return EE.applyM3(attMatrix(st.att), st.cal.deckDev);
  }
  return (st && st.deckN) || null;
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
/* The honest radius of a standpoint, from the height that shot ACTUALLY used.

   This took the global setting for everything, which put the dashed ring on the
   plan and the colour inside it on two different heights — a shot taken at 3 m on
   a pole got a ring sized for a 1.55 m default. The setting is only a starting
   guess for a shot that does not exist yet; a real shot knows its own height. */
function trustedRadius(camH) {
  var h = camH > 0 ? camH : db.settings.camH;
  return EE.maxTrustedRange(h, attSigmaRad(), db.settings.tolerance, db.settings.deckUnc);
}

/* A representative height for headline figures: what the survey actually used. */
function typicalCamH(p) {
  var hs = [];
  (p ? p.stations : []).forEach(function (st) {
    if (st.cal && st.cal.ok && st.cal.camH > 0) hs.push(st.cal.camH);
  });
  if (!hs.length) return db.settings.camH;
  hs.sort(function (a, b) { return a - b; });
  return hs[Math.floor(hs.length / 2)];
}

/* The ground-plane homography for a station, whichever way it was calibrated. */
function stationH(st) {
  var c = st && st.cal;
  if (!c || !c.ok) return null;
  if (c.mode === 'quad') return c.H;
  if (!st.att) return null;
  var R = attMatrix(st.att);
  return EE.homographyFromPose(R, c.camH, c.f, st.imgW, st.imgH, effAngle(st), deckNormalOf(st));
}

/* The screen angle a shot should actually be read with.

   Safari hands back a frame oriented to the interface, and whether that matches
   the device frame the tilt is expressed in is not something this app can know
   without testing on the handset. Getting it wrong rotates the tilt about the
   wrong axis and throws the horizon completely — which looks exactly like a
   broken calibration. So it is correctable per shot, empirically, by watching
   the drawn horizon. */
function effAngle(st) {
  return (((st && st.screenAngle) || 0) + ((st && st.angleFix) || 0) + 360) % 360;
}

/* Every attitude the geometry consumes passes through here, so a per-device
   sensor bias has exactly one knob. Phone pitch sensors genuinely carry one —
   a degree or three from assembly tolerance, more with a case — and at this
   geometry one degree of pitch is ~30 cm of range error at 5 m. The trim is
   eyeballed against a visible horizon, which on a roof is always available. */
/* The lens, for a given frame geometry. A measured field of view belongs to the
   camera AND the crop Safari delivered — a 4:3 measurement quietly applied to a
   16:9 stream is wrong by the crop. Keyed by frame size, global as fallback. */
function fovValueFor(w, h2) {
  var key = w + 'x' + h2;
  var m = db.settings.fovByFrame || {};
  return m[key] || db.settings.fov;
}
function stationF(st) {
  return EE.focalFromFov(fovValueFor(st.imgW, st.imgH), Math.max(st.imgW, st.imgH));
}

function attMatrix(a) {
  /* A horizon-locked shot carries an attitude measured from the photo itself;
     the per-device trims are a fudge for the sensor and must not touch it. */
  if (a.horizonLocked) return EE.rotFromOrientation(a.alpha, a.beta, a.gamma);
  return EE.rotFromOrientation(a.alpha,
    a.beta + (db.settings.pitchTrim || 0),
    a.gamma + (db.settings.rollTrim || 0));
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

  var poly = clipToCircle(fp.ground, cam.x, cam.y,
    Math.max(0.5, trustedRadius(st.cal && st.cal.camH)), 24);
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

/* ================= scale, corrected afterwards =================

   Camera height enters the ray model as a pure similarity: the homography is
   D.R.A.T with D = diag(h, h, -1), so doubling h doubles every length and nothing
   else. Get it wrong and the whole survey is the right SHAPE at the wrong SIZE.

   That is the good news, because a uniform scale error can be undone at any time
   from a single known dimension — long after the roof visit, from one tape
   measurement, across every shot at once. Nothing has to be re-traced.

   The correction is applied destructively so the rest of the app keeps working in
   true metres with no scale-aware read path. Factors compose, so it can be
   applied again as better references turn up. */
function applyScaleCorrection(p, k, note) {
  if (!(k > 0) || !isFinite(k)) return false;

  p.stations.forEach(function (st) {
    if (st.reg) { st.reg.tx *= k; st.reg.ty *= k; }
    var c = st.cal;
    if (!c) return;
    if (c.camH) c.camH *= k;
    /* An absolute length has been supplied; the scale is no longer provisional. */
    if (c.provisionalScale) c.provisionalScale = false;
    if (c.pose) { c.pose.scale *= k; c.pose.tx *= k; c.pose.ty *= k; }
    if (c.mode === 'quad' && c.H) {
      /* H maps image -> ground; its first two rows ARE the output coordinates,
         so scaling them scales the ground plane. The third row is the
         perspective denominator and must not be touched. */
      for (var i = 0; i < 6; i++) c.H[i] *= k;
      c.refW *= k; c.refL *= k;
    }
  });

  p.objects.forEach(function (o) {
    if (o.kind === 'rect') { o.cx *= k; o.cy *= k; o.w *= k; o.l *= k; }
    else if (o.kind === 'cylinder') { o.cx *= k; o.cy *= k; o.r *= k; }
    else if (o.pts) o.pts = o.pts.map(function (q) { return { x: q.x * k, y: q.y * k }; });
    /* A typed height came off a tape and is already true; only an optically
       measured one rides on the camera height. */
    if (o.hSrc !== 'typed' && o.h) o.h *= k;
  });

  p.scaleLog = (p.scaleLog || []).concat([{ k: k, at: Date.now(), note: note || '' }]);
  touchProject(p);
  return true;
}

/* Do the shots agree about size?

   Each shot carries its own camera height, and camera height IS scale. Calibrate
   three shots from three different references and you can get three different
   scales in one survey — the plan looks fine, the shapes look fine, and the
   dimensions are quietly wrong by however much they disagree.

   Registration catches it, but only between shots that share two named landmarks.
   This checks every shot against every other, whether they are tied or not. */
/* Whether a calibration's SCALE is pinned by a physical reference — a hexagon
   of typed side, a regulation ball, a measured rectangle, a map — as opposed
   to riding on a typed eye height or an assumed lens. The distinction is the
   whole ballgame for cross-shot scale: an anchored shot's camera height is an
   OUTPUT (crouch and it reads 0.7 m, stand and it reads 1.3 m, both correct),
   and rescaling it to match someone's stance multiplies a physical object's
   size. The field found this the hard way: two correct hexagon shots at two
   real heights were read as an "80% disagreement" and one was force-scaled by
   1.81×, panel and all. */
function calAbsoluteScale(c) {
  if (!c || !c.ok || c.provisionalScale) return false;
  if (c.mode === 'quad') return true;
  return /^(hex|ball|gravity)/.test(c.source || '');
}

function scaleSpread(p) {
  var anchored = [], assumed = [];
  p.stations.forEach(function (st, i) {
    if (!(st.cal && st.cal.ok && st.cal.camH > 0)) return;
    (calAbsoluteScale(st.cal) ? anchored : assumed)
      .push({ id: st.id, idx: i + 1, h: st.cal.camH, src: st.cal.source || st.cal.mode });
  });
  if (anchored.length + assumed.length < 2) return null;
  var spreadOf = function (arr) {
    if (arr.length < 2) return 0;
    var lo = arr[0].h, hi = arr[0].h;
    arr.forEach(function (x) { if (x.h < lo) lo = x.h; if (x.h > hi) hi = x.h; });
    return hi / lo - 1;
  };
  var hsAll = anchored.concat(assumed).map(function (x) { return x.h; }).sort(function (a, b) { return a - b; });
  return {
    anchored: anchored, assumed: assumed,
    n: anchored.length + assumed.length,
    median: hsAll[Math.floor(hsAll.length / 2)],
    assumedSpread: spreadOf(assumed)
  };
}

/* Force one camera height on a shot, rescaling everything traced from it.

   Scale is a similarity on that shot's own frame, so its geometry, its pose and
   its homography all take the same factor. Its registration does not: that was
   fitted against the old size, so it is dropped and re-solved from the landmarks. */
function rescaleStation(p, st, k) {
  if (!(k > 0) || !isFinite(k) || Math.abs(k - 1) < 1e-12) return false;
  var c = st.cal;
  if (c) {
    if (c.camH) c.camH *= k;
    if (c.pose) { c.pose.scale *= k; c.pose.tx *= k; c.pose.ty *= k; }
    if (c.mode === 'quad' && c.H) {
      for (var i = 0; i < 6; i++) c.H[i] *= k;
      if (c.refW) c.refW *= k;
      if (c.refL) c.refL *= k;
    }
  }
  p.objects.forEach(function (o) {
    if (o.stationId !== st.id) return;
    if (o.kind === 'rect') { o.cx *= k; o.cy *= k; o.w *= k; o.l *= k; }
    else if (o.kind === 'cylinder') { o.cx *= k; o.cy *= k; o.r *= k; }
    else if (o.pts) o.pts = o.pts.map(function (q) { return { x: q.x * k, y: q.y * k }; });
    if (o.hSrc !== 'typed' && o.h) o.h *= k;
  });
  if (st.reg && (st.reg.method === 'tie' || st.reg.method === 'hex')) st.reg = null;
  return true;
}

function unifyScale(p, targetH) {
  var n = 0, skipped = 0;
  p.stations.forEach(function (st) {
    if (!st.cal || !st.cal.ok || !(st.cal.camH > 0)) return;
    /* Reference-pinned shots are never rescaled here: their height differences
       are stances, not errors. Recalibrating the shot is the only way to
       change what its own reference said. */
    if (calAbsoluteScale(st.cal)) { skipped++; return; }
    if (rescaleStation(p, st, targetH / st.cal.camH)) n++;
  });
  unifyScale.lastSkipped = skipped;
  ensureOrigin(p);
  p.stations.forEach(function (st) { if (!st.reg) tryRegister(p, st); });
  touchProject(p); save();
  coverageCache = { key: null, val: null };
  ui.plan.fitted = false;
  return n;
}

function totalScaleCorrection(p) {
  return (p.scaleLog || []).reduce(function (a, s) { return a * s.k; }, 1);
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
  var tr = trustedRadius(typicalCamH(p));
  p.objects.forEach(function (o) {
    if (o.kind === 'point') return;
    var d = objectRange(p, o);
    var st = findStation(p, o.stationId);
    /* judged against the radius of the shot it came from, not a global one */
    var lim = trustedRadius(st && st.cal && st.cal.camH);
    if (d != null && d > lim) far.push({ o: o, d: d, lim: lim });
  });
  if (far.length) {
    far.sort(function (a, b) { return b.d - a.d; });
    add('warn', far.length + (far.length === 1 ? ' object traced beyond the trusted radius' : ' objects traced beyond the trusted radius'),
      'Furthest is ' + esc(far[0].o.name || 'unnamed') + ' at ' + EE.fmtLen(far[0].d, U(), 1) +
      ', past ' + EE.fmtLen(far[0].lim, U(), 1) + '. Re-trace it from closer.', 'object', far[0].o.id);
  }

  if (!p.objects.some(function (o) { return o.kind === 'outline'; }))
    add('warn', 'No roof outline', 'Without one there is no area and no boundary in the export.', 'tab', 'plan');

  if (p.objects.filter(function (o) { return o.kind === 'point'; }).length < 2)
    add('warn', 'Fewer than two landmarks', 'Two are needed to place the survey on the map, and to tie shots together.', 'tab', 'plan');

  if (!p.anchor) add('warn', 'Survey not located', 'Pin two landmarks to their coordinates before exporting a KML.', 'geo');
  else if (p.anchorMeta && p.anchorMeta.scaleError != null && Math.abs(p.anchorMeta.scaleError) > 0.02)
    add('warn', 'Scale disagrees with the map by ' + fmtSigned(p.anchorMeta.scaleError * 100) + '%',
      'The survey and the aerial do not agree on distance. One of them is wrong.', 'geo');

  /* Different camera heights across shots are NOT a defect — a crouched shot
     and a standing shot are both correct. Only two things are worth flagging:
     assumed-scale shots drifting from each other, and hard tie evidence that
     two reference-pinned shots disagree about a shared object's size. */
  var sp = scaleSpread(p);
  if (sp && sp.assumedSpread > 0.08) {
    add('warn', 'Assumed-scale shots disagree by ' + (sp.assumedSpread * 100).toFixed(0) + '%',
      sp.assumed.length + ' shots ride on a typed height or an assumed lens, and they do not ' +
      'agree with each other. Tie them to a reference-pinned shot, or match their heights by hand.',
      'scaleagree');
  }
  if (p.scaleClash) {
    add('block', 'Two shots disagree about the panel\'s size by ' +
      (p.scaleClash.pct * 100).toFixed(0) + '%',
      'The hexagon tie between shots ' + p.scaleClash.a + ' and ' + p.scaleClash.b +
      ' found the same physical panel at two sizes — one shot\'s entered side length is wrong. ' +
      'Recalibrate that shot; heights are not the issue.', null);
  }

  var prov = p.stations.filter(function (s2) { return s2.cal && s2.cal.provisionalScale; }).length;
  if (prov) add('warn', prov + (prov === 1 ? ' shot has' : ' shots have') + ' provisional scale',
    'Plane from gravity but the lens was assumed, so sizes may be uniformly off by ~10%. ' +
    'One tape measurement of anything already traced trues every shot at once.', 'rescale');

  var susp = p.stations.filter(function (s2) { return s2.cal && s2.cal.suspect; });
  if (susp.length) add('warn', susp.length + (susp.length === 1 ? ' shot has' : ' shots have') + ' unreliable perspective',
    'Calibrated from a reference too small to pin the vanishing line down. Recalibrate that shot ' +
    'from something larger, or enable the tilt sensor so the plane can come from gravity.', 'station', susp[0].id);

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
  if (st.photoGone) return '';
  IDB.get(photoKey(st.id)).then(function (b) {
    if (!b) {
      /* Remembered, so a dropped photo reads as "dropped" rather than as a
         broken image that looks like a bug. */
      st.photoGone = true;
      var slot = document.querySelector('[data-thumb="' + st.id + '"]');
      if (slot && slot.tagName !== 'IMG') slot.innerHTML = 'photo<br>dropped';
      return;
    }
    st.photoGone = false;
    ui.urlCache[st.id] = URL.createObjectURL(b);
    var el = document.querySelector('[data-thumb="' + st.id + '"]');
    if (el && el.tagName === 'IMG') el.src = ui.urlCache[st.id];
    else if (el) render();
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
  /* Ring of recent samples, for reading the attitude from BEFORE the shutter
     tap. Tapping the shutter rocks the phone about your grip — top tips back,
     the sensor reads more upright at exactly the instant the old code sampled
     it, and every horizon drawn from that shot sits too low. The sign of the
     error the field reported matches this precisely. */
  (ui.attRing || (ui.attRing = [])).push({
    t: performance.now(),
    a: ui.sensors.alpha, b: ui.sensors.beta, g: ui.sensors.gamma,
    q: EE.quatFromOrientation(ui.sensors.alpha, ui.sensors.beta, ui.sensors.gamma)
  });
  if (ui.attRing.length > 50) ui.attRing.shift();

  if (ui.cap) paintCaptureHud();
  /* The HUD is driven by the orientation event rather than by rAF: iOS polls
     CoreMotion at 60 Hz, so there is nothing new to draw between samples. */
  if (ui.live) paintLive();
}

/* The attitude the shot should carry: the median sample from a window ending
   well before the tap's mechanical impact, plus how fast the phone was moving. */
function preTapAttitude(tapT) {
  var ring = ui.attRing || [];
  if (!ring.length) return null;
  var win = ring.filter(function (s2) { return s2.t >= tapT - 450 && s2.t <= tapT - 120; });
  if (!win.length) win = [ring[ring.length - 1]];
  var mid = win[Math.floor(win.length / 2)];
  var recent = ring.filter(function (s2) { return s2.t >= tapT - 300; });
  var wob = 0;
  for (var i = 1; i < recent.length; i++) {
    var dt = Math.max(1, recent[i].t - recent[i - 1].t);
    wob = Math.max(wob, EE.quatAngleDeg(recent[i - 1].q, recent[i].q) * 1000 / dt);
  }
  return { alpha: mid.a, beta: mid.b, gamma: mid.g, wobble: wob };
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
      var open = ui.swipe === p.id;
      return '<div class="card-wrap' + (open ? ' open' : '') + '" data-swipe="' + p.id + '">' +
        '<div class="card-actions">' +
        '<button class="swipe-btn del" data-act="del-survey" data-id="' + p.id + '">Delete</button>' +
        '</div>' +
        '<div class="proj-card" data-open="' + p.id + '">' +
        '<span class="watermark">' + esc((p.name || '?').charAt(0)) + '</span>' +
        '<span class="pc-name">' + esc(p.name) + '</span>' +
        (p.address ? '<span class="pc-addr">' + esc(p.address) + '</span>' : '') +
        '<span class="pc-meta">' + p.stations.length + (p.stations.length === 1 ? ' SHOT · ' : ' SHOTS · ') +
        objs + (objs === 1 ? ' OBJECT' : ' OBJECTS') +
        (area ? ' · ' + EE.fmtArea(area, U()) : '') +
        (p.anchor ? ' · LOCATED' : '') + '</span>' +
        '</div></div>';
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
      var url = thumbUrl(s);
      return '<div class="stn-chip' + (s.reg ? '' : ' unreg') + '" data-station="' + s.id + '">' +
        (url
          ? '<img class="thumb" data-thumb="' + s.id + '" src="' + esc(url) + '" alt="">'
          : '<div class="thumb gone" data-thumb="' + s.id + '">' +
          (s.photoGone ? 'photo<br>dropped' : '…') + '</div>') +
        '<div class="sl">' + (s.reg ? '' : '⚠ ') + 'SHOT ' + (i + 1) + '</div>' +
        '<button class="stn-del" data-act="del-station" data-id="' + s.id + '">×</button></div>';
    }).join('') +
    (p.stations.length ? '' : '<div class="hint" style="padding:14px 4px">No shots yet — tap <b>Capture</b>.</div>') +
    '</div></div>';
}

/* The level reading, given first billing on the Check tab — it was the thing that
   could not be found, and it is what makes a small reference usable. */
function tplDeckPanel(p) {
  var l = ui.level;
  if (l) {
    return '<div class="panel gold"><span class="p-tag">READING THE DECK</span>' +
      '<div class="p-body">Lay the phone <b>' + (l.faceDown ? 'screen down' : 'screen up') +
      '</b> on the roof. It reads itself as soon as it has been still for a moment — ' +
      'no need to watch it.</div>' +
      '<div class="hold-bar"><div id="level-bar"></div></div>' +
      '<div class="kv"><span id="level-txt">waiting for the sensor…</span><span>' +
      LEVEL_SPREAD.toFixed(1) + '° for ' + (LEVEL_WINDOW / 1000).toFixed(1) + ' s</span></div>' +
      '<button class="btn ghost sm" data-act="level-cancel">Cancel</button></div>';
  }

  if (p.deck) {
    var pct = Math.tan(p.deck.tiltDeg * Math.PI / 180) * 100;
    return '<div class="panel good"><span class="p-tag">DECK LEVELLED</span>' +
      '<div class="kv"><span>Off level</span><span>' + p.deck.tiltDeg.toFixed(2) + '° (' + pct.toFixed(1) + '% fall)</span></div>' +
      '<div class="kv"><span>Read</span><span>' + (p.deck.faceDown ? 'screen down' : 'screen up') +
      ', ±' + p.deck.spreadDeg.toFixed(2) + '°</span></div>' +
      (db.settings.biasMeasured ? '<div class="kv good"><span>Sensor bias (corrected)</span><span>' +
        fmtSigned(db.settings.biasMeasured.p) + '° / ' + fmtSigned(db.settings.biasMeasured.r) + '°</span></div>' : '') +
      '<div class="p-body">New shots are measured against this plane instead of assuming level. ' +
      'Re-read it if you move to a section that falls a different way.</div>' +
      '<div class="btn-row">' +
      '<button class="btn ghost-gold sm" data-act="level-down">Re-read, screen down</button>' +
      '<button class="btn ghost-gold sm" data-act="level-up">Screen up</button></div>' +
      '<button class="btn ghost sm" data-act="clear-deck">Clear the reading</button></div>';
  }

  return '<div class="panel warn"><span class="p-tag">DECK NOT LEVELLED</span>' +
    '<div class="p-body">Lay the phone on the roof and Eagle Eye reads <b>where flat actually is</b> ' +
    'from gravity.<br><br>This is what makes a small reference work. A homography has eight ' +
    'degrees of freedom and two of them <b>are</b> the horizon — a bank card spanning a dozen ' +
    'pixels cannot pin those down, so the scale comes out right along the card and the vanishing ' +
    'point comes out wrong. Gravity fixes the plane exactly and carries no length; the card ' +
    'carries length and no plane. Together they cover it.</div>' +
    '<div class="btn-row">' +
    '<button class="btn primary sm" data-act="level-check">Read + sensor check</button></div>' +
    '<div class="btn-row">' +
    '<button class="btn ghost-gold sm" data-act="level-down">Quick read, screen down</button>' +
    '<button class="btn ghost-gold sm" data-act="level-up">Screen up</button></div>' +
    '<div class="hint">Screen down is truer — the camera bump tilts a face-up phone about a ' +
    'degree. Either way it counts down so you need not read the screen.</div></div>';
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

  var tr = trustedRadius(typicalCamH(p));
  var s = db.settings;
  var corr = totalScaleCorrection(p);
  return '<div class="screen" style="padding-top:14px">' +
    tplDeckPanel(p) +
    '<div class="panel gold"><span class="p-tag">SIZE LOOKS WRONG?</span>' +
    '<div class="p-body">Camera height is a <b>pure scale</b>, so a survey can be the right ' +
    'shape at the wrong size. One tape measurement fixes every dimension in every shot — ' +
    'afterwards, with nothing re-traced.' +
    (Math.abs(corr - 1) > 1e-9 ? '<br>Already corrected by <b>' + fmtSigned((corr - 1) * 100) + '%</b>.' : '') +
    '</div>' +
    '<button class="btn primary sm" data-act="rescale">Correct the scale</button>' +
    '<button class="btn ghost-gold sm" data-act="align">Align to the building</button>' +
    (p.stations.filter(function (s2) { return s2.reg && s2.reg.method === 'tie'; }).length >= 1
      ? '<button class="btn ghost-gold sm" data-act="adjust-survey">Adjust the survey</button>' : '') +
    (scaleSpread(p) ? '<button class="btn ghost-gold sm" data-act="scaleagree">Scale across shots</button>' : '') +
    '<button class="btn ghost-gold sm" data-act="howto">How to measure well</button></div>' +
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
      '<button class="icon-btn" data-act="del-object-row" data-id="' + o.id + '" ' +
      'style="flex:0 0 auto;color:var(--red,#E0897D)">\u00d7</button>' +
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
    '<button class="btn ghost" data-act="export-json">Backup JSON</button>' +
    '<button class="btn ghost" data-act="export-debug-full">Debug bundle + photos</button></div>' +
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
      (currentProject() && currentProject().deck
        ? '<div class="pill tiny" style="align-self:flex-start;color:var(--green);border-color:rgba(110,210,154,.5)">' +
        '⌂ deck levelled · ' + currentProject().deck.tiltDeg.toFixed(1) + '°</div>'
        : '<button class="pill tiny gold" data-act="level-down" style="align-self:flex-start">' +
        '⌂ Set the flat plane first</button>') +
      '<div class="tilt-bar"><div class="band" style="left:27.7%;width:44.4%"></div>' +
      '<div class="mark" id="tilt-mark" style="left:' + clamp(tiltDeg(), 0, 90) / 90 * 100 + '%"></div></div>' +
      '<div class="pill tiny" id="plumb-chip" style="align-self:flex-start;display:none"></div>' +
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

  /* The spirit-level readout, iPhone-camera style: fine pitch/roll against
     dead vertical whenever you are close to it. Knowing a shot was taken
     plumb makes its geometry human-checkable — and a chip that reads plumb
     when the phone visibly is not is the sensor bias advertising itself. */
  var plumb = $('#plumb-chip');
  if (plumb) {
    var dvP = Math.abs(tiltDeg()), dvR = Math.abs(ui.sensors.gamma || 0);
    if (dvP < 4 && dvR < 4) {
      var lockedP = dvP <= 0.5 && dvR <= 0.5;
      plumb.style.display = '';
      plumb.style.color = lockedP ? 'var(--green)' : '';
      plumb.style.borderColor = lockedP ? 'rgba(110,210,154,.5)' : '';
      plumb.textContent = lockedP
        ? '▏PLUMB · ' + dvP.toFixed(1) + '° / ' + dvR.toFixed(1) + '°'
        : '▏plumb in ' + dvP.toFixed(1) + '° · roll ' + dvR.toFixed(1) + '°';
      if (lockedP && !ui.plumbWas) buzz(12);
      ui.plumbWas = lockedP;
    } else {
      plumb.style.display = 'none';
      ui.plumbWas = false;
    }
  }
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
      'Trusted to <b>' + EE.fmtLen(trustedRadius(liveCamH(p, l)), U(), 1) + '</b> from here.</div>';
  }

  return '<div class="full">' +
    '<div class="full-head"><span class="ftitle">LIVE — DRIFT CHECK</span>' +
    '<button class="close-btn" data-act="close-live">×</button></div>' +
    '<div class="full-body">' +
    (l.err ? '' : '<video id="live-video" autoplay playsinline muted></video><canvas id="live-canvas"></canvas>') +
    '</div>' +
    '<div class="full-foot">' + foot + '</div></div>';
}

function liveCamH(p, l) {
  var st = l && findStation(p, l.stationId);
  return (st && st.cal && st.cal.camH) || db.settings.camH;
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
  var R = attMatrix(ui.sensors);
  var Hm = EE.homographyFromPose(R, camH, f, W, H, screenAngle(), deckNormalOf(st));
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
    strokeScreenPoly(g, EE.circlePoly(cam.x, cam.y, trustedRadius(camH), 72).map(toPix), true);
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
          if (cam && Math.hypot(wx - cam.x, wy - cam.y) > trustedRadius(camH) * 1.7) continue;
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
        return w ? EE.projectToPixel(w, R, camH, W, H, f, screenAngle(), o.h, deckNormalOf(st)) : null;
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
    '<button class="' + (t.calMode === 'hex' ? 'active' : '') + '" data-calmode="hex">Hex panel</button>' +
    '<button class="' + (t.calMode === 'quad' ? 'active' : '') + '" data-calmode="quad">Rectangle</button>' +
    '<button class="' + (t.calMode === 'ball' ? 'active' : '') + '" data-calmode="ball">Golf ball</button>' +
    '<button class="' + (t.calMode === 'map' ? 'active' : '') + '" data-calmode="map">Map</button>' +
    '<button class="' + (t.calMode === 'ray' ? 'active' : '') + '" data-calmode="ray">Tilt + height</button>' +
    '</div>';

  /* The manual horizon offset. ▲ moves the drawn horizon UP the image, which
     means the sensor was reading the phone as more upright than it is. Stored
     per device, applied to every attitude everywhere. */
  if (st.att) {
    modeSeg += '<div class="live-row" style="justify-content:center">' +
      '<button class="pill tiny" data-act="trim-pitch" data-d="-1">▲ horizon</button>' +
      '<span class="pill tiny' + (db.settings.pitchTrim ? ' gold' : '') + '">trim ' +
      fmtSigned(db.settings.pitchTrim || 0) + '°</span>' +
      '<button class="pill tiny" data-act="trim-pitch" data-d="1">▼ horizon</button>' +
      ((db.settings.pitchTrim || db.settings.rollTrim)
        ? '<button class="pill tiny" data-act="trim-reset">reset</button>' : '') +
      (st.att.horizonLocked
        ? '<button class="pill tiny gold" data-act="horizon-unlock">⇱ horizon locked — unlock</button>'
        : '<button class="pill tiny' + (t.horizonPick ? ' gold' : '') + '" data-act="horizon-pick">⇱ ' +
        (t.horizonPick ? 'tap the horizon — ' + (2 - t.horizonPick.length) + ' to go' : 'Lock to horizon') +
        '</button>') +
      '</div>';
    if (t.horizonPick) {
      modeSeg += '<div class="hint">Tap <b>two points on the far horizon</b> — open water or the ' +
        'distant skyline, as far apart in the frame as you can. Not the parapet, not a nearby ' +
        'roofline: anything close is below the true horizon and will tilt the plane. The photo ' +
        'then fixes this shot\'s pitch and roll exactly, whatever the sensor thinks.</div>';
    }
  }

  if (t.calMode === 'hex') {
    var hn = Math.min(t.taps.length, 6);
    var hexBody;
    if (hn < 6) {
      hexBody = dots(hn, 6) +
        '<div class="hint">Tap the <b>six corners</b> of the panel, walking around it — either ' +
        'direction, any starting corner. Corner snap and the loupe both help. ' + (6 - hn) +
        ' to go.</div>';
    } else {
      hexBody = dots(6, 6) +
        '<div class="hint">Six corners placed. Check the side length below, then calibrate — ' +
        'the six must agree with each other, and the readout will say how well they did.</div>';
    }
    return modeSeg +
      '<div class="hint">A regular hexagon of known side is a <b>tape-free reference</b>: one ' +
      'number covers all six corners, and with six the fit can check itself — four corners ' +
      'never can. Lay the panel <b>flat on the deck</b>, fill a good part of the frame with it, ' +
      'and its 9 mm of thickness is beneath notice.</div>' +
      hexBody +
      '<div class="field"><label>SIDE LENGTH (corner to corner along one edge)</label><div class="unit-suffix">' +
      '<input class="inp mono" id="hex-side" inputmode="decimal" value="' +
      esc(t.hexSide || EE.fromM(0.15, U()).toFixed(3)) + '"><span>' + U() + '</span></div></div>' +
      '<div class="field"><label>PANEL THICKNESS \u2014 tap the TOP corners; this is subtracted</label><div class="unit-suffix">' +
      '<input class="inp mono" id="hex-thick" inputmode="decimal" value="' +
      esc(t.hexThick || EE.fromM(0.009, U()).toFixed(4)) + '"><span>' + U() + '</span></div></div>' +
      '<div class="btn-row">' +
      (hn ? '<button class="btn ghost sm" data-act="undo-tap">Undo</button>' : '') +
      '<button class="btn primary sm" data-act="apply-hex"' + (hn >= 6 ? '' : ' disabled') + '>Calibrate</button>' +
      '</div>';
  }

  if (t.calMode === 'ball') {
    if (!st.att) {
      return modeSeg +
        '<div class="panel warn"><span class="p-tag">NEEDS THE TILT SENSOR</span>' +
        '<div class="p-body">The ball supplies a length; the plane comes from gravity, which ' +
        'means the tilt recorded with this shot. This one has none — use the Rectangle route.</div></div>';
    }
    var bn = t.taps.length;
    var fitb = t.ballFit;
    var committed = t.balls || [];
    var set = ballSet(t);
    var letter = function (i) { return String.fromCharCode(65 + i); };
    var seedR = bn >= 2 ? Math.hypot(t.taps[1].x - t.taps[0].x, t.taps[1].y - t.taps[0].y) : 0;
    var dh = fitb ? fitb.dh : seedR * 2;
    var errPx = fitb ? 0.6 : 3;
    var body;

    if (bn === 0) {
      body = committed.length
        ? '<div class="hint">Ball <b>' + letter(committed.length) + '</b>: press on its <b>centre</b>. ' +
        (committed.length === 1
          ? '<b>A metre from ball A beats a hand-span</b> — their spacing is the tilt lever; ' +
          'bunched balls read heights but not tilt.'
          : 'Out of line with A and B, and <b>a metre out</b> — a wide triangle reads the whole ' +
          'plane; a tight cluster or a queue reads nothing new.') +
        '</div>'
        : '<div class="hint">Put a golf ball <b>on the deck</b>, in frame. Press on its ' +
        '<b>centre</b> — the loupe helps. Different-coloured balls are fine: each is read ' +
        'against its own background.</div>';
    } else if (bn === 1) {
      body = '<div class="hint">Now press on the centre again and <b>drag out to its edge</b> — ' +
        'a circle follows your finger. Let go on the rim.</div>';
    } else {
      var weak = fitb && fitb.n < 34;
      body = '<div class="panel ' + (fitb ? (weak ? '' : 'good') : 'warn') + '">' +
        '<span class="p-tag">' + (set.length > 1 || committed.length ? 'BALL ' + letter(committed.length) + ' — ' : '') +
        (fitb ? (weak ? 'RIM LOCKED — WEAKLY' : 'RIM LOCKED') : 'USING YOUR CIRCLE') + '</span>' +
        (weak ? '<div class="p-body">Only ' + fitb.n + ' of 48 spokes agree — check the green circle actually hugs the ball before trusting it.</div>' : '') +
        (fitb
          ? '<div class="kv"><span>Rim found on</span><span>' + fitb.n + ' of 48 spokes, ±' +
          fitb.rms.toFixed(1) + ' px</span></div>' +
          '<div class="kv"><span>Width across</span><span>' + fitb.dh.toFixed(1) + ' px</span></div>'
          : '<div class="p-body">Could not lock onto the rim — low contrast or glare. Your circle ' +
          'is used as drawn, so place it carefully, or move closer.</div>' +
          '<div class="kv"><span>Width across</span><span>' + (seedR * 2).toFixed(0) + ' px</span></div>') +
        (dh > 0 ? '<div class="kv ' + (errPx / dh < 0.02 ? 'good' : '') + '"><span>Scale error this implies</span>' +
          '<span>±' + (errPx / dh * 100).toFixed(1) + '%</span></div>' +
          '<div class="kv"><span>Closer is better</span><span>' + Math.round(dh) + ' px now</span></div>' : '') +
        '</div>';
    }

    /* The committed roster — each ball's pixel width and the range it implies,
       so a mislocked ball advertises itself (a ball "2.3 m away" sitting next
       to one at 1.5 m is lying about something). */
    var roster = '';
    if (committed.length) {
      var Dr = EE.toM(parseFloat(t.ballDia) || 0, U()) || 0.04267;
      var fr2 = stationF(st);
      roster = '<div class="live-row" style="flex-wrap:wrap">' + committed.map(function (b, i) {
        var rng = b.dh > 4 ? fr2 * Dr / b.dh : 0;
        return '<span class="pill tiny' + (b.locked ? ' gold' : '') + '">' + letter(i) + ' · ' +
          Math.round(b.dh) + ' px' + (rng ? ' · ' + EE.fmtLen(rng, U(), 1) : '') +
          (b.locked ? '' : ' — unlocked') + '</span>';
      }).join('') + '</div>';
    }

    /* The verdict, live: what the balls in play can already say about the
       sensor's plane. The angles are diameter-free (every distance scales with
       the diameter together), so the default ball is fine here even before the
       diameter field below is read. */
    var verdict = '';
    if (set.length >= 2 && st.att) {
      var Dv = EE.toM(parseFloat(t.ballDia) || 0, U()) || 0.04267;
      var sv = ballSolve(st, t, Dv);
      if (sv && sv.res && sv.res.rangeSuspect != null) {
        verdict = '<div class="panel warn"><span class="p-tag">' +
          (sv.res.rangeSuspect < 0 ? 'THE BALLS DISAGREE' : 'BALL ' +
            String.fromCharCode(65 + sv.res.rangeSuspect) + ' DISAGREES') + '</span>' +
          '<div class="kv"><span>Heights say</span><span>' +
          sv.res.hs.map(function (hv) { return EE.fmtLen(hv, U(), 2); }).join(' / ') + '</span></div>' +
          '<div class="p-body">Every ball prices the same camera height; one of these does not. ' +
          'Its rim lock is off — check the green circle hugs the ball — or it is not on the deck.</div></div>';
      } else if (sv && sv.res && sv.res.implausible) {
        verdict = '<div class="panel warn"><span class="p-tag">ONE BALL IS LYING</span>' +
          '<div class="p-body">The plane these balls describe is ' + sv.res.disagreeDeg.toFixed(0) +
          '° off the sensor — wilder than any sensor error. One range is corrupt: a rim locked ' +
          'on a shadow, or a ball not on the deck. Re-circle the weakest lock.</div></div>';
      } else if (sv && sv.res && (sv.res.degenerate === 'tiny' || sv.res.whyNot === 'noise')) {
        var rvb = sv.res;
        var spread = rvb.mode === 2 ? rvb.baselineM : rvb.minAltM;
        verdict = '<div class="panel warn"><span class="p-tag">TOO BUNCHED TO READ TILT</span>' +
          '<div class="kv"><span>Spread now</span><span>' +
          (spread > 0 ? EE.fmtLen(spread, U(), 2) : '—') + '</span></div>' +
          (rvb.sigmaDeg != null ? '<div class="kv"><span>Tilt readable to</span><span>±' +
            rvb.sigmaDeg.toFixed(1) + '° only</span></div>' : '') +
          '<div class="p-body">The tilt lever is the distance <i>between</i> balls against a ' +
          'ranging error of a few centimetres. <b>A metre apart beats a hand-span</b> — spread ' +
          'them out; heights still average fine, and calibrating now keeps the sensor\'s plane.</div></div>';
      } else if (sv && sv.res && !sv.res.degenerate) {
        var rv = sv.res;
        var photo = rv.use === 'photo';
        verdict = '<div class="panel ' + (photo ? 'warn' : 'good') + '">' +
          '<span class="p-tag">PHOTO vs SENSOR</span>' +
          (set.length === 2
            ? '<div class="kv"><span>Tilt along the pair</span><span>' + fmtSigned(rv.tiltAlongDeg) +
            '° (readable to ±' + rv.sigmaDeg.toFixed(1) + '°)</span></div>' +
            '<div class="kv"><span>Balls apart</span><span>' + EE.fmtLen(rv.baselineM, U(), 2) + '</span></div>' +
            '<div class="kv"><span>Heights say</span><span>' +
            EE.fmtLen(rv.hs[0], U(), 2) + ' / ' + EE.fmtLen(rv.hs[1], U(), 2) + '</span></div>'
            : '<div class="kv"><span>Plane vs sensor</span><span>' + rv.disagreeDeg.toFixed(1) +
            '° apart (photo readable to ±' + rv.sigmaDeg.toFixed(1) + '°)</span></div>' +
            '<div class="kv"><span>Triangle</span><span>' + EE.fmtLen(rv.maxSideM, U(), 2) + ' long, ' +
            EE.fmtLen(rv.minAltM, U(), 2) + ' deep</span></div>') +
          '<div class="p-body">' + (photo
            ? 'The balls out-vote the sensor — calibrating will take the <b>photo\'s plane</b>.'
            : 'Within the photo\'s own resolution the sensor holds up — its finer-grained plane is kept.') +
          '</div></div>';
      } else if (sv && sv.res && sv.res.degenerate === 'collinear') {
        verdict = '<div class="panel warn"><span class="p-tag">NEARLY IN A LINE</span>' +
          '<div class="p-body">Three balls in a row read no more than two. Move one a stride ' +
          'sideways — the triangle needs depth (' + EE.fmtLen(sv.res.minAltM, U(), 2) + ' now).</div></div>';
      } else if (sv && sv.res && sv.res.degenerate === 'coincident') {
        verdict = '<div class="panel warn"><span class="p-tag">TOO CLOSE TOGETHER</span>' +
          '<div class="p-body">Spread the balls — their line is the measuring stick.</div></div>';
      }
    }

    var offDeg = 0;
    if (bn >= 1) {
      var fOff = stationF(st);
      offDeg = Math.atan(Math.abs(t.taps[0].x - st.imgW / 2) / fOff) * 180 / Math.PI;
    }
    var canAdd = bn >= 2 && set.length < 3;
    return modeSeg +
      '<div class="hint">Every ball is the same ball — <b>42.67 mm</b> is written into the rules. ' +
      'A slightly <b>oval</b> look away from the frame centre is expected (a sphere\'s silhouette ' +
      'stretches radially off-axis); only the <b>level width across</b> is measured, so keep the ' +
      'ball near the vertical midline and the oval costs nothing. <b>Two balls</b> cross-check the ' +
      'sensor\'s plane; <b>three in a triangle</b> read the deck plane from the photo alone.</div>' +
      (offDeg > 14 ? '<div class="panel warn"><span class="p-tag">BALL FAR OFF-CENTRE</span>' +
        '<div class="p-body">It sits ' + offDeg.toFixed(0) + '° off the vertical midline, where the ' +
        'sideways stretch starts leaking into the width. Recompose with the ball nearer the middle.</div></div>' : '') +
      roster + body + verdict +
      (set.length >= 1 ? '<div class="field"><label>BALL DIAMETER</label><div class="unit-suffix">' +
        '<input class="inp mono" id="ball-dia" inputmode="decimal" value="' +
        esc(t.ballDia || EE.fromM(0.04267, U()).toFixed(5)) + '"><span>' + U() + '</span></div></div>' : '') +
      (db.settings.fovAt ? '' : '<div class="hint">Lens not measured yet, so the scale will be ' +
        '<b>provisional</b> — one tape check afterwards trues every shot.</div>') +
      '<div class="btn-row">' +
      (bn || committed.length ? '<button class="btn ghost sm" data-act="undo-tap">Undo</button>' : '') +
      (canAdd ? '<button class="btn ghost sm" data-act="ball-add">+ Add ball ' + letter(set.length) + '</button>' : '') +
      '<button class="btn primary sm" data-act="apply-ball"' + (set.length >= 1 ? '' : ' disabled') + '>Calibrate' +
      (set.length > 1 ? ' · ' + set.length + ' balls' : '') + '</button>' +
      '</div>';
  }

  if (t.calMode === 'map') {
    var mn = t.taps.length;
    var lls = t.mapLL || (t.mapLL = ['', '', '', '', '']);
    var parsed = lls.slice(0, Math.max(4, mn)).map(parseLL);
    var haveAll = mn >= 4 && parsed.slice(0, 4).every(Boolean);

    var spread = 0;
    if (haveAll) {
      var g = parsed.slice(0, mn).filter(Boolean).map(function (ll) {
        return EE.latLonToEastNorth(ll, parsed[0]);
      });
      for (var a = 0; a < g.length; a++) for (var b = a + 1; b < g.length; b++) {
        spread = Math.max(spread, Math.hypot(g[a].e - g[b].e, g[a].n - g[b].n));
      }
    }

    var rows = '';
    for (var i = 0; i < Math.max(4, Math.min(5, mn)); i++) {
      var ok = !!parsed[i];
      rows += '<div class="field"><label>POINT ' + (i + 1) +
        (i === 4 ? ' — OPTIONAL, CHECKS THE OTHER FOUR' : '') +
        (i < mn ? '' : ' — NOT TAPPED YET') + '</label>' +
        '<input class="inp mono" data-mapll="' + i + '" value="' + esc(lls[i] || '') +
        '" placeholder="43.761500, -79.508300"' + (ok ? ' style="border-color:var(--green)"' : '') +
        ' autocomplete="off"></div>';
    }

    return modeSeg +
      '<div class="panel gold"><span class="p-tag">THE ROOF IS THE RULER</span>' +
      '<div class="p-body">Tap <b>four points</b> you can also find on an aerial — roof corners, ' +
      'a drain, a hatch — then paste each one\'s coordinates. That solves the calibration over ' +
      '<b>tens of metres</b> instead of a couple, needs no tape or tilt, and georeferences the ' +
      'survey at the same time.<br><br>' +
      'All four must be at <b>roof level</b>. Mixing a roof corner with a point on the ground ' +
      'breaks the plane the whole method rests on.</div></div>' +
      (mn < 4
        ? '<div class="hint">Tap point <b>' + (mn + 1) + ' of 4</b> in the photo. Spread them out — ' +
        'the further apart, the less a misread coordinate matters.<br>A fifth is optional and is ' +
        'the only way to check the other four.</div>'
        : (spread ? '<div class="kv ' + (spread > 15 ? 'good' : 'warn') + '"><span>Baseline</span>' +
          '<span>' + EE.fmtLen(spread, U(), 1) + (spread > 15 ? '' : ' — spread them wider') + '</span></div>' +
          '<div class="kv"><span>Reading error of ±0.5 m costs</span><span>±' +
          (spread > 0 ? (0.5 / spread * 100).toFixed(2) : '—') + '%</span></div>' : '')) +
      rows +
      '<div class="hint">In Google Maps, right-click a spot and the coordinates copy straight out.</div>' +
      '<div class="btn-row">' +
      (mn ? '<button class="btn ghost sm" data-act="undo-tap">Undo</button>' : '') +
      '<button class="btn primary sm" data-act="apply-map"' + (haveAll ? '' : ' disabled') + '>Calibrate</button>' +
      '</div>';
  }

  if (t.calMode === 'quad') {
    var n = t.taps.length;
    var body;

    /* Offered from the first tap, not withheld until the fourth: you choose what
       you are about to measure BEFORE aiming at it. The highlight reflects the
       dimensions actually in the fields rather than a remembered click, so typing
       a custom size correctly clears it. It was never implemented at all before —
       every preset rendered identically whatever was selected. */
    var curW = EE.toM(parseFloat(t.refW), U()), curL = EE.toM(parseFloat(t.refL), U());
    var presets = '<div class="seg tight">' + REF_PRESETS.map(function (r, i) {
      var pw = r.w == null ? db.settings.phoneW : r.w;
      var pl = r.l == null ? db.settings.phoneL : r.l;
      var on = pw > 0 && pl > 0 && Math.abs(curW - pw) < 0.0015 && Math.abs(curL - pl) < 0.0015;
      return '<button class="' + (on ? 'active' : '') + '" data-refpreset="' + i + '">' +
        esc(r.label) + '</button>';
    }).join('') + '</div>';

    /* Say out loud which tapped edge got which number. The old labels made this
       an invisible assumption, and getting it backwards wrecks the plane while
       leaving the quad looking perfect. */
    var edgeNote = '';
    if (n >= 4 && curW > 0 && curL > 0) {
      var asg = assignRefEdges(t.taps.slice(0, 4), curW, curL, t.refSwap);
      /* Projected aspect is NOT expected to match the real one — foreshortening
         legitimately turns a 1.59 card into 2.27 on screen at a 32 degree
         depression. Only an inversion is suspicious. */
      var mismatch = false;
      edgeNote = '<div class="panel ' + (mismatch ? 'warn' : '') + '">' +
        '<span class="p-tag">WHICH EDGE IS WHICH</span>' +
        '<div class="kv"><span>Edge 1→2 &nbsp;<i style="opacity:.55">' + Math.round(asg.e1) + ' px</i></span>' +
        '<span>' + EE.fmtLen(asg.first, U(), 3) + '</span></div>' +
        '<div class="kv"><span>Edge 2→3 &nbsp;<i style="opacity:.55">' + Math.round(asg.e2) + ' px</i></span>' +
        '<span>' + EE.fmtLen(asg.second, U(), 3) + '</span></div>' +
        '<div class="p-body">Assigned by which edge is longer on screen, so tap order does ' +
        'not matter. Foreshortening means the on-screen ratio (' + asg.projAspect.toFixed(2) +
        ':1) need not match the real one (' + asg.realAspect.toFixed(2) + ':1).</div>' +
        '<button class="btn ghost-gold sm" data-act="swap-ref">Swap the two</button></div>';
    }

    var refFields = '<div class="row2">' +
      '<div class="field"><label>ONE SIDE</label><div class="unit-suffix">' +
      '<input class="inp mono" id="ref-w" inputmode="decimal" value="' + esc(t.refW) + '"><span>' + U() + '</span></div></div>' +
      '<div class="field"><label>THE OTHER SIDE</label><div class="unit-suffix">' +
      '<input class="inp mono" id="ref-l" inputmode="decimal" value="' + esc(t.refL) + '"><span>' + U() + '</span></div></div>' +
      '</div>';

    if (n < 4) {
      body = '<div class="panel warn"><span class="p-tag">IT MUST LIE FLAT ON THE ROOF</span>' +
        '<div class="p-body">A curb top, a paver, a hatch lid, two tapes in an L. <b>Not</b> a wall, ' +
        'a parapet face or the side of a unit — everything here is projected onto the deck, so a ' +
        'vertical reference gives a badly wrong size.</div></div>' +
        '<div class="hint">Tap the <b>four corners</b> in order, going round.<br>' +
        'Corner <b>' + (n + 1) + ' of 4</b>. Press and drag for the loupe.</div>' + dots(n, 4) +
        presets + refFields;
    } else {
      var q = EE.referenceQuality(t.taps.slice(0, 4), 3);
      var qCls = { good: 'good', fair: 'gold', poor: 'warn' }[q ? q.verdict : 'poor'];
      var over = 20;   /* a typical roof span, for making the number concrete */

      body = '<div class="panel ' + qCls + '"><span class="p-tag">REFERENCE QUALITY</span>' +
        (q ? '<div class="kv"><span>Shortest edge</span><span>' + Math.round(q.minSpanPx) + ' px</span></div>' +
          '<div class="kv ' + (q.verdict === 'good' ? 'good' : q.verdict === 'poor' ? 'warn' : '') +
          '"><span>Scale error it implies</span><span>±' + (q.relScaleErr * 100).toFixed(2) + '%</span></div>' +
          '<div class="kv"><span>Over ' + EE.fmtLen(over, U(), 0) + ' that is</span><span>±' +
          EE.fmtLen(over * q.relScaleErr, U(), 2) + '</span></div>' +
          (q.foreshorten < 0.35 ? '<div class="p-body">Seen at a grazing angle — the corners are ' +
            'least certain this way. Stand more square to it.</div>' : '') +
          (q.verdict !== 'good' ? '<div class="p-body">A reference is only as good as the ' +
            '<b>pixels</b> it spans, not the metres. Fill more of the frame with it, or use ' +
            'something longer.</div>' : '')
          : '<div class="p-body">Tap four corners first.</div>') +
        '</div>' + presets + refFields + edgeNote;
    }
    return modeSeg + body +
      '<div class="btn-row">' +
      (n ? '<button class="btn ghost sm" data-act="undo-tap">Undo</button>' : '') +
      (n >= 4 ? '<button class="btn primary sm" data-act="apply-quad">Calibrate</button>' : '') +
      '</div>';
  }

  /* ray mode */
  var haveAtt = !!st.att;
  var fovNow = db.settings.fov;
  var Hray = haveAtt ? stationH(Object.assign({}, st, {
    cal: { mode: 'ray', camH: EE.toM(parseFloat(t.camH) || 1.55, U()), f: EE.focalFromFov(fovNow, Math.max(st.imgW, st.imgH)), ok: true }
  })) : null;
  var hzNow = Hray && EE.horizonLine(Hray, st.imgW, st.imgH);

  /* Collapsed by default. These panels are worth reading once and then never
     again, and left open they take half the screen away from the photo — which
     is the thing precision actually depends on. */
  var summary = '<button class="pill tiny ' + (db.settings.fovAt ? '' : 'gold') + '" data-act="toggle-diag">' +
    '⚙ ' + fovNow.toFixed(0) + '° ' + (db.settings.fovAt ? 'measured' : 'ASSUMED') +
    ' · horizon ' + (hzNow ? (hzNow.steep ? 'VERTICAL' : Math.round(hzNow.y0) + 'px') : '—') +
    (st.angleFix ? ' · fix ' + st.angleFix + '°' : '') + ' ▾</button>';

  var diag = !t.showDiag ? '' : '<div class="panel ' + (db.settings.fovAt ? 'good' : 'warn') + '">' +
    '<span class="p-tag">LENS</span>' +
    '<div class="kv"><span>Field of view in use</span><span>' + fovNow.toFixed(1) + '°</span></div>' +
    '<div class="kv ' + (db.settings.fovAt ? 'good' : 'warn') + '"><span>Source</span><span>' +
    (db.settings.fovAt ? 'measured, ' + esc(db.settings.fovFrom || 'camera') : 'ASSUMED — not measured') + '</span></div>' +
    (st.cam ? '<div class="kv"><span>Camera</span><span>' + esc((st.cam.label || '?').slice(0, 22)) + '</span></div>' +
      '<div class="kv"><span>Frame</span><span>' + st.imgW + '×' + st.imgH + '</span></div>' : '') +
    (db.settings.fovAt ? '' :
      '<div class="p-body">This route <b>depends</b> on the field of view, and nothing has measured ' +
      'it yet. Calibrate once from a large rectangle — the app reads your real lens off the same ' +
      'four corners — then come back. Until then the perspective here is a guess.</div>') +
    '</div>' +
    '<div class="panel"><span class="p-tag">ORIENTATION</span>' +
    '<div class="kv"><span>Horizon sits at</span><span>' +
    (hzNow ? (hzNow.steep ? 'a VERTICAL line — the frame is rotated' : Math.round(hzNow.y0) + ' px of ' + st.imgH) : '—') + '</span></div>' +
    '<div class="p-body">The red line on the photo is where this shot thinks the horizon is. If it ' +
    'is not on the real one, the frame and the tilt disagree about which way is up — step the ' +
    'correction until it lands.</div>' +
    '<div class="seg tight">' + [0, 90, 180, 270].map(function (a) {
      return '<button class="' + ((st.angleFix || 0) === a ? 'active' : '') + '" data-anglefix="' + a + '">' +
        (a === 0 ? 'none' : a + '°') + '</button>';
    }).join('') + '</div>' +
    '<div class="live-row" style="justify-content:center">' +
    '<button class="pill tiny" data-act="trim-roll" data-d="-1">⟲ level</button>' +
    '<span class="pill tiny' + (db.settings.rollTrim ? ' gold' : '') + '">roll trim ' +
    fmtSigned(db.settings.rollTrim || 0) + '°</span>' +
    '<button class="pill tiny" data-act="trim-roll" data-d="1">⟳ level</button>' +
    '</div></div>';
  /* Pocket-sized known lengths. The golf ball is the odd one out and the
     interesting one: its visible rim sits one radius above the deck, and layover
     makes the two-tap solve return exactly h - r — so picking it arms a +21.3 mm
     correction, which typing any other value clears. 42.67 mm is written into
     the R&A/USGA rules, so every ball is the same ball. */
  var scaleRow = t.taps.length >= 2
    ? '<div class="field"><label>DISTANCE BETWEEN THE TWO TAPS</label><div class="unit-suffix">' +
    '<input class="inp mono" id="known-len" inputmode="decimal" value="' + esc(t.knownLen) + '"><span>' + U() + '</span></div></div>' +
    '<div class="seg tight">' +
    '<button data-knownlen="0.04267" data-knownz="0.02134">Golf ball</button>' +
    '<button data-knownlen="0.0856" data-knownz="0">Card, long side</button>' +
    '<button data-knownlen="0.6096" data-knownz="0">Paver 24″</button>' +
    '</div>'
    : '<div class="hint">Better than trusting the number above: tap <b>two points on the deck</b> a ' +
    'known distance apart — or the <b>two side edges of a golf ball</b> — and let the app solve ' +
    'your camera height.</div>';

  return modeSeg +
    (haveAtt ? summary + diag : '<div class="panel warn"><span class="p-tag">NO TILT RECORDED</span>' +
      '<div class="p-body">This shot has no attitude, so it can only be calibrated from a measured rectangle.</div></div>') +
    (haveAtt ? (st.deckN
      ? '<div class="kv good"><span>Deck plane</span><span>from gravity</span></div>'
      : '<div class="panel warn"><span class="p-tag">SHOT PREDATES THE LEVELLING</span>' +
      '<div class="p-body">The deck reading is stamped onto a shot when it is taken, so levelling ' +
      'afterwards does not reach it.' + (currentProject().deck ? '' : ' No reading exists yet either.') +
      '</div>' + (currentProject().deck
        ? '<button class="btn primary sm" data-act="relevel">Apply the current reading to this shot</button>'
        : '<button class="btn primary sm" data-act="level-down">Read the deck now</button>') +
      '</div>') : '') +
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
    '<div class="live-row">' +
    '<button class="pill' + (db.settings.cornerSnap ? ' on' : '') + '" data-act="toggle-snap">' +
    '⌖ Corner snap ' + (db.settings.cornerSnap ? 'on' : 'off') + '</button>' +
    (t.lastSnap != null ? '<span class="pill tiny" style="color:var(--green);border-color:rgba(110,210,154,.5)">' +
      'snapped ' + t.lastSnap.toFixed(0) + ' px</span>' : '') +
    (st.att ? '<button class="pill tiny" data-act="trim-pitch" data-d="-1">▲</button>' +
      '<span class="pill tiny' + (db.settings.pitchTrim ? ' gold' : '') + '">horizon ' +
      fmtSigned(db.settings.pitchTrim || 0) + '°</span>' +
      '<button class="pill tiny" data-act="trim-pitch" data-d="1">▼</button>' : '') +
    (st.cal && st.cal.ballCheck ? '<span class="pill tiny' +
      (st.cal.ballCheck.use === 'photo' ? ' gold' : '') + '">' +
      st.cal.ballCheck.balls + ' balls · ' + (st.cal.ballCheck.use === 'photo'
        ? 'photo plane, sensor off ' + st.cal.ballCheck.disagreeDeg.toFixed(1) + '°'
        : 'sensor confirmed ±' + st.cal.ballCheck.sigmaDeg.toFixed(1) + '°') + '</span>' : '') +
    '</div>' +
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
  else if (s.kind === 'rescale') inner = sheetRescale(s);
  else if (s.kind === 'howto') inner = sheetHowTo(s);
  else if (s.kind === 'scaleagree') inner = sheetScaleAgree(s);
  else if (s.kind === 'align') inner = sheetAlign(s);
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
    '<div class="field"><label>NAME</label><div class="unit-suffix">' +
    '<input class="inp" id="so-name" value="' + esc(o.autoName ? '' : (o.name || '')) + '" placeholder="' +
    esc(o.autoName ? o.name : (o.kind === 'point' ? 'NE corner' : 'RTU-1')) + '" autocomplete="off">' +
    '<button class="icon-btn" data-act="clear-name" style="flex:0 0 auto">×</button></div></div>' +
    (o.kind === 'point' ? (function () {
      /* Ties live and die on names matching EXACTLY, so typing one twice is a
         trap — offer every landmark name already in the survey as one tap. */
      var seen = {};
      p.objects.forEach(function (q) {
        if (q.kind === 'point' && q.id !== o.id && q.name && q.stationId !== o.stationId) {
          seen[q.name.trim()] = true;
        }
      });
      var names = Object.keys(seen);
      return names.length
        ? '<div class="live-row" style="flex-wrap:wrap">' + names.slice(0, 8).map(function (nm) {
          return '<button class="pill tiny gold" data-namepick="' + esc(nm) + '">' + esc(nm) + '</button>';
        }).join('') + '</div>' +
        '<div class="hint">Tap a name to tie this landmark to the matching one in another shot.</div>'
        : '';
    })() : '') +
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
    '<div class="kv"><span>Trusted radius</span><span>' + EE.fmtLen(trustedRadius(typicalCamH(currentProject())), U(), 1) + '</span></div>' +
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

/* Rooftop units are almost always parallel to the building. When that is true,
   their rotations are ONE shared unknown rather than N independent ones — so
   snapping them to a common axis removes an entire error mode instead of merely
   tidying the drawing. The agreement figure says whether the assumption holds
   before it is applied. */
function buildingAxis(p) {
  var rects = p.objects.filter(function (o) { return o.kind === 'rect'; });
  if (rects.length < 2) return null;
  var m = EE.meanAngleMod90(rects.map(function (o) {
    var po = projObj(p, o);
    return po ? po.rot : o.rot;
  }));
  return m ? { angle: m.angle, agreement: m.agreement, spreadDeg: m.spreadDeg, n: rects.length } : null;
}

function sheetAlign(s) {
  var p = currentProject();
  var ax = buildingAxis(p);
  if (!ax) {
    return '<div class="sheet-head"><span class="sh-title">Align to the building</span>' +
      '<button class="close-btn" data-act="close-sheet">×</button></div>' +
      '<div class="panel warn"><span class="p-tag">NEED TWO BOXES</span>' +
      '<div class="p-body">Trace at least two rectangles and Eagle Eye can work out the axis they share.</div></div>';
  }
  var good = ax.agreement > 0.9;
  return '<div class="sheet-head"><span class="sh-title">Align to the building</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="p-body">Units on a roof are nearly always parallel to the building. If they are, ' +
    'their rotations are <b>one</b> unknown rather than ' + ax.n + ' — so snapping them to a shared ' +
    'axis removes an error rather than just tidying the plan.</div>' +
    '<div class="panel ' + (good ? 'good' : 'warn') + '">' +
    '<span class="p-tag">' + (good ? 'THEY AGREE' : 'THEY DISAGREE') + '</span>' +
    '<div class="kv"><span>Shared axis</span><span>' + (ax.angle * 180 / Math.PI).toFixed(1) + '°</span></div>' +
    '<div class="kv"><span>Boxes</span><span>' + ax.n + '</span></div>' +
    '<div class="kv ' + (good ? 'good' : 'warn') + '"><span>Spread</span><span>±' +
    ax.spreadDeg.toFixed(1) + '°</span></div>' +
    '<div class="p-body">' + (good
      ? 'Tight enough that a shared axis is a safe assumption.'
      : 'Too scattered to be one axis. Either the units really are at different angles, or a ' +
      'shot is misplaced — check before snapping.') + '</div></div>' +
    '<label class="chk-line"><input type="checkbox" id="al-round" checked> ' +
    'Also round dimensions to the nearest ' + (U() === 'ft' ? 'inch' : '5 cm') + '</label>' +
    '<div class="btn-row"><button class="btn ' + (good ? 'primary' : 'danger') + '" data-act="apply-align">' +
    'Snap ' + ax.n + ' boxes to ' + (ax.angle * 180 / Math.PI).toFixed(1) + '°</button></div>';
}

function applyAlign() {
  var p = currentProject();
  var ax = buildingAxis(p);
  if (!ax) return;
  var roundIt = ($('#al-round') || {}).checked;
  var stepM = U() === 'ft' ? EE.M_PER_FT / 12 : 0.05;
  var n = 0;

  p.objects.forEach(function (o) {
    if (o.kind !== 'rect') return;
    var st = findStation(p, o.stationId);
    var t = stationXform(st);
    /* The axis was measured in the project frame, so it has to come back through
       the station's own rotation before it is stored. */
    var target = ax.angle - (t ? t.theta : 0);
    /* Snap to whichever quarter-turn is nearest, so a unit is not spun 90 deg
       and left describing its width as its length. */
    var d = o.rot - target;
    var k = Math.round(d / (Math.PI / 2));
    o.rot = target + k * (Math.PI / 2);
    if (roundIt) {
      o.w = Math.max(stepM, Math.round(o.w / stepM) * stepM);
      o.l = Math.max(stepM, Math.round(o.l / stepM) * stepM);
    }
    n++;
  });
  touchProject(p); save();
  ui.sheet = null; ui.plan.fitted = false; coverageCache = { key: null, val: null };
  toast('Snapped ' + n + ' boxes to ' + (ax.angle * 180 / Math.PI).toFixed(1) + '°');
  render();
}

function sheetScaleAgree(s) {
  var p = currentProject();
  var sp = scaleSpread(p);
  if (!sp) {
    return '<div class="sheet-head"><span class="sh-title">Scale across shots</span>' +
      '<button class="close-btn" data-act="close-sheet">×</button></div>' +
      '<div class="p-body">Fewer than two calibrated shots — nothing to compare yet.</div>';
  }
  var srcName = function (src) {
    return /^hex/.test(src) ? 'hexagon' : /^ball/.test(src) ? 'golf ball'
      : src === 'map' ? 'map' : /^gravity/.test(src) ? 'reference' : 'rectangle';
  };
  var shotNo = function (id) {
    return p.stations.findIndex(function (q) { return q.id === id; }) + 1;
  };
  var rows = sp.anchored.map(function (x) {
    return '<div class="kv good"><span>Shot ' + shotNo(x.id) + ' · pinned by its ' + srcName(x.src) +
      '</span><span>' + EE.fmtLen(x.h, U(), 2) + '</span></div>';
  }).join('') + sp.assumed.map(function (x) {
    return '<div class="kv warn"><span>Shot ' + shotNo(x.id) + ' · assumed</span><span>' +
      EE.fmtLen(x.h, U(), 2) + '</span></div>';
  }).join('');

  var pick = s.target != null ? s.target
    : (sp.anchored.length ? sp.anchored[sp.anchored.length - 1].h : sp.median);

  var action = sp.assumed.length
    ? '<div class="field"><label>SET THE ASSUMED SHOTS’ CAMERA HEIGHT</label><div class="unit-suffix">' +
    '<input class="inp mono" id="sa-h" inputmode="decimal" value="' + EE.fromM(pick, U()).toFixed(3) +
    '"><span>' + U() + '</span></div></div>' +
    '<div class="hint">This rescales <b>only the assumed shots</b> — the ones whose scale rides ' +
    'on a typed height or an assumed lens. Reference-pinned shots are never touched here; ' +
    'recalibrating a shot is the only way to change what its own reference said.</div>' +
    '<div class="btn-row"><button class="btn primary" data-act="apply-unify">Rescale ' +
    sp.assumed.length + ' assumed shot' + (sp.assumed.length === 1 ? '' : 's') + '</button></div>'
    : '<div class="hint">Nothing to do here: every shot’s scale is pinned by a physical ' +
    'reference. If two of them truly disagree about size, a hexagon tie or the survey ' +
    'adjustment will say so — and the fix is recalibrating the wrong one, never rescaling.</div>';

  return '<div class="sheet-head"><span class="sh-title">Scale across shots</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="p-body"><b>Different heights are normal.</b> Camera height is a per-shot fact — ' +
    'crouch for one shot and stand for the next and both are right. For a shot calibrated on a ' +
    'reference (hexagon, ball, rectangle, map) the height is an <b>output</b> of the calibration, ' +
    'not a knob; only shots with <b>assumed</b> scale have anything to reconcile.</div>' +
    '<div class="panel"><span class="p-tag">' + sp.anchored.length + ' PINNED · ' +
    sp.assumed.length + ' ASSUMED</span>' + rows + '</div>' +
    action;
}

function sheetHowTo() {
  var step = function (n, title, body) {
    return '<div class="chk info"><span class="cg">' + n + '</span>' +
      '<div class="cmain"><span class="ct">' + title + '</span>' +
      '<span class="cd">' + body + '</span></div></div>';
  };
  return '<div class="sheet-head"><span class="sh-title">How to measure well</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +

    '<div class="panel warn"><span class="p-tag">THE ONE RULE</span>' +
    '<div class="p-body">Everything you tap is projected onto the <b>roof deck</b>. So every ' +
    'reference and every traced corner must be something <b>lying flat on the roof</b>.<br><br>' +
    'Tap the side of a unit, a parapet face or a wall and the maths puts it out on the deck ' +
    'where its sight-line lands — metres away. That single mistake is the usual reason a ' +
    'survey measures wrong.</div></div>' +

    '<div class="chk-list">' +
    step(1, 'Stand close', 'Position error grows with the <b>square</b> of distance. Inside ' +
      EE.fmtLen(trustedRadius(typicalCamH(currentProject())), U(), 1) + ' it meets your tolerance; at twice that it is four times worse. ' +
      'Walk to the far units rather than shooting across the roof.') +
    step(2, 'Tilt 25°–65° down', 'The capture screen colours the readout. Too flat and distance ' +
      'error runs away; too steep and you cover almost nothing.') +
    step(3, 'Calibrate on something flat and measured', 'A curb top, a paver, a hatch lid, or two ' +
      'tape measures in an L. Four corners of a rectangle is the accurate route — it needs no lens ' +
      'data, no tilt and no eye-height guess.') +
    step(4, 'Check the green grid', 'After calibrating, a metric grid is painted onto the photo. ' +
      'If those squares do not sit flat and square on the roof, <b>nothing from that shot is worth ' +
      'keeping</b>. Recalibrate.') +
    step(5, 'Trace bases, never tops', 'Tap where an object <b>meets the roof</b>. The top of a ' +
      '1 m unit sits 2.4× further out than it really is, because the deck is where the sight-line lands.') +
    step(6, 'Fix the size afterwards', 'Camera height is a pure scale. If it turns out wrong, one ' +
      'tape measurement rescales the whole survey — every shot, every object — without re-tracing. ' +
      'Check → <b>Correct the scale</b>.') +
    '</div>' +

    '<div class="panel"><span class="p-tag">WHAT IT CANNOT DO</span>' +
    '<div class="p-body">It cannot invent a length. Scale has to come from a tape or a laser once ' +
    'per survey — no amount of photography recovers it. And it is a field aid, not a survey: the ' +
    'stated tolerance is ±' + EE.fmtLen(db.settings.tolerance, U(), 2) + ' inside the trusted radius.</div></div>' +
    '<div class="btn-row"><button class="btn primary" data-act="close-sheet">Got it</button></div>';
}

/* Fix the size of a finished survey from one known dimension. */
function sheetRescale(s) {
  var p = currentProject();
  var mode = s.mode || 'object';
  var dims = [];
  p.objects.forEach(function (o) {
    var po = projObj(p, o);
    if (!po) return;
    if (o.kind === 'rect') {
      dims.push({ id: o.id, k: 'w', label: esc(o.name || 'box') + ' — width', cur: po.w });
      dims.push({ id: o.id, k: 'l', label: esc(o.name || 'box') + ' — length', cur: po.l });
    } else if (o.kind === 'cylinder') {
      dims.push({ id: o.id, k: 'd', label: esc(o.name || 'cylinder') + ' — diameter', cur: po.r * 2 });
    }
  });
  var pts = p.objects.filter(function (o) { return o.kind === 'point' && projObj(p, o); });

  var seg = '<div class="seg tight">' +
    '<button class="' + (mode === 'object' ? 'active' : '') + '" data-rsmode="object">An object</button>' +
    '<button class="' + (mode === 'pair' ? 'active' : '') + '" data-rsmode="pair">Two landmarks</button>' +
    '<button class="' + (mode === 'map' ? 'active' : '') + '" data-rsmode="map">From the map</button>' +
    '</div>';

  if (mode === 'map') {
    var mapBody = pts.length >= 2
      ? '<div class="row2">' +
      '<div class="field"><label>FROM</label><select class="inp" id="rs-a">' +
      pts.map(function (o, i) { return '<option value="' + o.id + '"' + (i === 0 ? ' selected' : '') + '>' + esc(o.name || 'landmark') + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>TO</label><select class="inp" id="rs-b">' +
      pts.map(function (o, i) { return '<option value="' + o.id + '"' + (i === 1 ? ' selected' : '') + '>' + esc(o.name || 'landmark') + '</option>'; }).join('') +
      '</select></div></div>' +
      '<div class="field"><label>COORDINATES OF THE FIRST</label>' +
      '<input class="inp mono" id="rs-lla" value="' + esc(s.llA || '') + '" placeholder="43.761500, -79.508300" autocomplete="off"></div>' +
      '<div class="field"><label>COORDINATES OF THE SECOND</label>' +
      '<input class="inp mono" id="rs-llb" value="' + esc(s.llB || '') + '" placeholder="43.762100, -79.507400" autocomplete="off"></div>' +
      '<div class="hint">Right-click each point in Google Maps and paste. The distance between ' +
      'them becomes the reference, so the further apart the better — over 40 m, half a metre of ' +
      'reading error is about 1%.</div>'
      : '<div class="panel warn"><span class="p-tag">NEED TWO LANDMARKS</span>' +
      '<div class="p-body">Trace two landmark points you can also identify on an aerial.</div></div>';

    return '<div class="sheet-head"><span class="sh-title">Correct the scale</span>' +
      '<button class="close-btn" data-act="close-sheet">×</button></div>' +
      '<div class="p-body">The roof itself is the longest reference on site, and an aerial has ' +
      'already measured it.</div>' +
      '<div class="panel"><span class="p-tag">TWO CAVEATS, BOTH REAL</span>' +
      '<div class="p-body"><b>Read error:</b> aerial runs about 0.15 m/px in town, so a corner is ' +
      'good to roughly half a metre.<br><b>Building lean:</b> an orthophoto is rectified to the ' +
      'ground, so a roof is thrown outward from the image nadir — a 10 m building 40 m across, ' +
      'shot from 600 m, distorts about 0.7 m end to end. Satellite imagery barely leans but is ' +
      'coarser per pixel.</div></div>' +
      seg + mapBody +
      (pts.length >= 2
        ? '<label class="chk-line"><input type="checkbox" id="rs-camh" checked> Also update my default camera height</label>' +
        '<div class="btn-row"><button class="btn primary" data-act="apply-rescale">Rescale the survey</button></div>'
        : '');
  }

  var body;
  if (mode === 'object') {
    body = dims.length
      ? '<div class="field"><label>PICK A DIMENSION YOU HAVE MEASURED</label>' +
      '<select class="inp" id="rs-dim">' + dims.map(function (d, i) {
        return '<option value="' + d.id + ':' + d.k + '"' + (i === 0 ? ' selected' : '') + '>' +
          d.label + ' — now ' + EE.fmtLen(d.cur, U()) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>WHAT IT ACTUALLY MEASURES</label><div class="unit-suffix">' +
      '<input class="inp mono" id="rs-true" inputmode="decimal" placeholder="tape or laser"><span>' + U() + '</span></div></div>'
      : '<div class="panel warn"><span class="p-tag">NOTHING TO SCALE FROM</span>' +
      '<div class="p-body">Trace a box or a cylinder first, then come back and tell Eagle Eye what one of its sides really measures.</div></div>';
  } else {
    body = pts.length >= 2
      ? '<div class="row2">' +
      '<div class="field"><label>FROM</label><select class="inp" id="rs-a">' +
      pts.map(function (o, i) { return '<option value="' + o.id + '"' + (i === 0 ? ' selected' : '') + '>' + esc(o.name || 'landmark') + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>TO</label><select class="inp" id="rs-b">' +
      pts.map(function (o, i) { return '<option value="' + o.id + '"' + (i === 1 ? ' selected' : '') + '>' + esc(o.name || 'landmark') + '</option>'; }).join('') +
      '</select></div></div>' +
      '<div class="field"><label>TRUE DISTANCE BETWEEN THEM</label><div class="unit-suffix">' +
      '<input class="inp mono" id="rs-true" inputmode="decimal" placeholder="laser is best"><span>' + U() + '</span></div></div>'
      : '<div class="panel warn"><span class="p-tag">NEED TWO LANDMARKS</span>' +
      '<div class="p-body">Trace two landmark points first — the further apart the better.</div></div>';
  }

  var applied = totalScaleCorrection(p);

  return '<div class="sheet-head"><span class="sh-title">Correct the scale</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="p-body">Camera height enters as a <b>pure scale</b>: get it wrong and the survey ' +
    'is the right shape at the wrong size. So one known dimension fixes <b>every</b> measurement ' +
    'in <b>every</b> shot at once — nothing has to be re-traced.</div>' +
    '<div class="panel warn"><span class="p-tag">MEASURE FLAT ON THE ROOF</span>' +
    '<div class="p-body">Use something lying <b>on the deck</b> — a curb, a paver, a kerb run. ' +
    'A wall, a parapet face or the side of a unit is <b>vertical</b>, and every calculation here ' +
    'projects onto the deck, so a vertical reference comes out badly wrong. That is the most ' +
    'likely cause of a survey that measures short or long.</div></div>' +
    seg + body +
    (Math.abs(applied - 1) > 1e-9
      ? '<div class="kv"><span>Already corrected by</span><span>' + fmtSigned((applied - 1) * 100) + '%</span></div>'
      : '') +
    (dims.length || pts.length >= 2
      ? '<label class="chk-line"><input type="checkbox" id="rs-camh" checked> Also update my default camera height</label>' +
      '<div class="btn-row"><button class="btn primary" data-act="apply-rescale">Rescale the survey</button></div>'
      : '') +
    ((p.scaleLog || []).length ? '<button class="btn ghost sm" data-act="undo-rescale">Undo the last correction</button>' : '');
}

function applyRescale() {
  var p = currentProject();
  var s = ui.sheet;
  var trueV = EE.toM(parseFloat(($('#rs-true') || {}).value), U());
  if (s.mode !== 'map' && !(trueV > 0)) return toast('Enter the measured value');

  var cur = 0, what = '';
  if (s.mode === 'map') {
    var am = planPointOf(p, ($('#rs-a') || {}).value);
    var bm = planPointOf(p, ($('#rs-b') || {}).value);
    var lla = parseLL(($('#rs-lla') || {}).value), llb = parseLL(($('#rs-llb') || {}).value);
    if (!am || !bm) return toast('Pick two landmarks');
    if (!lla || !llb) return toast('Paste both coordinates as "lat, lon"');
    var en = EE.latLonToEastNorth(llb, lla);
    trueV = Math.hypot(en.e, en.n);
    if (!(trueV > 1)) return toast('Those coordinates are less than a metre apart');
    cur = Math.hypot(am.x - bm.x, am.y - bm.y);
    what = 'aerial, ' + trueV.toFixed(1) + ' m apart';
  } else if ((s.mode || 'object') === 'object') {
    var sel = ($('#rs-dim') || {}).value || '';
    var parts = sel.split(':');
    var o = p.objects.find(function (q) { return q.id === parts[0]; });
    var po = o && projObj(p, o);
    if (!po) return toast('Pick a dimension');
    cur = parts[1] === 'w' ? po.w : parts[1] === 'l' ? po.l : po.r * 2;
    what = (o.name || 'object') + ' ' + parts[1];
  } else {
    var a = planPointOf(p, ($('#rs-a') || {}).value);
    var b = planPointOf(p, ($('#rs-b') || {}).value);
    if (!a || !b) return toast('Pick two landmarks');
    cur = Math.hypot(a.x - b.x, a.y - b.y);
    what = 'landmark pair';
  }
  if (!(cur > 1e-6)) return toast('That dimension is zero');

  var k = trueV / cur;
  if (k < 0.2 || k > 5) {
    return toast('That would rescale by ' + ((k - 1) * 100).toFixed(0) + '% — check you measured the same thing');
  }

  applyScaleCorrection(p, k, what);
  if (($('#rs-camh') || {}).checked) db.settings.camH *= k;
  save();
  ui.sheet = null; ui.plan.fitted = false; coverageCache = { key: null, val: null };
  toast('Rescaled ' + fmtSigned((k - 1) * 100) + '% from ' + what);
  render();
}

function sheetSettings() {
  var s = db.settings;
  return '<div class="sheet-head"><span class="sh-title">Settings</span>' +
    '<button class="close-btn" data-act="close-sheet">×</button></div>' +
    '<div class="field"><label>UNITS</label><div class="seg tight">' +
    '<button class="' + (s.unit === 'm' ? 'active' : '') + '" data-unit="m">metres</button>' +
    '<button class="' + (s.unit === 'ft' ? 'active' : '') + '" data-unit="ft">feet</button></div></div>' +
    /* Measured beats typed, so once the lens has been measured the input is not
       offered — it exists as a fallback for a camera that has never calibrated,
       and leaving it editable invites overwriting a real measurement with a
       guess. Forgetting it is explicit and reversible. */
    (s.fovAt
      ? '<div class="panel good"><span class="p-tag">LENS — MEASURED</span>' +
      '<div class="kv"><span>Field of view</span><span>' + s.fov.toFixed(2) + '°</span></div>' +
      '<div class="kv"><span>From</span><span>' + esc(s.fovFrom || 'camera') + '</span></div>' +
      '<div class="p-body">Read off the four corners of a calibration rectangle, so it is the ' +
      'real figure for whichever lens Safari selected. Nothing here needs adjusting.</div>' +
      '<button class="btn ghost sm" data-act="forget-fov">Forget it and go back to assuming</button></div>'
      : '<div class="panel warn"><span class="p-tag">LENS — ASSUMED</span>' +
      '<div class="field"><label>FIELD OF VIEW (° ACROSS THE LONG EDGE)</label>' +
      '<input class="inp mono" id="set-fov" inputmode="decimal" value="' + s.fov + '"></div>' +
      '<div class="p-body">A guess until something measures it. Calibrate once from a large ' +
      'rectangle and Eagle Eye reads the real value off the same four corners — that is far ' +
      'better than any number typed here.</div></div>') +

    '<div class="field"><label>STARTING CAMERA HEIGHT FOR A NEW SHOT</label><div class="unit-suffix">' +
    '<input class="inp mono" id="set-camh" inputmode="decimal" value="' + EE.fromM(s.camH, s.unit).toFixed(2) + '"><span>' + s.unit + '</span></div></div>' +
    '<div class="hint">Only a starting value, to save retyping. <b>Every shot stores its own ' +
    'height</b> once calibrated, and that is what its measurements and its trusted radius use.</div>' +
    '<div class="field"><label>YOUR PHONE, MEASURED (W × L)</label><div class="row2">' +
    '<div class="unit-suffix"><input class="inp mono" id="set-phw" inputmode="decimal" value="' +
    EE.fromM(s.phoneW, s.unit).toFixed(4) + '"><span>' + s.unit + '</span></div>' +
    '<div class="unit-suffix"><input class="inp mono" id="set-phl" inputmode="decimal" value="' +
    EE.fromM(s.phoneL, s.unit).toFixed(4) + '"><span>' + s.unit + '</span></div></div></div>' +
    '<div class="hint">Measure the handset itself with a rule — a spec sheet quotes the design ' +
    'size, and a case changes it. This is the reference of last resort; it is small, so the ' +
    'calibration screen will tell you what that costs.</div>' +
    '<div class="field"><label>CIRCLE SEGMENTS PER CYLINDER</label>' +
    '<input class="inp mono" id="set-seg" inputmode="numeric" value="' + s.circleSegments + '"></div>' +
    '<div class="field"><label>PHOTO LONG EDGE (PX)</label>' +
    '<input class="inp mono" id="set-maxpx" inputmode="numeric" value="' + s.maxPx + '"></div>' +
    '<div class="kv"><span>Photos stored</span><span>' + fmtBytes(ui.storageBytes) + '</span></div>' +
    '<div class="kv"><span>Version</span><span>' + VERSION + '</span></div>' +
    '<button class="btn ghost-gold sm" data-act="check-update">Check for an update</button>' +
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
      g.beginPath(); g.arc(sx, sy, trustedRadius(st.cal && st.cal.camH) * S, 0, Math.PI * 2); g.stroke();
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
/* The photo's placement inside the canvas.

   This used to be computed once and kept forever, which was a real bug rather
   than an inefficiency: the footer is much taller while calibrating than while
   tracing, so the view was fitted to a short canvas and then never grew when the
   canvas did. The photo sat at 63% of the size it could have been, and since a
   tap is converted through this same scale, every tap was landing on a coarser
   grid than it needed to — about 4.7 image pixels per screen pixel instead of
   2.9. Refit whenever the box changes, unless the user has pinched, in which case
   their zoom is the intent and must be left alone. */
function traceView(st, w, h) {
  var t = ui.trace;
  var v = t.view;
  var stale = !v || (!v.userZoom && (Math.abs(v.boxW - w) > 1 || Math.abs(v.boxH - h) > 1));
  if (stale && w > 0 && h > 0) {
    var s = Math.min(w / st.imgW, h / st.imgH);
    t.view = {
      s: s, ox: (w - st.imgW * s) / 2, oy: (h - st.imgH * s) / 2,
      base: s, boxW: w, boxH: h, userZoom: false
    };
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

  /* The horizon, drawn wherever the calibration thinks it is.

     This is the single most diagnostic thing on the screen. The vanishing line is
     two of the eight numbers in the homography, and when a calibration goes wrong
     it is almost always these two. If the red line does not sit on the real
     horizon — or the real roof edge, when the horizon is out of frame — nothing
     from this shot is worth keeping, and no amount of scale correction will fix
     it. Drawn in both steps, because it is most useful while calibrating. */
  var drawHorizon = function (line, col, label, dash) {
    if (!line) return null;
    var a = img2cv(v, { x: line.x0, y: line.y0 }), b = img2cv(v, { x: line.x1, y: line.y1 });
    g.save();
    g.font = '600 12px ui-monospace, monospace';

    /* An off-frame horizon must SAY it is off-frame. Clamping the label to the
       top of the canvas made a steep close-up look like the app believed the
       horizon sat at the top of the photo — a UI lie that read as a broken
       calibration. */
    var yMid = (line.y0 + line.y1) / 2;
    if (line.y0 < -2 && line.y1 < -2 && !line.steep) {
      var top = img2cv(v, { x: st.imgW / 2, y: 0 });
      var chip = label + '  ⇡ ' + Math.round(-yMid) + ' px above the photo';
      var cw2 = g.measureText(chip).width;
      g.fillStyle = 'rgba(12,10,16,0.82)';
      g.fillRect(top.x - cw2 / 2 - 7, Math.max(2, top.y + 4), cw2 + 14, 17);
      g.fillStyle = col;
      g.fillText(chip, top.x - cw2 / 2, Math.max(14, top.y + 16));
      g.restore();
      return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    }
    if (line.y0 > st.imgH + 2 && line.y1 > st.imgH + 2 && !line.steep) {
      var bot = img2cv(v, { x: st.imgW / 2, y: st.imgH });
      var chip2 = label + '  ⇣ ' + Math.round(yMid - st.imgH) + ' px below the photo';
      var cw3 = g.measureText(chip2).width;
      g.fillStyle = 'rgba(12,10,16,0.82)';
      g.fillRect(bot.x - cw3 / 2 - 7, Math.min(h - 20, bot.y - 22), cw3 + 14, 17);
      g.fillStyle = col;
      g.fillText(chip2, bot.x - cw3 / 2, Math.min(h - 8, bot.y - 9));
      g.restore();
      return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    }

    g.strokeStyle = col; g.lineWidth = 2.5; g.setLineDash(dash);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.setLineDash([]);
    var tw = g.measureText(label).width;
    var ly = Math.max(14, Math.min(h - 6, a.y - 8));
    g.fillStyle = 'rgba(12,10,16,0.82)';
    g.fillRect(6, ly - 12, tw + 12, 17);
    g.fillStyle = col;
    g.fillText(label, 12, ly);
    g.restore();
    return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  };

  /* Two horizons, deliberately.

     The calibration's horizon comes from the four tapped corners. The gravity one
     comes from the phone's own attitude and needs no calibration at all — and,
     usefully, no camera height either: the vanishing line of the deck is the
     third row of the pose homography, which h never touches.

     So they are independent, and their disagreement is a direct read on whether
     the calibration is sound. If the phone was upright and the red line is
     tilted, the reference rectangle is wrong — which is exactly the failure a
     swapped pair of side lengths produces. */
  var calH = map ? (st.cal.mode === 'quad' ? st.cal.H : stationH(st)) : null;
  var calAng = null, gravAng = null;
  if (st.att) {
    var Rg = attMatrix(st.att);
    var fg = (st.cal && st.cal.f) || stationF(st);
    var Hg = EE.homographyFromPose(Rg, 1, fg, st.imgW, st.imgH, effAngle(st), deckNormalOf(st));
    gravAng = drawHorizon(EE.horizonLine(Hg, st.imgW, st.imgH),
      'rgba(110,210,154,0.85)', 'horizon · gravity', [4, 5]);
  }
  if (calH) {
    calAng = drawHorizon(EE.horizonLine(calH, st.imgW, st.imgH),
      'rgba(224,137,125,0.95)', 'horizon · calibration', [12, 7]);
  }
  if (calAng != null && gravAng != null) {
    var dA = Math.abs(((calAng - gravAng + 180) % 180 + 180) % 180);
    if (dA > 90) dA = 180 - dA;
    t.horizonDisagree = dA;
    if (dA > 3) {
      g.save();
      g.font = '600 12px ui-monospace, monospace';
      var m2 = 'horizons disagree by ' + dA.toFixed(0) + '°';
      var mw = g.measureText(m2).width;
      g.fillStyle = 'rgba(201,106,94,0.92)';
      g.fillRect(6, h - 26, mw + 12, 19);
      g.fillStyle = '#2A0F0B';
      g.fillText(m2, 12, h - 13);
      g.restore();
    }
  } else t.horizonDisagree = null;

  /* A suspect calibration must LOOK suspect, on the photo, while tracing. */
  if (st.cal && st.cal.suspect) {
    g.save();
    g.font = '600 12px ui-monospace, monospace';
    var sm = 'perspective unreliable — reference too small; recalibrate on something larger';
    var smw = g.measureText(sm).width;
    g.fillStyle = 'rgba(212,175,55,0.94)';
    g.fillRect(6, 6, smw + 12, 19);
    g.fillStyle = '#2A0F0B';
    g.fillText(sm, 12, 19);
    g.restore();
  }

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
      (t.step === 'cal' && t.calMode === 'hex' && pts.length === 6) ||
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

  /* horizon picking: mark the first tap so the second has something to aim with */
  if (t.horizonPick && t.horizonPick.length === 1) {
    var hp = img2cv(v, t.horizonPick[0]);
    g.strokeStyle = '#D4AF37'; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(hp.x - 12, hp.y); g.lineTo(hp.x + 12, hp.y);
    g.moveTo(hp.x, hp.y - 12); g.lineTo(hp.x, hp.y + 12);
    g.stroke();
  }

  /* ball mode: banked balls first — green when locked, dashed gold when taken
     on trust — each wearing its letter. */
  if (t.step === 'cal' && t.calMode === 'ball' && (t.balls || []).length) {
    t.balls.forEach(function (b, i) {
      var cc = img2cv(v, { x: b.cx, y: b.cy });
      var cr = b.r * v.s;
      g.strokeStyle = b.locked ? '#6ED29A' : '#D4AF37';
      g.lineWidth = 2;
      if (!b.locked) g.setLineDash([6, 5]);
      g.beginPath(); g.arc(cc.x, cc.y, cr, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
      g.font = '700 12px ui-monospace, monospace';
      g.fillStyle = 'rgba(12,10,16,0.82)';
      g.fillRect(cc.x - 9, cc.y - 9, 18, 18);
      g.fillStyle = b.locked ? '#6ED29A' : '#D4AF37';
      g.textAlign = 'center';
      g.fillText(String.fromCharCode(65 + i), cc.x, cc.y + 4);
      g.textAlign = 'left';
    });
  }

  /* the circle IS the interface. Live while dragging the radius out,
     gold for the circle as placed, green once the refiner has locked the rim. */
  if (t.step === 'cal' && t.calMode === 'ball' && t.taps.length >= 1) {
    var bc = img2cv(v, t.taps[0]);
    var rimSrc = t.taps.length >= 2 ? t.taps[1] : (t.loupe ? t.loupe.img : null);
    if (rimSrc) {
      var rc2 = img2cv(v, rimSrc);
      var rad2 = Math.hypot(rc2.x - bc.x, rc2.y - bc.y);
      if (rad2 > 3) {
        g.strokeStyle = '#D4AF37'; g.lineWidth = 2; g.setLineDash([6, 5]);
        g.beginPath(); g.arc(bc.x, bc.y, rad2, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
      }
    }
    if (t.ballFit) {
      var fc = img2cv(v, { x: t.ballFit.cx, y: t.ballFit.cy });
      var fr = t.ballFit.r * v.s;
      g.strokeStyle = '#6ED29A'; g.lineWidth = 2.5;
      g.beginPath(); g.arc(fc.x, fc.y, fr, 0, Math.PI * 2); g.stroke();
      var pl = img2cv(v, { x: t.ballFit.xL, y: t.ballFit.cy });
      var pr = img2cv(v, { x: t.ballFit.xR, y: t.ballFit.cy });
      g.beginPath(); g.moveTo(pl.x, pl.y); g.lineTo(pr.x, pr.y); g.stroke();
      var bl = 'Ø ' + t.ballFit.dh.toFixed(1) + ' px';
      g.font = '600 13px ui-monospace, monospace';
      var bw2 = g.measureText(bl).width;
      g.fillStyle = 'rgba(12,10,16,0.82)';
      g.fillRect(fc.x - bw2 / 2 - 7, fc.y - fr - 30, bw2 + 14, 22);
      g.fillStyle = '#6ED29A'; g.textAlign = 'center';
      g.fillText(bl, fc.x, fc.y - fr - 14); g.textAlign = 'left';
    }
  }

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
    /* Claim the gesture before iOS can decide it was a long-press selection. */
    if (e.cancelable) e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* already captured */ }
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
  /* A cancel is NOT a finish, and treating them the same was the bug behind taps
     landing where the drag started. iOS fires pointercancel when it decides your
     press was a text selection or a callout — the blue flash and the system
     magnifier — and the move events stop arriving at that instant. Committing on
     cancel therefore commits the last position that got through, which is
     wherever the finger went down. An aborted gesture must place nothing. */
  var end = function (e, committed) {
    if (!(e.pointerId in pts)) return;
    var p = pts[e.pointerId];
    delete pts[e.pointerId];
    if (count() === 0) {
      if (committed) { if (opts.onUp) opts.onUp(p); }
      else if (opts.onCancel) opts.onCancel(p);
      last = null;
    } else last = { c: centroid(), d: spread() };
  };
  el.addEventListener('pointerup', function (e) { end(e, true); });
  el.addEventListener('pointercancel', function (e) { end(e, false); });
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
      '[data-station],[data-setheight],[data-chk],[data-rsmode],[data-refpreset],[data-anglefix],[data-swipe],[data-knownlen],[data-namepick]');
    if (!el) return;
    handle(el, e);
  };

  if (view.screen === 'home') bindSwipe();
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

/* Swipe a survey card left to uncover Delete.

   The card slides; the action sits underneath. Horizontal intent is required
   before anything moves, so a vertical flick still scrolls the list, and the
   card's own tap is suppressed for the swipe that opened it. */
function bindSwipe() {
  $$('[data-swipe]').forEach(function (wrap) {
    var card = wrap.querySelector('.proj-card');
    var id = wrap.dataset.swipe;
    var x0 = 0, y0 = 0, dx = 0, active = false, decided = false;
    var W = 96;

    wrap.addEventListener('pointerdown', function (e) {
      x0 = e.clientX; y0 = e.clientY; dx = 0; active = true; decided = false;
      card.style.transition = 'none';
    });
    wrap.addEventListener('pointermove', function (e) {
      if (!active) return;
      var mx = e.clientX - x0, my = e.clientY - y0;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true;
        if (Math.abs(my) > Math.abs(mx)) { active = false; return; }  /* let it scroll */
        wrap.setPointerCapture(e.pointerId);
      }
      dx = Math.max(-W, Math.min(0, mx + (ui.swipe === id ? -W : 0)));
      card.style.transform = 'translateX(' + dx + 'px)';
    });
    var settle = function () {
      if (!active) return;
      active = false;
      card.style.transition = 'transform 0.16s ease';
      var open = dx < -W / 2;
      card.style.transform = 'translateX(' + (open ? -W : 0) + 'px)';
      ui.swipe = open ? id : null;
      if (decided) wrap.dataset.suppress = '1';
    };
    wrap.addEventListener('pointerup', settle);
    wrap.addEventListener('pointercancel', settle);
    /* Swallow the click that ends a swipe, so opening the tray never opens the survey. */
    card.addEventListener('click', function (e) {
      if (wrap.dataset.suppress) {
        delete wrap.dataset.suppress;
        e.stopPropagation(); e.preventDefault();
      }
    }, true);
  });
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

  /* Coordinate fields store on every keystroke but only re-render on blur —
     re-rendering mid-word would tear the input out from under the keyboard. */
  $$('[data-mapll]').forEach(function (el) {
    var i = parseInt(el.dataset.mapll, 10);
    el.oninput = function () { (t.mapLL || (t.mapLL = []))[i] = el.value; };
    el.onchange = function () { (t.mapLL || (t.mapLL = []))[i] = el.value; render(); };
  });

  /* A hand-typed length is not a golf ball: clear the resting-height correction. */
  var kl = $('#known-len');
  if (kl) kl.oninput = function () { t.knownLen = kl.value; t.knownZ = 0; };
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
      v.userZoom = true;          /* their zoom now outranks any auto-refit */
      paintTrace();
    },
    onUp: function () {
      if (t.loupe) {
        var ip = t.loupe.img;
        if (ip.x >= 0 && ip.y >= 0 && ip.x <= st.imgW && ip.y <= st.imgH) {
          /* The ball selector wants the raw finger: a corner snap would drag the
             centre onto a dimple or a logo, and the rim refiner does the real
             locking anyway. */
          /* Horizon picking outranks everything: two taps on the far horizon,
             then the shot's attitude is corrected from the photo. */
          if (t.horizonPick) {
            t.horizonPick.push({ x: ip.x, y: ip.y });
            t.loupe = null; hideLoupe();
            if (t.horizonPick.length >= 2) applyHorizonLock(st);
            else render();
            return;
          }
          var ballMode = t.step === 'cal' && t.calMode === 'ball';
          if (ballMode && (t.balls || []).length >= 3) {
            toast('Three balls is the full house — Undo removes the last one');
            t.loupe = null; hideLoupe(); render();
            return;
          }
          var s = ballMode ? ip : snapTap(st, ip);
          if (s.snapped) buzz(15);
          t.lastSnap = s.snapped ? s.moved : null;
          addTap({ x: s.x, y: s.y });
          if (ballMode && t.taps.length >= 2) {
            t.ballFit = refineBall(st);
            if (t.ballFit) buzz([25, 40, 25]);
          }
        }
      }
      t.loupe = null; hideLoupe();
      render();
    },
    /* iOS took the gesture for itself. Drop it silently rather than placing a
       point somewhere the finger was only passing through. */
    onCancel: function () {
      t.loupe = null; hideLoupe();
      paintTrace();
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

/* Pull the tap onto the nearest real corner.

   A finger is about 3 px honest even with the loupe, and inside the trusted
   radius that is the dominant error. A corner is exactly locatable from the
   pixels, so the tap only needs to say WHICH corner. Refusing to snap when the
   patch is featureless matters as much as snapping when it is not — a blank
   membrane must not produce a confident answer out of sensor noise. */
var snapCv = null;
function snapTap(st, ip) {
  if (!db.settings.cornerSnap) return ip;
  var im = ui.imgCache[st.id];
  if (!im) return ip;

  var rad = 21, N = rad * 2 + 1;
  var sx = Math.round(ip.x) - rad, sy = Math.round(ip.y) - rad;
  if (sx < 0 || sy < 0 || sx + N > st.imgW || sy + N > st.imgH) return ip;

  if (!snapCv) snapCv = document.createElement('canvas');
  snapCv.width = N; snapCv.height = N;
  var g = snapCv.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, sx, sy, N, N, 0, 0, N, N);
  var d;
  try { d = g.getImageData(0, 0, N, N).data; } catch (e) { return ip; }

  var gray = new Float32Array(N * N);
  for (var i = 0; i < N * N; i++) {
    gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  var c = EE.bestCorner(gray, N, N, 7);
  if (!c || c.ratio < 6 || c.lambda < 400) return ip;

  /* bestCorner picks the right pixel; this finds where inside it the corner
     really is. Roughly a tenth of a pixel, against about three for a finger. */
  var r = EE.refineCorner(gray, N, N, c.x, c.y, 5, 8);
  var moved = Math.hypot(sx + r.x - ip.x, sy + r.y - ip.y);
  /* A snap is a REFINEMENT of the finger, not a second opinion. The loupe puts
     a tap within ~3 px; a "corner" nine or more pixels away is a different
     feature \u2014 a neighbouring panel corner, a carpet seam \u2014 and jumping to it
     is how points land where nobody put them. */
  if (moved > 9) return ip;
  return {
    x: sx + r.x, y: sy + r.y, snapped: true,
    moved: moved
  };
}

function addTap(ip) {
  var t = ui.trace;
  var lim = t.step === 'cal'
    ? (t.calMode === 'quad' ? 4 : t.calMode === 'hex' ? 6 : t.calMode === 'map' ? 5 : 2)
    : (t.tool === 'point' ? 1 : (t.tool === 'height' ? 2 : 64));
  if (t.taps.length >= lim) t.taps.shift();
  t.taps.push(ip);
}

/* ================= actions ================= */

function handle(el, e) {
  var p = currentProject();
  var act = el.dataset.act;

  if (el.dataset.namepick != null) {
    var np = $('#so-name');
    if (np) np.value = el.dataset.namepick;
    return;
  }
  if (el.dataset.open) { view.projectId = el.dataset.open; view.screen = 'project'; view.tab = 'plan'; ui.plan.fitted = false; ui.sel = null; return render(); }
  if (el.dataset.tab) { view.tab = el.dataset.tab; return render(); }
  if (el.dataset.tool) { ui.trace.tool = el.dataset.tool; ui.trace.taps = []; return render(); }
  if (el.dataset.calmode) { ui.trace.calMode = el.dataset.calmode; ui.trace.taps = []; ui.trace.ballFit = null; ui.trace.balls = []; ui.trace.horizonPick = null; return render(); }
  if (el.dataset.unit) { db.settings.unit = el.dataset.unit; save(); return render(); }
  if (el.dataset.nameunit) { db.settings.nameUnit = el.dataset.nameunit; save(); return render(); }
  if (el.dataset.geomethod) { ui.sheet.method = el.dataset.geomethod; return render(); }
  if (el.dataset.srmethod) { ui.sheet.method = el.dataset.srmethod; return render(); }
  if (el.dataset.rsmode) { ui.sheet.mode = el.dataset.rsmode; return render(); }
  if (el.dataset.knownlen) {
    ui.trace.knownLen = EE.fromM(parseFloat(el.dataset.knownlen), U()).toFixed(5);
    ui.trace.knownZ = parseFloat(el.dataset.knownz) || 0;
    return render();
  }
  if (el.dataset.anglefix) {
    var stn = findStation(p, ui.trace.stationId);
    stn.angleFix = parseInt(el.dataset.anglefix, 10);
    touchProject(p); save();
    return render();
  }
  if (el.dataset.refpreset) {
    var r = REF_PRESETS[parseInt(el.dataset.refpreset, 10)];
    var w = r.w == null ? db.settings.phoneW : r.w;
    var l = r.l == null ? db.settings.phoneL : r.l;
    if (!(w > 0) || !(l > 0)) { toast('Measure your phone in Settings first'); return; }
    ui.trace.refW = EE.fromM(w, U()).toFixed(4);
    ui.trace.refL = EE.fromM(l, U()).toFixed(4);
    toast(esc(r.label) + ' — ' + EE.fmtLen(w, U(), 3) + ' × ' + EE.fmtLen(l, U(), 3));
    return render();
  }
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
    if (a === 'scaleagree') { ui.sheet = { kind: 'scaleagree' }; return render(); }
    if (a === 'rescale') { ui.sheet = { kind: 'rescale', mode: 'object' }; return render(); }
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
    case 'rescale': ui.sheet = { kind: 'rescale', mode: 'object' }; return render();
    case 'howto': ui.sheet = { kind: 'howto' }; return render();
    case 'scaleagree': ui.sheet = { kind: 'scaleagree' }; return render();
    case 'apply-unify': {
      var th = EE.toM(parseFloat(($('#sa-h') || {}).value), U());
      if (!(th > 0.2 && th < 30)) return toast('Enter a plausible camera height');
      var n = unifyScale(p, th);
      ui.sheet = null;
      toast(n + (n === 1 ? ' assumed-scale shot' : ' assumed-scale shots') + ' now at ' +
        EE.fmtLen(th, U(), 2) +
        (unifyScale.lastSkipped ? ' — ' + unifyScale.lastSkipped +
          ' reference-pinned shot' + (unifyScale.lastSkipped === 1 ? '' : 's') + ' left untouched' : ''));
      return render();
    }
    case 'toggle-diag': ui.trace.showDiag = !ui.trace.showDiag; return render();
    case 'swap-ref': ui.trace.refSwap = !ui.trace.refSwap; return render();
    case 'toggle-snap': db.settings.cornerSnap = !db.settings.cornerSnap; save(); return render();
    case 'trim-pitch': {
      var dtp = parseFloat(el.dataset.d) * 0.2;
      var beforeP = db.settings.pitchTrim || 0;
      db.settings.pitchTrim = Math.max(-10, Math.min(10, +((beforeP + dtp).toFixed(1))));
      if (db.settings.pitchTrim === beforeP) {
        toast('Trim is capped at ±10° — a horizon further off than that is not sensor bias. Run the sensor check under Check → the deck panel, and hold still at the shutter.');
      }
      save(); return render();
    }
    case 'trim-roll': {
      var dtr = parseFloat(el.dataset.d) * 0.2;
      db.settings.rollTrim = Math.max(-6, Math.min(6, +(((db.settings.rollTrim || 0) + dtr).toFixed(1))));
      save(); return render();
    }
    case 'trim-reset': db.settings.pitchTrim = 0; db.settings.rollTrim = 0; save(); return render();
    case 'level-up': return startLevel(false);
    case 'level-down': return startLevel(true);
    case 'level-check': return startLevel(true, true);
    case 'level-cancel': clearInterval(ui.levelTimer); ui.level = null; return render();
    case 'clear-deck': { p.deck = null; touchProject(p); save(); toast('Deck reading cleared'); return render(); }
    case 'del-survey': {
      var tgt = db.projects.find(function (q) { return q.id === el.dataset.id; });
      if (!tgt) return;
      ui.sheet = {
        kind: 'confirm', title: 'Delete ' + tgt.name + '?',
        body: tgt.stations.length + ' shot' + (tgt.stations.length === 1 ? '' : 's') + ' and ' +
          tgt.objects.length + ' object' + (tgt.objects.length === 1 ? '' : 's') + ' go with it. This cannot be undone.',
        yes: 'Delete survey', on: 'del-survey', id: tgt.id
      };
      return render();
    }
    case 'del-station': {
      var sid = el.dataset.id;
      var stn = findStation(p, sid);
      if (!stn) return;
      var owned = objectsOf(p, sid).length;
      ui.sheet = {
        kind: 'confirm', title: 'Delete this shot?',
        body: owned
          ? owned + (owned === 1 ? ' object was' : ' objects were') + ' traced from it, and will go too.'
          : 'Nothing has been traced from it.',
        yes: 'Delete shot', on: 'del-station', id: sid
      };
      return render();
    }
    case 'relevel': {
      var rst = findStation(p, ui.trace.stationId);
      if (!p.deck) return toast('Read the deck first');
      rst.deckN = p.deck.n.slice();
      touchProject(p); save();
      toast('Applied the ' + p.deck.tiltDeg.toFixed(1) + '° reading to this shot');
      return render();
    }
    case 'align': ui.sheet = { kind: 'align' }; return render();
    case 'apply-align': return applyAlign();
    case 'apply-rescale': return applyRescale();
    case 'undo-rescale': {
      var log = p.scaleLog || [];
      if (!log.length) return;
      var last = log.pop();
      applyScaleCorrection(p, 1 / last.k, 'undo');
      (p.scaleLog || []).pop();          /* drop the undo entry too */
      p.scaleLog = log;
      save(); ui.plan.fitted = false; coverageCache = { key: null, val: null };
      toast('Reverted ' + fmtSigned((last.k - 1) * 100) + '%');
      return render();
    }
    case 'ask-motion': return startSensors().then(function (okd) {
      if (!okd) toast('Tilt sensor refused — use the rectangle route');
      render();
    });
    case 'shoot': return shoot();

    case 'close-trace': ui.trace = null; view.screen = 'project'; ui.plan.fitted = false; return render();
    case 'undo-tap': {
      var tu = ui.trace;
      /* In ball mode, once the current selector is empty, Undo starts eating the
         banked balls — last in, first out. */
      if (tu.calMode === 'ball' && tu.step === 'cal' && !tu.taps.length && (tu.balls || []).length) {
        tu.balls.pop();
      } else {
        tu.taps.pop();
      }
      tu.ballFit = tu.taps.length >= 2 ? tu.ballFit : null;
      return render();
    }
    case 'apply-quad': return applyQuad();
    case 'apply-hex': return applyHex();
    case 'apply-map': return applyMap();
    case 'apply-ball': return applyBall();
    case 'ball-add': return commitBall();
    case 'horizon-pick': {
      ui.trace.horizonPick = ui.trace.horizonPick ? null : [];
      return render();
    }
    case 'horizon-unlock': {
      var sth = findStation(p, ui.trace.stationId);
      if (sth && sth.att && sth.att.raw) {
        sth.att.alpha = sth.att.raw.alpha; sth.att.beta = sth.att.raw.beta;
        sth.att.gamma = sth.att.raw.gamma;
        delete sth.att.horizonLocked; delete sth.att.raw;
        /* The calibration was solved UNDER the lock; without a re-fit it lies
           by exactly the lock's angle — the field measured 22%. */
        var refitU = sth.cal && sth.cal.hexPix && refitHexStation(p, sth);
        touchProject(p); save();
        coverageCache = { key: null, val: null };
        ui.plan.fitted = false;
        toast('Horizon lock removed — back to the sensor\'s attitude' +
          (refitU ? '; the hexagon calibration re-fitted to match' : ''));
      }
      return render();
    }
    case 'adjust-survey': return runAdjust(p, true);
    case 'apply-ray': return applyRay();
    case 'recal': ui.trace.step = 'cal'; ui.trace.taps = []; ui.trace.view = null; return render();
    case 'commit-shape': return commitShape();

    case 'edit-object': ui.sheet = { kind: 'object', id: el.dataset.id || ui.sel }; return render();
    case 'save-object': return saveObjectSheet();
    case 'clear-name': {
      var cn = $('#so-name');
      if (cn) { cn.value = ''; cn.focus && cn.focus(); }
      return;
    }
    case 'delete-object': return deleteObject();
    case 'del-object-row': {
      var oid = el.dataset.id;
      var oDel = p.objects.find(function (q) { return q.id === oid; });
      if (!oDel) return;
      if (!confirm('Delete "' + (oDel.name || oDel.kind) + '"?')) return;
      p.objects = p.objects.filter(function (q) { return q.id !== oid; });
      if (ui.sel === oid) ui.sel = null;
      touchProject(p); save();
      ui.plan.fitted = false;
      toast('Deleted');
      return render();
    }
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
      if (t) maybeAutoAdjust(p);
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
      toast('Trusted radius now ' + EE.fmtLen(trustedRadius(typicalCamH(p)), U(), 1));
      return render();
    }
    case 'forget-fov': {
      db.settings.fovAt = null; db.settings.fovFrom = null; save();
      toast('Lens is an assumption again — ' + db.settings.fov.toFixed(1) + '°');
      return render();
    }
    case 'check-update': return checkForUpdate(true);
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
    case 'export-debug': return exportDebug();
    case 'export-debug-full': return exportDebugFull();
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
  if (s.on === 'del-project' || s.on === 'del-survey') {
    var tgt = s.id ? db.projects.find(function (q) { return q.id === s.id; }) : p;
    if (tgt) {
      tgt.stations.forEach(function (st) {
        IDB.del(photoKey(st.id));
        delete ui.imgCache[st.id];
        if (ui.urlCache[st.id]) { URL.revokeObjectURL(ui.urlCache[st.id]); delete ui.urlCache[st.id]; }
      });
      db.projects = db.projects.filter(function (q) { return q.id !== tgt.id; });
      if (view.projectId === tgt.id) { view.projectId = null; view.screen = 'home'; }
      save(); refreshStorage();
      toast('Deleted ' + tgt.name);
    }
    ui.sheet = null; ui.swipe = null; return render();
  }
  if (s.on === 'del-station') {
    var st = findStation(p, s.id);
    if (st) {
      IDB.del(photoKey(st.id));
      delete ui.imgCache[st.id];
      if (ui.urlCache[st.id]) { URL.revokeObjectURL(ui.urlCache[st.id]); delete ui.urlCache[st.id]; }
      /* Objects traced from a deleted shot have no frame to live in, so they go
         with it rather than becoming unplaceable orphans. */
      p.objects = p.objects.filter(function (o) { return o.stationId !== st.id; });
      p.stations = p.stations.filter(function (q) { return q.id !== st.id; });
      ensureOrigin(p);
      touchProject(p); save(); refreshStorage();
      coverageCache = { key: null, val: null };
      ui.plan.fitted = false;
      toast('Shot deleted');
    }
    ui.sheet = null; return render();
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
  var fovEl = $('#set-fov');
  if (fovEl) {
    var fov = parseFloat(fovEl.value);
    /* A hand-typed field of view is an assumption, whatever was there before.
       Leaving fovAt set made the app report a typed number as "measured", which
       is worse than having no measurement at all. */
    if (fov > 20 && fov < 140 && Math.abs(fov - s.fov) > 1e-9) {
      s.fov = fov; s.fovAt = null; s.fovFrom = null;
    }
  }
  var ch = parseFloat($('#set-camh').value);
  if (ch > 0) s.camH = EE.toM(ch, s.unit);
  var seg = parseInt($('#set-seg').value, 10);
  if (seg >= 6 && seg <= 128) s.circleSegments = seg;
  var mp = parseInt($('#set-maxpx').value, 10);
  if (mp >= 640 && mp <= 4032) s.maxPx = mp;
  var pw = EE.toM(parseFloat(($('#set-phw') || {}).value), s.unit);
  var pl = EE.toM(parseFloat(($('#set-phl') || {}).value), s.unit);
  if (pw > 0.02 && pw < 0.3) s.phoneW = pw;
  if (pl > 0.02 && pl < 0.4) s.phoneL = pl;
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
    var tr = stream.getVideoTracks()[0];
    var se = tr && tr.getSettings ? tr.getSettings() : {};
    /* Which lens Safari picked is not something we get to choose, and a measured
       field of view only means anything attached to the camera it came from. */
    ui.cap.cam = { label: (tr && tr.label) || '', w: se.width || 0, h: se.height || 0, id: se.deviceId || '' };
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
    att: (function () {
      if (!ui.sensors.live) return null;
      var pre = preTapAttitude(performance.now());
      if (pre && pre.wobble > 30) {
        toast('Phone was moving ' + pre.wobble.toFixed(0) + '°/s at the shutter — attitude taken from just before the tap');
      }
      return {
        alpha: pre ? pre.alpha : ui.sensors.alpha,
        beta: pre ? pre.beta : ui.sensors.beta,
        gamma: pre ? pre.gamma : ui.sensors.gamma,
        heading: ui.sensors.heading, headingAcc: ui.sensors.headingAcc,
        preTap: !!pre, wobble: pre ? +pre.wobble.toFixed(1) : null
      };
    })(),
    gps: ui.gps ? Object.assign({}, ui.gps) : null,
    cam: (ui.cap && ui.cap.cam) ? Object.assign({}, ui.cap.cam) : null,
    angleFix: 0,
    /* Copied onto the shot, not read from the project later: the deck reading is
       only valid against the gyro's yaw reference as it stood at capture time. */
    deckN: (p.deck && p.deck.n) ? p.deck.n.slice() : null,
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
    mapLL: ['', '', '', '', ''],
    lastSnap: null,
    knownLen: '',
    ballFit: null,
    balls: [],
    ballDia: '',
    hexSide: '',
    horizonPick: null,
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

  /* Match the numbers to the edges they actually belong to, rather than to the
     order they were typed in. */
  var asg = assignRefEdges(t.taps.slice(0, 4), w, l, t.refSwap);
  var quad = t.taps.slice(0, 4);
  var cal;
  var q0 = EE.referenceQuality(quad, 3);
  var small = q0 && q0.minSpanPx < SMALL_REF_PX;

  /* A small reference cannot fix the vanishing line. Two of a homography's eight
     numbers ARE that line, and across a card spanning eighty pixels they are
     decided by noise — which is why the horizon comes out askew even when every
     corner was tapped perfectly. Swapping the sides cannot cause that; it only
     relabels the ground axes and leaves the third row alone.

     Gravity has the opposite strengths: it fixes the plane exactly and carries no
     length. So for a small reference, take the plane from the phone's attitude
     and use the rectangle for nothing but scale — the pairing that makes a bank
     card viable at all.

     The lens does NOT need to be measured first. An assumed field of view leaves
     the plane exactly right - gravity sets it - and puts a uniform error on the
     scale only, which the retroactive Correct-the-scale fixes with one tape
     check. A wrong PLANE is unfixable after the fact; a wrong SCALE is one
     multiplication. Requiring a measured lens here was the reason a card
     calibration produced a horizon through the floor for anyone who had not yet
     calibrated on something big - which is everyone, on day one. */
  if (small && st.att) {
    var Rp = attMatrix(st.att);
    var fp = stationF(st);
    var unit = quad.map(function (qp) {
      return EE.groundPoint(EE.rayForPixel(qp.x, qp.y, st.imgW, st.imgH, fp, effAngle(st)),
        Rp, 1, 0, deckNormalOf(st));
    });
    var fitP = unit.every(Boolean)
      ? EE.similarity2D(unit, EE.rectRefCorners(asg.first, asg.second)) : null;
    if (fitP && fitP.scale > 0.2 && fitP.scale < 30) {
      cal = { mode: 'ray', camH: fitP.scale, f: fp, ok: true, source: 'gravity+scale',
        provisionalScale: !db.settings.fovAt };
      st.cal = cal;
      touchProject(p); save();
      coverageCache = { key: null, val: null };
      toast(cal.provisionalScale
        ? 'Plane from gravity — trace away. Scale is provisional (lens assumed ' +
        db.settings.fov.toFixed(0) + '°); one tape check under Check → Correct the scale trues every shot.'
        : 'Plane from gravity, scale from your ' + EE.fmtLen(asg.first, U(), 3) +
        ' edge — camera height ' + EE.fmtLen(fitP.scale, U(), 2));
      t.step = 'trace'; t.taps = []; t.view = null;
      return render();
    }
  }

  cal = calibrateQuad(st, quad, asg.first, asg.second);
  if (!cal.ok) return toast(cal.err);

  /* Reaching here with a small reference means the gravity path was unavailable
     (no attitude) or its fit failed, so the quad's own vanishing line is all
     there is — and across this few pixels it is noise. Mark it, so the trace
     screen and the checklist can say so instead of letting garbage look
     authoritative. */
  if (small) cal.suspect = st.att ? 'small-ref' : 'small-ref-no-tilt';

  st.cal = cal;
  touchProject(p); save();

  var msg = 'Calibrated from ' + EE.fmtLen(asg.first, U(), 3) + ' × ' + EE.fmtLen(asg.second, U(), 3);

  /* Adopt the measured lens, but only from a quad big enough to mean it. A card
     spanning a dozen pixels produces a focal length as unreliable as its own
     vanishing line, and writing that into settings would poison every later
     tilt-and-height shot. */
  msg += adoptMeasuredLens(st, cal, q0);
  if (cal.poseRms != null && cal.poseRms > 0.3) {
    msg += ' · tilt looks off, heights may be unreliable';
  }
  if (cal.suspect) msg += ' · perspective unreliable — reference too small';
  toast(msg);

  t.step = 'trace'; t.taps = []; t.view = null;
  render();
}

/* The hexagonal panel: six tapped corners of a regular hexagon of known side.

   Better than the rectangle it replaces in three ways. It carries no tape
   measure — one number, printed on the panel, is the whole reference. Six
   corners over-determine the homography, so the fit criticises itself (four
   never can). And at 15 cm a side it spans ~2× a bank card, which is what lets
   it pin the vanishing line AND measure the lens — after which every other
   mode inherits the true focal length. The panel's 9 mm of thickness puts the
   measured plane 9 mm above the deck: parallel, so nothing tilts, and the
   height offset is far below tap noise. */
function applyHex() {
  var p = currentProject(), t = ui.trace;
  var st = findStation(p, t.stationId);
  var sideEl = $('#hex-side');
  if (sideEl) t.hexSide = sideEl.value;
  var side = EE.toM(parseFloat(t.hexSide || EE.fromM(0.15, U()).toFixed(3)), U());
  if (!(side > 0.02 && side < 3)) return toast('Enter the hexagon\'s side length');
  if (t.taps.length < 6) return toast('Tap all six corners, walking around the panel');

  var taps = t.taps.slice(0, 6);
  /* The model is anticlockwise; match the tap winding to it. In image
     coordinates (y down) a clockwise-on-screen walk has positive shoelace —
     the same convention the rectangle's near-left → far-left order encodes. */
  if (EE.signedArea(taps) > 0) taps = [taps[0]].concat(taps.slice(1).reverse());
  var ref = EE.hexCorners(side);

  /* A hexagon's information lives in its full EXTENT — six corners across two
     sides' worth of pixels — not in its shortest edge. Judging it by edge the
     way a rectangle is judged calls a perfectly usable panel small: a 100 px
     edge is a 200 px reference with six corners, which pins perspective at
     least as well as a 200 px quad does. */
  var extentPx = 0;
  taps.forEach(function (a2) {
    taps.forEach(function (b2) {
      extentPx = Math.max(extentPx, Math.hypot(a2.x - b2.x, a2.y - b2.y));
    });
  });
  var q0 = { minSpanPx: extentPx };

  /* The same physical panel cannot change size between shots. */
  var otherSide = null;
  p.stations.forEach(function (s2) {
    if (s2.id !== st.id && s2.cal && s2.cal.hexSide > 0) otherSide = s2.cal.hexSide;
  });
  var sideWarn = (otherSide && Math.abs(otherSide / side - 1) > 0.02)
    ? ' ⚠ Another shot used a side of ' + EE.fmtLen(otherSide, U(), 3) +
    ' — the same panel must be entered the same in every shot, or their scales cannot agree.'
    : '';

  /* The full homography is always fitted — its residual and its own two focal
     estimates are the diagnosis. But its PLANE is only trusted when the panel
     could actually pin perspective: field data showed a 377 px hexagon whose
     focal estimates disagreed by 26% putting its vanishing line 18° from
     gravity's, and the app believing it. Below that bar the plane comes from
     gravity, and the lens — which the weak homography could not measure — is
     found instead by searching for the focal length that makes the projected
     panel best match its true shape. A trusted attitude turns a modest panel
     into a lens calibrator. */
  var full = calibratePlanar(st, taps, ref, side * 2, side * 2);
  var planeCapable = full.ok && full.focal && extentPx >= 420 &&
    (full.focal.disagree != null && full.focal.disagree <= 0.10);

  var thickEl = $('#hex-thick');
  if (thickEl) t.hexThick = thickEl.value;
  var thick = EE.toM(parseFloat(t.hexThick || EE.fromM(0.009, U()).toFixed(4)), U());
  if (!(thick >= 0 && thick < 0.06)) thick = 0.009;

  var cal, msg;
  var hyb = null;
  if (st.att) {
    var fCert = certifiedF(st);
    if (fCert) {
      /* A certified lens is not re-litigated per shot: searching f again lets
         a sensor error masquerade as a lens (the field saw f come out 28%
         high at a 1 mm residual). Fit at the known lens; a poor residual then
         points honestly at the attitude, and says so. */
      var Rc = attMatrix(st.att);
      var unitC = taps.map(function (qp) {
        return EE.groundPoint(EE.rayForPixel(qp.x, qp.y, st.imgW, st.imgH, fCert, effAngle(st)),
          Rc, 1, 0, deckNormalOf(st));
      });
      var fitC = unitC.every(Boolean) ? EE.similarity2D(unitC, ref) : null;
      if (fitC && fitC.scale > 0.2 && fitC.scale < 30) {
        hyb = { f: fCert, fit: fitC, rms: fitC.rms, fixed: true };
      }
    } else {
      hyb = EE.fitPlanarByF(taps, ref, attMatrix(st.att), deckNormalOf(st),
        st.imgW, st.imgH, effAngle(st), lockRofFor(st));
    }
  }

  if (!planeCapable && hyb) {
    /* Solved against the top FACE of the panel; the deck sits `thick` below,
       parallel. Storing camH measured to the DECK makes every deck-level tap
       exact, and the tap-the-top-corners habit is the right one: consistent,
       visible, and corrected here rather than guessed at per corner. */
    cal = {
      mode: 'ray', camH: hyb.fit.scale + thick, f: hyb.f, ok: true, source: 'hex+gravity',
      planarRms: hyb.rms, hexSide: side, hexThick: thick,
      hexPix: taps.map(function (qp) { return { x: qp.x, y: qp.y }; }),
      provisionalScale: !db.settings.fovAt
    };
    var Rh = attMatrix(st.att);
    cal.hexGround = taps.map(function (qp) {
      return EE.groundPoint(EE.rayForPixel(qp.x, qp.y, st.imgW, st.imgH, hyb.f, effAngle(st)),
        Rh, cal.camH, thick, deckNormalOf(st));
    });
    if (!cal.hexGround.every(Boolean)) delete cal.hexGround;
    else cal.hexGround = cal.hexGround.map(function (g2) { return { x: g2.x, y: g2.y }; });
    cal.hexNorthOff = 0;               /* ray frames are world east/north */

    msg = 'Plane from gravity, panel for shape and scale — six corners agree to ±' +
      (hyb.rms * 1000).toFixed(0) + ' mm. Camera height ' + EE.fmtLen(cal.camH, U(), 2);
    if (hyb.fixed && hyb.rms > Math.max(0.008, side * 0.05)) {
      msg += ' · at the known lens that residual points at the TILT — lock the horizon on this ' +
        'shot, or re-run Read + sensor check';
    }
    if (full.ok && full.focal && full.focal.disagree > 0.10) {
      msg += ' · the panel alone could not pin perspective (focal split ' +
        (full.focal.disagree * 100).toFixed(0) + '%), so gravity holds the plane';
    }
  } else if (full.ok) {
    cal = full;
    cal.source = 'hex';
    cal.hexSide = side;
    var gr = taps.map(function (qp) { return EE.applyH(cal.H, qp); });
    if (gr.every(Boolean)) {
      cal.hexGround = gr;
      cal.hexNorthOff = cal.pose ? cal.pose.theta : null;
    }
    if (extentPx < SMALL_REF_PX) cal.suspect = st.att ? 'small-ref' : 'small-ref-no-tilt';
    msg = 'Calibrated from the hexagon';
    if (cal.planarRms != null) {
      msg += ' — six corners agree to ±' + (cal.planarRms * 1000).toFixed(0) + ' mm';
      if (cal.planarRms > side * 0.12) {
        msg += '. That is poor — check one corner was not mistapped and the side length is right';
      }
    }
    msg += adoptMeasuredLens(st, cal, q0);
    if (cal.poseRms != null && cal.poseRms > 0.3) msg += ' · tilt looks off, heights may be unreliable';
    if (cal.suspect) msg += ' · perspective unreliable — panel too small in frame';
  } else {
    return toast(full.err);
  }

  st.cal = cal;
  touchProject(p); save();
  coverageCache = { key: null, val: null };

  /* The panel that calibrated two shots also TIES them: same six corners,
     correspondence picked by expected rotation, no landmarks to name. */
  var tie = tryHexTie(p, st);
  if (tie) msg += ' · placed from the panel, six corners to ±' + (tie.rms * 100).toFixed(0) + ' cm';

  /* One camera took every shot, so every panel shot constrains one lens.
     Single-shot valleys at ordinary angles are ±20-40% wide — the field
     proved a lone solve cannot be trusted — but the shots' curves fuse, and
     two pitches pin what one cannot. */
  var fuse = refineLensJoint(p, st.imgW, st.imgH);
  if (fuse) msg += ' · ' + fuse;

  toast(msg + sideWarn);

  t.step = 'trace'; t.taps = []; t.view = null;
  render();
}

/* The lens the app is CERTAIN of for this frame size, or null. */
function certifiedF(st) {
  if (!db.settings.fovAt) return null;
  var m = db.settings.fovByFrame || {};
  if (!m[st.imgW + 'x' + st.imgH]) return null;
  return stationF(st);
}

/* For a horizon-locked shot, the attitude AS A FUNCTION of focal length:
   re-derive the lock from the raw sensor and the stored horizon taps at each
   candidate f. Null for unlocked shots. */
function lockRofFor(st) {
  var a = st.att;
  if (!a || !a.horizonLocked || !a.raw || !a.horizonPx || a.horizonPx.length < 2) return null;
  return function (f) {
    var Rs = EE.rotFromOrientation(a.raw.alpha,
      a.raw.beta + (db.settings.pitchTrim || 0),
      a.raw.gamma + (db.settings.rollTrim || 0));
    var gHint = EE.applyM3(EE.transpose3(Rs), [0, 0, -1]);
    var g = EE.gravityFromHorizon(a.horizonPx[0], a.horizonPx[1], st.imgW, st.imgH, f, effAngle(st), gHint);
    if (!g) return Rs;
    var out = EE.alignToGravity(Rs, g);
    return out.movedDeg > 25 ? Rs : out.R;
  };
}

/* Re-fit a hexagon-calibrated shot from its stored corner pixels at the f the
   app currently believes, under the shot's CURRENT attitude. This is the one
   road through every attitude or lens change — lock, unlock, fused lens —
   because a calibration solved under one attitude silently lies under
   another: the field unlocked a shot after calibrating and its hexagon
   quietly shrank 22%. Everything traced rescales with it; a dropped tie is
   re-solved by the caller. */
function refitHexStation(p, st) {
  var c = st.cal;
  if (!c || !c.ok || !c.hexPix || !st.att) return false;
  var f = certifiedF(st) || c.f;
  if (st.att.horizonLocked) relockHorizonAt(st, f);
  var R = attMatrix(st.att);
  var ref = EE.hexCorners(c.hexSide || 0.15);
  var unit = c.hexPix.map(function (qp) {
    return EE.groundPoint(EE.rayForPixel(qp.x, qp.y, st.imgW, st.imgH, f, effAngle(st)),
      R, 1, 0, deckNormalOf(st));
  });
  if (!unit.every(Boolean)) return false;
  var fit = EE.similarity2D(unit, ref);
  if (!fit || !(fit.scale > 0.2 && fit.scale < 30)) return false;
  var newCamH = fit.scale + (c.hexThick || 0);
  var k = newCamH / c.camH;
  if (Math.abs(k - 1) > 1e-9) rescaleStation(p, st, k);
  c.f = f; c.camH = newCamH; c.planarRms = fit.rms;
  var hg = c.hexPix.map(function (qp) {
    return EE.groundPoint(EE.rayForPixel(qp.x, qp.y, st.imgW, st.imgH, f, effAngle(st)),
      R, c.camH, c.hexThick || 0, deckNormalOf(st));
  });
  if (hg.every(Boolean)) c.hexGround = hg.map(function (g2) { return { x: g2.x, y: g2.y }; });
  return true;
}

/* Attitude for lens work: a horizon-locked shot's stored angles were derived
   AT some focal length, so the lens solver must reach past them to the raw
   sensor reading (trims applied), or the lock's f bakes into the answer. */
function rawAttMatrix(st) {
  var a = st.att;
  if (a.horizonLocked && a.raw) {
    return EE.rotFromOrientation(a.raw.alpha,
      a.raw.beta + (db.settings.pitchTrim || 0),
      a.raw.gamma + (db.settings.rollTrim || 0));
  }
  return attMatrix(a);
}

/* Re-derive a horizon lock from its stored taps at the CURRENT focal length.
   The lock is exact only at the f it was computed with; when the lens gets
   fused to a better value, every lock is recomputed from the raw sensor
   attitude so photo and numbers stay in agreement. */
function relockHorizon(st) {
  return relockHorizonAt(st, (st.cal && st.cal.f) || stationF(st));
}
function relockHorizonAt(st, f) {
  var a = st.att;
  if (!a || !a.horizonLocked || !a.raw || !a.horizonPx || a.horizonPx.length < 2) return false;
  var Rs = EE.rotFromOrientation(a.raw.alpha,
    a.raw.beta + (db.settings.pitchTrim || 0),
    a.raw.gamma + (db.settings.rollTrim || 0));
  var gHint = EE.applyM3(EE.transpose3(Rs), [0, 0, -1]);
  var g = EE.gravityFromHorizon(a.horizonPx[0], a.horizonPx[1], st.imgW, st.imgH, f, effAngle(st), gHint);
  if (!g) return false;
  var out = EE.alignToGravity(Rs, g);
  if (out.movedDeg > 25) return false;
  var e = EE.orientationFromRot(out.R);
  a.alpha = e.alpha; a.beta = e.beta; a.gamma = e.gamma;
  return true;
}

/* Fuse the lens across every hexagon shot of this frame size, adopt it when
   the joint valley is narrow, and walk the consequences through: horizon
   locks re-derived, each hex station re-fitted at the fused f (its world
   rescaled with it), ties re-solved. Returns a toast fragment or null. */
function refineLensJoint(p, imgW, imgH) {
  var shots = [], stations = [];
  p.stations.forEach(function (st) {
    var c = st.cal;
    if (!c || !c.ok || !c.hexPix || !st.att) return;
    if (st.imgW !== imgW || st.imgH !== imgH) return;
    shots.push({
      imgPts: c.hexPix, refPts: EE.hexCorners(c.hexSide || 0.15),
      R: rawAttMatrix(st), Rof: lockRofFor(st),
      deckNormal: st.deckN || [0, 0, 1],
      imgW: st.imgW, imgH: st.imgH, screenAngle: effAngle(st)
    });
    stations.push(st);
  });
  if (!shots.length) return null;

  var fuse = EE.fuseLens(shots);
  if (!fuse) return null;
  var fov = EE.fovFromFocalLong(fuse.f, Math.max(imgW, imgH));
  if (!fuse.identifiable) {
    return shots.length < 2
      ? 'lens not yet pinned \u2014 a second panel shot at a different tilt will fuse with this one'
      : 'lens still \u00b1' + Math.round((fuse.fHi - fuse.fLo) / 2 / fuse.f * 100) +
      '% over ' + shots.length + ' shots \u2014 add a steeper panel shot';
  }
  if (!(fov > 40 && fov < 100)) return null;   /* no phone main camera lives out there */

  var key = imgW + 'x' + imgH;
  var prev = (db.settings.fovByFrame || {})[key];
  db.settings.fov = fov;
  db.settings.fovFrom = 'fused over ' + shots.length + ' panel shot' + (shots.length === 1 ? '' : 's');
  db.settings.fovAt = Date.now();
  (db.settings.fovByFrame || (db.settings.fovByFrame = {}))[key] = fov;

  /* Walk it through the shots that were solved at other focal lengths. */
  var refit = 0;
  stations.forEach(function (st) {
    if (Math.abs(st.cal.f / fuse.f - 1) < 0.015) return;
    if (refitHexStation(p, st)) refit++;
  });
  stations.forEach(function (st) { st.cal.provisionalScale = false; });
  ensureOrigin(p);
  stations.forEach(function (st) { if (!st.reg) { tryHexTie(p, st); } });
  p.stations.forEach(function (st) { if (!st.reg) tryRegister(p, st); });
  save();
  coverageCache = { key: null, val: null };
  ui.plan.fitted = false;

  return 'lens fused over ' + shots.length + ' shot' + (shots.length === 1 ? '' : 's') + ': ' +
    fov.toFixed(1) + '\u00b0' + (refit ? ' (' + refit + ' shot' + (refit === 1 ? '' : 's') + ' re-fitted)' : '');
}

/* Register a station against an already-placed one via their shared hexagon.
   Both must carry hexGround (the panel's corners in their own plan frames) and
   a known plan-to-north offset so the six-fold correspondence is decidable. */
function tryHexTie(p, st) {
  if (!st || st.reg || !st.cal || !st.cal.hexGround || st.cal.hexNorthOff == null) return null;
  var anchor = null;
  p.stations.forEach(function (s2) {
    if (s2.id === st.id || !s2.reg || !s2.cal || !s2.cal.hexGround || s2.cal.hexNorthOff == null) return;
    if (Math.abs((s2.cal.hexSide || 0) / (st.cal.hexSide || 1) - 1) > 0.02) return;
    if (!anchor || s2.createdAt > anchor.createdAt) anchor = s2;
  });
  if (!anchor) return null;

  /* Anchor corners lifted into the project frame; expected rotation composes
     the anchor's placement with both plan-to-north offsets. */
  var projCorners = anchor.cal.hexGround.map(function (g2) { return EE.applyRigid(anchor.reg, g2); });
  var expTheta = anchor.reg.theta + anchor.cal.hexNorthOff - st.cal.hexNorthOff;
  var tie = EE.hexTie(projCorners, st.cal.hexGround, expTheta);
  if (!tie) return null;
  if (Math.abs(tie.scale - 1) > 0.06) {
    p.scaleClash = {
      a: p.stations.indexOf(anchor) + 1, b: p.stations.indexOf(st) + 1,
      pct: Math.abs(tie.scale - 1)
    };
    save();
    toast('The two shots disagree about the panel\'s size by ' +
      (Math.abs(tie.scale - 1) * 100).toFixed(0) + '% — check both entered the same side length.');
    return null;
  }
  p.scaleClash = null;
  st.reg = { theta: tie.theta, tx: tie.tx, ty: tie.ty, rms: tie.rms, n: 6, method: 'hex' };
  touchProject(p); save();
  ui.plan.fitted = false;
  return tie;
}

/* Two taps on the true horizon fix this shot's pitch and roll from the photo.

   The two rays both lie in the horizontal plane through the camera, so their
   cross product IS gravity in the device frame — a reference the sensor can
   only approximate. The attitude is then rotated minimally so its down matches
   the photo's, the yaw stays the sensor's, and the corrected Euler angles are
   written back onto the shot so every consumer follows without knowing. Trims
   stop applying to a locked shot — the photo outranks the per-device fudge. */
function applyHorizonLock(st) {
  var p = currentProject(), t = ui.trace;
  var picks = t.horizonPick;
  t.horizonPick = null;
  if (!st.att) { toast('This shot has no attitude to correct'); return render(); }
  if (!picks || picks.length < 2) return render();

  /* The shot's OWN focal length, never the settings default: the horizon the
     app draws uses cal.f, and a lock computed at a different f lands the line
     hundreds of pixels from the tapped points \u2014 the field screenshot showed
     exactly that, 199 px above the frame. */
  var f = (st.cal && st.cal.f) || stationF(st);
  var Rs = attMatrix(st.att);
  var gHint = EE.applyM3(EE.transpose3(Rs), [0, 0, -1]);
  var g = EE.gravityFromHorizon(picks[0], picks[1], st.imgW, st.imgH, f, effAngle(st), gHint);
  if (!g) { toast('Those two points are too close together — pick them wide apart on the horizon'); return render(); }

  var out = EE.alignToGravity(Rs, g);
  if (out.movedDeg > 25) {
    toast('That line is ' + out.movedDeg.toFixed(0) + '° from the sensor\'s horizon — more than ' +
      'any sensor error. Was that the far horizon, not a parapet or ridge?');
    return render();
  }
  var e = EE.orientationFromRot(out.R);
  var raw = { alpha: st.att.alpha, beta: st.att.beta, gamma: st.att.gamma };
  /* attMatrix adds the trims; the corrected matrix already contains them, so
     the stored angles must be the matrix MINUS nothing — horizonLocked shots
     skip trims entirely, so store the matrix's own angles. */
  st.att.alpha = e.alpha; st.att.beta = e.beta; st.att.gamma = e.gamma;
  st.att.horizonLocked = true;
  st.att.raw = raw;
  st.att.horizonPx = [{ x: picks[0].x, y: picks[0].y }, { x: picks[1].x, y: picks[1].y }];
  var refitMsg = '';
  if (st.cal && st.cal.hexPix && refitHexStation(p, st)) {
    refitMsg = ' The hexagon calibration re-fitted to the locked attitude.';
  }
  touchProject(p); save();
  coverageCache = { key: null, val: null };
  buzz([25, 40, 25]);
  toast('Horizon locked from the photo — attitude moved ' + out.movedDeg.toFixed(1) +
    '°. Pitch and roll for this shot now come from what the camera saw.' + refitMsg);
  render();
}

/* Pull pixels around the seeded circle and hand them to the rim refiner. */
function refineBall(st) {
  var t = ui.trace;
  if (!t || t.taps.length < 2) return null;
  var im = ui.imgCache[st.id];
  if (!im) return null;
  var c = t.taps[0];
  var r0 = Math.hypot(t.taps[1].x - c.x, t.taps[1].y - c.y);
  if (!(r0 > 4)) return null;

  var pad = Math.ceil(r0 * 1.7) + 8;
  var S = pad * 2;
  if (S > 640 || S > st.imgW || S > st.imgH) return null;
  var sx = Math.round(Math.max(0, Math.min(st.imgW - S, c.x - pad)));
  var sy = Math.round(Math.max(0, Math.min(st.imgH - S, c.y - pad)));

  if (!snapCv) snapCv = document.createElement('canvas');
  snapCv.width = S; snapCv.height = S;
  var g = snapCv.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, sx, sy, S, S, 0, 0, S, S);
  var d;
  try { d = g.getImageData(0, 0, S, S).data; } catch (e) { return null; }

  /* The channel the detector reads is chosen per ball: pixels are projected
     onto the RGB axis from "outside the seeded circle" to "inside it". A white
     ball degenerates to roughly luminance; a dark-yellow ball on grey membrane
     — nearly invisible to luminance — separates on colour instead. This is
     what makes a mixed bag of ball colours a feature rather than a problem:
     each one is read against its own background. */
  var scx = c.x - sx, scy = c.y - sy;
  var ringRGB = function (radii) {
    var out = [];
    for (var a2 = 0; a2 < 24; a2++) {
      var th = a2 / 24 * 2 * Math.PI, ct = Math.cos(th), st2 = Math.sin(th);
      for (var k2 = 0; k2 < radii.length; k2++) {
        var px = Math.round(scx + ct * r0 * radii[k2]);
        var py = Math.round(scy + st2 * r0 * radii[k2]);
        if (px < 0 || py < 0 || px >= S || py >= S) continue;
        var j = (py * S + px) * 4;
        out.push([d[j], d[j + 1], d[j + 2]]);
      }
    }
    return out;
  };
  var axis = EE.colorAxis(ringRGB([0.20, 0.42]), ringRGB([1.32, 1.55]));

  var gray = new Float32Array(S * S);
  for (var i = 0; i < S * S; i++) {
    gray[i] = axis
      ? axis.w[0] * d[i * 4] + axis.w[1] * d[i * 4 + 1] + axis.w[2] * d[i * 4 + 2]
      : 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }

  var f = EE.refineCircleEdge(gray, S, S, c.x - sx, c.y - sy, r0);
  if (!f) return null;
  return {
    cx: sx + f.cx, cy: sy + f.cy, r: f.r,
    xL: sx + f.xL, xR: sx + f.xR, dh: f.dh,
    rms: f.rms, n: f.n, horizRefined: f.horizRefined
  };
}

/* Every ball in play: the committed ones plus the one currently being circled.
   Each carries the level rim extremes the solves need, and whether the refiner
   actually locked it or the drawn circle is being taken on trust. */
function ballSet(t) {
  var set = (t.balls || []).slice();
  if (t.taps.length >= 2) {
    var fb = t.ballFit, c = t.taps[0];
    var r0 = Math.hypot(t.taps[1].x - c.x, t.taps[1].y - c.y);
    set.push(fb
      ? { cx: fb.cx, cy: fb.cy, r: fb.r, xL: fb.xL, xR: fb.xR, dh: fb.dh, n: fb.n, rms: fb.rms, locked: true }
      : { cx: c.x, cy: c.y, r: r0, xL: c.x - r0, xR: c.x + r0, dh: 2 * r0, n: 0, rms: null, locked: false });
  }
  return set;
}

/* Bank the ball being circled and clear the selector for the next one. */
function commitBall() {
  var t = ui.trace;
  var set = ballSet(t);
  if (!set.length || t.taps.length < 2) return toast('Circle this ball first — centre, then drag to the rim');
  if ((t.balls || []).length >= 3) return toast('Three balls is the full house');
  (t.balls || (t.balls = [])).push(set[set.length - 1]);
  t.taps = []; t.ballFit = null;
  buzz(20);
  render();
}

/* The multi-ball verdict, computed live for the panel and again at apply.
   Everything runs in the DEVICE frame so the sensor's own error cannot leak
   into the check: the predicted plane is rotated in through the same attitude
   any correction will later be rotated out through. The prediction is always
   the SENSOR's plane (st.deckN), never a previous ball calibration's — the
   verdict is photo vs sensor, not photo vs itself. */
function ballSolve(st, t, D) {
  var set = ballSet(t);
  if (!set.length || !st.att) return null;
  var f = stationF(st), ang = effAngle(st);
  var centers = [], relErrs = [], failed = null;
  set.forEach(function (b, i) {
    var sc = EE.sphereCenterDev(b.xL, b.xR, b.cy, st.imgW, st.imgH, f, ang, D);
    if (!sc) { failed = failed == null ? i : failed; return; }
    centers.push(sc.p);
    /* Range error rides the rim measurement: each edge is good to about the
       fit's own residual (floored — a synthetic-clean fit is still read by a
       real sensor), an unlocked circle to a finger's honesty. */
    var edgePx = b.locked ? Math.max(0.35, b.rms || 0.7) : 3;
    relErrs.push(Math.SQRT2 * edgePx / Math.max(6, b.dh));
  });
  if (failed != null || centers.length !== set.length) {
    return { set: set, failed: failed == null ? 0 : failed };
  }
  var R = attMatrix(st.att);
  var nDev = EE.applyM3(EE.transpose3(R), st.deckN || [0, 0, 1]);
  var res = EE.ballPlane(centers, nDev, D / 2, relErrs);
  return { set: set, res: res, R: R, f: f };
}

function ballDiaM(t) {
  var diaEl = $('#ball-dia');
  if (diaEl) t.ballDia = diaEl.value;
  return EE.toM(parseFloat(t.ballDia || EE.fromM(0.04267, U()).toFixed(5)), U());
}

/* Every count goes through sphere ranging now: the two tangent rays through
   the level rim extremes put the ball's centre at r / sin(half-angle) along
   their bisector, so each ball is a full 3D point. The earlier single-ball
   route — treat the rim extremes as two ground points a diameter apart — was
   exact dead ahead but picked up a quadratic off-axis bias, about −1% at 8°
   off the midline and −3.7% at 16°; ranging has no such term, and the
   synthetic tests hold it to 0.0% across the frame.

   One ball prices the camera height. Two check the sensor's plane along their
   baseline and average the height. Three measure the deck plane outright, the
   sensor only saying which way is up; the measured plane is stored in the
   DEVICE frame (cal.deckDev) so the attitude cancels exactly, and every
   consumer picks it up through deckNormalOf. */
function applyBall() {
  var p = currentProject(), t = ui.trace;
  var st = findStation(p, t.stationId);
  if (!st.att) return toast('The ball route needs the tilt sensor');

  var D = ballDiaM(t);
  if (!(D > 0.02 && D < 0.31)) return toast('Enter the ball diameter');

  var set = ballSet(t);
  if (!set.length) return toast('Mark the centre, then drag to the rim');
  if (set.some(function (b) { return !(b.xR - b.xL > 6); })) {
    return toast('One of those circles is too small to measure — get closer');
  }

  var done = function (cal, msg) {
    st.cal = cal;
    db.settings.camH = cal.camH;
    touchProject(p); save();
    coverageCache = { key: null, val: null };
    if (cal.camH < 0.7 || cal.camH > 2.6) msg += ' — not a handheld height; were the balls on the deck?';
    if (cal.provisionalScale) msg += '. Scale provisional until one tape check (Check → Correct the scale).';
    toast(msg);
    t.step = 'trace'; t.taps = []; t.view = null; t.ballFit = null; t.balls = [];
    render();
  };

  var sol = ballSolve(st, t, D);
  if (set.length === 1) {
    if (!sol || !sol.res || !(sol.res.camH > 0.2 && sol.res.camH < 30)) {
      return toast('Could not solve from that circle — is the whole ball visible, on the deck?');
    }
    return done({
      mode: 'ray', camH: sol.res.camH, f: sol.f, ok: true, source: 'ball',
      provisionalScale: !db.settings.fovAt
    }, 'Ball read at ' + (set[0].xR - set[0].xL).toFixed(0) + ' px — camera height ' +
      EE.fmtLen(sol.res.camH, U(), 2));
  }

  if (!sol || !sol.res) {
    var which = sol && sol.failed != null ? String.fromCharCode(65 + sol.failed) : '?';
    return toast('Ball ' + which + ' would not solve — is the whole ball in frame, on the deck?');
  }
  var res = sol.res;
  /* One ball pricing a different camera height than the rest has a corrupt
     range — this fires at any spread, before any plane logic. */
  if (res.rangeSuspect != null) {
    if (res.rangeSuspect < 0) {
      return toast('The two balls disagree about your height (' +
        EE.fmtLen(res.hs[0], U(), 2) + ' vs ' + EE.fmtLen(res.hs[1], U(), 2) +
        ') — one rim lock is off, or a ball is not on the deck. Re-circle the weaker one.');
    }
    var sus = set[res.rangeSuspect];
    var hMed = res.hs.slice().sort(function (a, b) { return a - b; })[Math.floor(res.hs.length / 2)];
    return toast('Ball ' + String.fromCharCode(65 + res.rangeSuspect) +
      ' disagrees with the others about your height (' + EE.fmtLen(res.hs[res.rangeSuspect], U(), 2) +
      ' vs ' + EE.fmtLen(hMed, U(), 2) + ') — its rim lock is off (' +
      (sus.locked ? sus.n + ' of 48 spokes' : 'never locked') +
      '), or it is not on the deck. Re-circle it.');
  }
  if (res.degenerate === 'collinear') {
    return toast('The three balls sit nearly in a line — the plane across that line is unreadable. ' +
      'Move one ball a stride sideways and re-lock it.');
  }
  if (res.degenerate === 'coincident') {
    return toast('Those balls are almost on top of each other — spread them apart.');
  }
  /* A capable constellation reporting a wilder plane than any sensor error can
     be is one corrupt range — a rim locked on a shadow, or a ball not on the
     deck. Refuse, and point at the weakest lock rather than guessing. */
  if (res.systemic) {
    return toast('The heights those balls price the camera at (' +
      res.hs.map(function (hv) { return EE.fmtLen(hv, U(), 2); }).join(', ') +
      ') are not a believable set — that is not a ball problem, it is the attitude itself. ' +
      'Re-run Check → Read + sensor check; if it persists, the frame orientation is being ' +
      'misread for this camera.');
  }
  if (res.implausible) {
    var worst = 0;
    set.forEach(function (b, i) {
      var q = b.locked ? (b.n || 0) : -1;
      var qw = set[worst].locked ? (set[worst].n || 0) : -1;
      if (q < qw) worst = i;
    });
    return toast('The plane those balls describe is ' + res.disagreeDeg.toFixed(0) +
      '° off the sensor — not physically plausible; one range must be corrupt. ' +
      'Ball ' + String.fromCharCode(65 + worst) + ' has the weakest lock (' +
      (set[worst].locked ? (set[worst].n + ' of 48 spokes') : 'never locked') +
      ') — re-circle it and check the green circle hugs the ball.');
  }
  if (!(res.camH > 0.2 && res.camH < 30)) {
    return toast('Could not solve from those circles — are the balls on the deck, fully in frame?');
  }

  var cal = {
    mode: 'ray', camH: res.camH, f: sol.f, ok: true, source: 'ball' + set.length,
    provisionalScale: !db.settings.fovAt,
    ballCheck: {
      balls: set.length,
      disagreeDeg: res.disagreeDeg != null ? +res.disagreeDeg.toFixed(2) : null,
      sigmaDeg: res.sigmaDeg != null ? +res.sigmaDeg.toFixed(2) : null,
      use: res.use
    }
  };
  if (res.use === 'photo') cal.deckDev = res.n;

  var spreadOf = res.mode === 2 ? res.baselineM : res.minAltM;
  var bunched = res.degenerate === 'tiny' || res.whyNot === 'noise';
  var msg;
  if (bunched) {
    /* Heights average fine from a cluster; tilt does not. Calibrate the scale,
       keep the sensor's plane, and say exactly what to change. */
    msg = 'Heights read from ' + set.length + ' balls — camera height ' + EE.fmtLen(res.camH, U(), 2) +
      '. But at ' + (spreadOf > 0 ? EE.fmtLen(spreadOf, U(), 2) + ' of spread' : 'this spread') +
      ' they cannot read tilt' +
      (res.sigmaDeg != null ? ' (±' + res.sigmaDeg.toFixed(1) + '° at best)' : '') +
      ', so the plane stays with the sensor. Spread them to about a metre apart to read it from the photo.';
  } else if (set.length === 2) {
    var hd = Math.abs(res.hs[0] - res.hs[1]);
    var hPct = (hd / Math.max(res.hs[0], res.hs[1], 0.01) * 100).toFixed(1);
    msg = res.use === 'photo'
      ? 'The balls disagree with the sensor by ' + res.disagreeDeg.toFixed(1) +
      '° along their line — plane corrected from the photo. Camera height ' + EE.fmtLen(res.camH, U(), 2)
      : 'Two balls agree — heights within ' + hPct + '%, tilt confirmed to ±' +
      res.sigmaDeg.toFixed(1) + '°. Camera height ' + EE.fmtLen(res.camH, U(), 2);
  } else {
    msg = res.use === 'photo'
      ? 'Plane taken from the three balls alone — the sensor is off by ' + res.disagreeDeg.toFixed(1) +
      '°. Camera height ' + EE.fmtLen(res.camH, U(), 2) +
      (res.disagreeDeg > 8 ? '. That is a lot — worth re-running Read + sensor check.' : '')
      : 'Three balls confirm the sensor\'s plane within ±' + res.sigmaDeg.toFixed(1) +
      '° — camera height ' + EE.fmtLen(res.camH, U(), 2);
  }
  return done(cal, msg);
}

function applyMap() {
  var p = currentProject(), t = ui.trace;
  var st = findStation(p, t.stationId);
  var lls = (t.mapLL || []).map(parseLL);
  if (t.taps.length < 4 || !lls.slice(0, 4).every(Boolean)) {
    return toast('Four tapped points, each with coordinates');
  }
  var n = Math.min(t.taps.length, lls.filter(Boolean).length, 5);
  var cal = calibrateFromMap(st, t.taps.slice(0, n), lls.slice(0, n));
  if (!cal.ok) return toast(cal.err);

  st.cal = cal;

  /* The reference frame is already east/north about the first point, so the
     survey is georeferenced the moment it is calibrated — bearing 0, no separate
     step, no compass. Only the first station may define it. */
  if (!p.anchor) {
    p.anchor = { lat: cal.originLL.lat, lon: cal.originLL.lon, bearing: 0 };
    p.anchorMeta = { method: 'aerial points', scaleError: null };
  }

  touchProject(p); save();
  coverageCache = { key: null, val: null };

  var msg = 'Calibrated from a ' + EE.fmtLen(cal.spread, U(), 1) + ' baseline';
  if (cal.mapCheck) {
    msg += ' · check point off by ' + EE.fmtLen(cal.mapCheck.worst, U(), 2);
  }
  if (cal.poseRms != null && cal.poseRms > 0.4) msg += ' · tilt disagrees, heights may be off';
  toast(msg);

  t.step = 'trace'; t.taps = []; t.view = null;
  render();
}

function applyRay() {
  var p = currentProject(), t = ui.trace;
  var st = findStation(p, t.stationId);
  if (!st.att) return toast('This shot has no tilt recorded');

  var f = stationF(st);
  var R = attMatrix(st.att);
  var camH = EE.toM(parseFloat($('#cam-h').value), U());

  var knownEl = $('#known-len');
  if (t.taps.length >= 2 && knownEl) {
    var known = EE.toM(parseFloat(knownEl.value), U());
    if (known > 0) {
      var a = EE.rayForPixel(t.taps[0].x, t.taps[0].y, st.imgW, st.imgH, f, effAngle(st));
      var b = EE.rayForPixel(t.taps[1].x, t.taps[1].y, st.imgW, st.imgH, f, effAngle(st));
      var solved = EE.camHeightFromKnown(a, b, R, known, deckNormalOf(st));
      /* Two taps on a resting ball's rim measure a chord one radius above the
         deck; layover makes the solve come back exactly h - r. Hand r back. */
      if (solved && t.knownZ) solved += t.knownZ;
      /* A plausible handheld camera height is roughly 1.2-1.8 m. Anything far
         outside that almost always means the two taps were NOT on the deck —
         a wall or the side of a unit gets projected onto the roof plane, which
         stretches the apparent distance and drags the solved height with it.
         Saying so is worth more than silently accepting the number. */
      if (solved && solved > 0.2 && solved < 60) {
        if (solved < 0.7 || solved > 2.6) {
          toast('Solved ' + EE.fmtLen(solved, U()) + ' — that is not a handheld height. ' +
            'Were both taps flat on the deck?');
        } else {
          toast('Camera height solved: ' + EE.fmtLen(solved, U()));
        }
        camH = solved;
      } else {
        toast('Could not solve from those two taps — using the height you typed');
      }
    }
  }
  if (!(camH > 0)) return toast('Enter the camera height');

  st.cal = { mode: 'ray', camH: camH, f: f, ok: true };
  db.settings.camH = camH;
  touchProject(p); save();
  t.step = 'trace'; t.taps = []; t.view = null;
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
    toast('Height ' + EE.fmtLen(hgt, U()) + ' — it will be applied to the next shape you add');
    ui.lastHeight = hgt;
    return render();
  }

  var raw = t.taps.map(function (q) { return map.toGround(q.x, q.y); });
  var gpts = raw.filter(Boolean);
  var dropped = raw.length - gpts.length;
  if (gpts.length < (t.tool === 'point' ? 1 : 3)) {
    /* The commonest cause is not the user standing wrong — it is a bad
       calibration whose horizon cuts through the floor, silently disqualifying
       every tap beyond it. Say which it is. */
    return toast(dropped
      ? dropped + (dropped === 1 ? ' tap fell' : ' taps fell') + ' above where this calibration ' +
      'thinks the horizon is. If the red line looks wrong, recalibrate — a too-small reference does exactly this.'
      : 'Tap ' + (t.tool === 'point' ? 'a point' : 'at least three corners') + ' first');
  }

  var o = { id: uid('o'), stationId: st.id, kind: t.tool, name: '', h: ui.lastHeight || 0,
    hSrc: ui.lastHeight ? 'measured' : undefined, note: '' };
  if (t.tool === 'rect') {
    var r = EE.fitOrientedRect(gpts);
    if (!r) return toast('Those taps do not enclose an area once projected — if the green grid looks warped, recalibrate');
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
    o.autoName = t.tool === 'outline';
  }

  p.objects.push(o);
  ui.lastHeight = 0;
  touchProject(p); save();
  t.taps = [];

  if (t.tool === 'point') {
    var reg = tryRegister(p, st);
    if (reg) maybeAutoAdjust(p);
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
  if (nameEl) {
    var typed = nameEl.value.trim();
    /* An untouched auto-name keeps its suggestion; anything typed replaces it. */
    if (typed) { o.name = typed; o.autoName = false; }
    else if (!o.autoName) o.name = '';
  }
  var hEl = $('#so-h');
  if (hEl) {
    var hv = parseFloat(hEl.value);
    if (hv >= 0) {
      var wasM = o.hSrc === 'measured' && Math.abs(EE.toM(hv, U()) - o.h) < 1e-9;
      o.h = EE.toM(hv, U());
      /* A typed height came off a tape and must not move when the survey is
         rescaled; an optically measured one rides on the camera height and must. */
      if (!wasM) o.hSrc = 'typed';
    }
  }
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
    maybeAutoAdjust(p);
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

      /* Raster ONLY. Putting the vectors in here as well was the obvious move and
         it loses the thing that makes them worth having: HelioScope flattens
         vector geometry inside a KMZ to the deck, while the very same geometry in
         a bare .kml extrudes to its real height. So the deck ships as a KMZ and
         the volumes ship as a KML, and they are imported as two overlays. */
      var doc = EE.buildGroundOverlayKML(box, {
        name: p.name + ' — deck',
        href: 'files/plan.png',
        description: (p.address || '') +
          '\nNorth-up deck raster at ' + r.gsd.toFixed(3) + ' m/px; the scale bar is exactly ' +
          '20.000 m. Import the matching .kml alongside this for 3D volumes and heights.' +
          (p.scaleRef ? '\nScale from a ' + p.scaleRef.method + ' baseline of ' +
            EE.fmtLen(p.scaleRef.lengthM, 'm') + '.' : '') +
          '\nDeck assumed flat to ±' + EE.fmtLen(db.settings.deckUnc, 'm', 2) + '.'
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

/* Everything a diagnosis needs, in one file: the project, the device settings
   the project file never carried (lens, trims, measured bias), and per-shot
   DERIVED numbers — the homography actually in force, its horizon, the frame's
   focal length — computed at export time exactly as the app would use them. */
/* A store-only ZIP: local headers, central directory, CRC-32. Sixty lines
   beat a dependency, JPEGs are already compressed so stored-not-deflated
   costs nothing, and the result opens everywhere. */
var _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function strToUtf8(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); }
    else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  return new Uint8Array(out);
}
function zipStore(entries) {
  var chunks = [], central = [], offset = 0;
  var u16 = function (v) { return [v & 255, (v >> 8) & 255]; };
  var u32 = function (v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; };
  entries.forEach(function (e) {
    var name = strToUtf8(e.name);
    var data = typeof e.data === 'string' ? strToUtf8(e.data) : e.data;
    var crc = crc32(data);
    var head = [].concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x5021),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
    chunks.push(new Uint8Array(head), name, data);
    central.push({ name: name, crc: crc, size: data.length, offset: offset });
    offset += head.length + name.length + data.length;
  });
  var cdStart = offset, cdLen = 0;
  central.forEach(function (c) {
    var rec = [].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x5021),
      u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(c.offset));
    chunks.push(new Uint8Array(rec), c.name);
    cdLen += rec.length + c.name.length;
  });
  chunks.push(new Uint8Array([].concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(cdLen), u32(cdStart), u16(0))));
  var total = 0;
  chunks.forEach(function (c) { total += c.length; });
  var out = new Uint8Array(total), pos = 0;
  chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
  return out;
}

function buildDebugPayload(p) {
  var diag = p.stations.map(function (st) {
    var H = null, hor = null;
    try { H = stationH(st); hor = H && EE.horizonLine(H, st.imgW, st.imgH); } catch (e2) { }
    var gravHor = null;
    try {
      if (st.att) {
        var Hg = EE.homographyFromPose(attMatrix(st.att), 1, stationF(st),
          st.imgW, st.imgH, effAngle(st), deckNormalOf(st));
        gravHor = Hg && EE.horizonLine(Hg, st.imgW, st.imgH);
      }
    } catch (e3) { }
    return {
      id: st.id, effAngle: effAngle(st), stationF: stationF(st),
      absoluteScale: calAbsoluteScale(st.cal),
      deckNormalInForce: deckNormalOf(st),
      stationH: H, horizonOfCal: hor, horizonOfGravity: gravHor,
      trustedRadius: st.cal && st.cal.camH ? trustedRadius(st.cal.camH) : null
    };
  });
  return JSON.stringify({
    app: 'eagle-eye', version: VERSION, exportedAt: new Date().toISOString(),
    settings: db.settings, project: p, derived: diag
  }, null, 1);
}

/* The complete case file: data plus every photo, one ZIP. Photos come out of
   IndexedDB one at a time; a shot whose photo has gone missing still ships,
   listed in the manifest as absent. */
function exportDebugFull() {
  var p = currentProject();
  var entries = [{ name: 'data.json', data: buildDebugPayload(p) }];
  var ids = p.stations.map(function (st) { return st.id; });
  var missing = [];
  var finish = function () {
    if (missing.length) entries.push({ name: 'missing-photos.txt', data: missing.join('\n') });
    try {
      deliverBlob(slug(p.name) + '-debug.zip', new Blob([zipStore(entries)], { type: 'application/zip' }));
    } catch (e4) {
      toast('ZIP failed (' + e4 + ') — exporting the data alone');
      deliver(slug(p.name) + '-debug.json', buildDebugPayload(p), 'application/json');
    }
  };
  var next = function (i) {
    if (i >= ids.length) return finish();
    IDB.get(photoKey(ids[i])).then(function (blob) {
      if (!blob || !blob.arrayBuffer) { missing.push(ids[i]); return next(i + 1); }
      blob.arrayBuffer().then(function (buf) {
        entries.push({ name: 'photos/' + ids[i] + '.jpg', data: new Uint8Array(buf) });
        next(i + 1);
      }, function () { missing.push(ids[i]); next(i + 1); });
    }, function () { missing.push(ids[i]); next(i + 1); });
  };
  next(0);
}

function exportDebug() {
  var p = currentProject();
  deliver(slug(p.name) + '-debug.json', buildDebugPayload(p), 'application/json');
}


/* ================= boot ================= */

window.addEventListener('resize', function () { paint(); });
if (screen.orientation && screen.orientation.addEventListener) {
  screen.orientation.addEventListener('change', function () { setTimeout(paint, 120); });
}

/* A stored lens outside anything a phone's main camera delivers is a past
   solve gone wrong (the field once wrote 100\u00b0), and it poisons every solve
   after it. Drop it; the fused solver will re-measure honestly. */
(function () {
  var m = db.settings.fovByFrame || {};
  var dropped = false;
  Object.keys(m).forEach(function (k) {
    if (!(m[k] > 40 && m[k] < 100)) { delete m[k]; dropped = true; }
  });
  if (!(db.settings.fov > 40 && db.settings.fov < 100)) {
    db.settings.fov = 68; db.settings.fovAt = 0; db.settings.fovFrom = null; dropped = true;
  }
  if (dropped) save();
})();

/* Sensors need no prompt on desktop and on Android, so attach immediately;
   iOS gets a button in the capture screen. */
if (!needsMotionPermission()) startSensors();

render();

/* ================= updates =================

   Registering a worker is not the same as shipping an update, and on an installed
   iOS web app the gap between them is where releases go to die. Three things have
   to happen, and only the first was here:

   1. A new worker is fetched and installed. skipWaiting() in sw.js does that.
   2. Something has to ASK. An installed home-screen app resumes from a suspended
      state rather than navigating, so nothing triggers an update check on its own
      — hence the check on every foreground.
   3. The page has to reload. A new worker taking control changes what the NEXT
      request would get; the tab is still running the old bundle it parsed
      minutes or days ago. Without this reload the app can be fully up to date on
      disk and still behave like the old version indefinitely. */
var swReg = null, updateReloading = false;

function pokeWaiting(reg) {
  if (reg && reg.waiting) { try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { } }
}

function checkForUpdate(manual) {
  if (!swReg) { if (manual) toast('Updates are handled by the browser here'); return; }
  swReg.update().then(function () {
    pokeWaiting(swReg);
    if (manual && !swReg.waiting && !swReg.installing) toast('Already on ' + VERSION);
  }).catch(function () { if (manual) toast('Could not reach the server'); });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      swReg = reg;
      pokeWaiting(reg);
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) pokeWaiting(reg);
        });
      });
    }).catch(function () { });
  });

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (updateReloading) return;      /* controllerchange can fire more than once */
    updateReloading = true;
    location.reload();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkForUpdate(false);
  });
}
