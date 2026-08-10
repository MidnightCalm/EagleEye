/* Eagle Eye — roof survey PWA.

   Photos and device attitude in, a metric plan and a HelioScope-ready KML out.
   The geometry lives in geo.js; this file is state, screens and interaction.

   Deliberately no LiDAR: the iPhone's depth sensor is a 940 nm emitter that a
   bright roof washes out, and its useful range stops well short of the far side
   of a warehouse. Photographs plus a known reference survive full sun. */
'use strict';

var VERSION = '1.0.0';
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
  jpegQ: 0.72
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
  var full = view.screen === 'capture' || view.screen === 'trace';
  app.className = full ? 'wide' : '';

  var html = '';
  if (view.screen === 'home') html = tplHome();
  else if (view.screen === 'project') html = tplProject();
  else if (view.screen === 'capture') html = tplCapture();
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
  else if (view.tab === 'scene') body = tplScene(p);
  else if (view.tab === 'objects') body = tplObjects(p);
  else body = tplExport(p);

  var tab = function (k, label) {
    return '<button class="' + (view.tab === k ? 'active' : '') + '" data-tab="' + k + '">' + label + '</button>';
  };

  return '<div style="flex:0 0 auto;padding:calc(var(--safe-top) + 18px) 20px 12px">' +
    '<div class="head">' +
    '<button class="icon-btn" data-act="home">‹</button>' +
    '<div class="titles"><span class="title">' + esc(p.name) + '</span>' +
    '<span class="sub">' + esc(p.address || 'No address') + '</span></div>' +
    '<button class="icon-btn dots" data-act="project-menu">···</button>' +
    '</div></div>' +
    '<div class="tabbar">' + tab('plan', 'Plan') + tab('scene', 'Scene') + tab('objects', 'Objects') + tab('export', 'Export') + '</div>' +
    body +
    '<div class="bottom-bar">' +
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
    '<button class="pill" data-act="toggle-unit">' + (U() === 'm' ? 'metres' : 'feet') + '</button>' +
    '<div style="flex:1"></div>' +
    '<button class="pill gold" data-act="geo-sheet">' + (p.anchor ? '◈ Located' : '◈ Locate') + '</button>' +
    '</div>' +
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

    '<div class="btn-row"><button class="btn primary" data-act="export-kml"' + (p.anchor ? '' : ' disabled') + '>Export KML</button></div>' +
    '<div class="btn-row">' +
    '<button class="btn ghost-gold" data-act="export-csv">Schedule CSV</button>' +
    '<button class="btn ghost" data-act="export-json">Backup JSON</button></div>' +
    '<div class="hint">KML opens in Google Earth as solid blocks at their real heights — worth a ' +
    'look before it goes anywhere near a layout.</div>' +
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
    var el = e.target.closest('[data-act],[data-open],[data-tab],[data-tool],[data-calmode],[data-unit],[data-nameunit],[data-geomethod],[data-menu],[data-object],[data-station],[data-setheight]');
    if (!el) return;
    handle(el, e);
  };

  if (view.screen === 'capture') bindCapture();
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
  if (el.dataset.station) return openStation(el.dataset.station);
  if (el.dataset.object) { ui.sel = el.dataset.object; ui.sheet = { kind: 'object', id: el.dataset.object }; return render(); }
  if (el.dataset.setheight) {
    var hv = $('#so-h'); if (hv) hv.value = parseFloat(el.dataset.setheight).toFixed(2);
    return;
  }
  if (el.dataset.menu) return runMenu(el.dataset.menu);

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

    case 'save-settings': return saveSettings();
    case 'purge-photos': ui.sheet = { kind: 'confirm', title: 'Drop all photos?', body: 'Every measurement is kept. You lose only the ability to trace more from the shots already taken.', yes: 'Drop photos', on: 'purge' }; return render();
    case 'confirm-yes': return confirmYes();

    case 'export-kml': return exportKml();
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
  var blob = new Blob([text], { type: mime });
  var file = null;
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
    circleSegments: db.settings.circleSegments
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
