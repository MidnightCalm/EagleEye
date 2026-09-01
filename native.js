/* Eagle Eye — the native bridge.

   Loaded by index.html in every build and inert in a browser: everything here
   is behind a feature test for the native shell's message handler. In the
   shell (native/) it replaces the two weakest inputs in the whole
   app with measured ones:

     ATTITUDE  DeviceOrientation, with its per-device bias, its shutter jerk
               and its horizon locks, becomes ARKit's visual-inertial attitude
               — good to a fraction of a degree and drift-free.
     LENS      The focal length this project spent four versions fusing,
               searching and sanity-gating becomes the camera's FACTORY
               intrinsics, exact and free.

   And it adds the one thing the web platform never offered: metric camera
   POSITION, which is what turns "tie the shots together" into "the shots were
   never apart".

   Deliberately additive. app.js is not modified: this file writes the globals
   app.js already reads (ui.sensors, db.settings.fovByFrame) and overrides the
   one function that would otherwise beg for a permission the shell does not
   need. If the bridge is absent, none of it runs. */
(function () {
  var handlers = window.webkit && window.webkit.messageHandlers;
  var post = handlers && handlers.eagleEye;
  if (!post) return;                       /* plain web: nothing to do */

  var N = window.EENative = {
    active: true,
    pose: null,          /* {alpha,beta,gamma,pos:{x,y,z}} in app frames */
    tracking: 'initializing',
    lens: null,          /* {fov, fx, w, h} once intrinsics arrive */
    floorY: null,        /* ARKit's detected floor, app-frame z */
    lastAt: 0,
    arkit: false,        /* true once ARKit is genuinely tracking */
    /* New for every ARSession. Positions only mean anything within one: a cold
       start puts the world origin wherever the phone happens to be, so shots
       from two sessions must never be registered against each other by
       position. Stored on every shot, compared before auto-registering. */
    sessionId: null,
    /* Every horizontal plane ARKit currently believes in, keyed by anchor id,
       already converted to this app's frame. The deck and the units are in
       here before anyone has tapped anything. */
    planes: {}
  };

  var send = function (msg) { try { post.postMessage(msg); } catch (e) { } };

  /* ---- pose, ~30 Hz from the shell ----

     ui.sensors is exactly where the sensor path deposited its readings, so
     writing it here means every consumer — attMatrix, the capture HUD, the
     live overlay — is fed by ARKit without knowing anything changed. */
  window.__eeNativePose = function (m, tracking, fx, w, h, sessionId) {
    var pose = EE.arkitPose(m);
    if (!pose) return;
    N.pose = pose;
    N.tracking = tracking || 'normal';
    N.sessionId = sessionId || N.sessionId;
    /* 'normal' is ARKit saying the pose is trustworthy. Anything else and the
       position is a guess, so the app must not register shots against it. */
    N.arkit = N.tracking === 'normal';
    N.lastAt = performance.now();     /* the clock preTapAttitude compares against */

    if (window.ui && ui.sensors) {
      ui.sensors.alpha = pose.alpha;
      ui.sensors.beta = pose.beta;
      ui.sensors.gamma = pose.gamma;
      ui.sensors.live = true;
      /* The attitude ring the shutter-jerk fix reads: ARKit has no jerk, but
         feeding the ring keeps preTapAttitude and the wobble warning honest. */
      if (window.EE && ui.attRing) {
        ui.attRing.push({
          t: N.lastAt, a: pose.alpha, b: pose.beta, g: pose.gamma,
          q: EE.quatFromOrientation(pose.alpha, pose.beta, pose.gamma)
        });
        if (ui.attRing.length > 50) ui.attRing.shift();
      }
    }

    /* Factory intrinsics, once per frame geometry. Written straight into the
       per-frame lens table the app already keys every measurement off. */
    if (fx > 0 && w > 0 && !N.lens) {
      var fov = EE.fovFromIntrinsics(fx, w, h);
      if (fov > 40 && fov < 100) {          /* the window app.js enforces at boot */
        N.lens = { fov: fov, fx: fx, w: w, h: h };
        if (window.db && db.settings) {
          db.settings.fov = fov;
          db.settings.fovFrom = 'ARKit factory intrinsics';
          db.settings.fovAt = Date.now();
          (db.settings.fovByFrame || (db.settings.fovByFrame = {}))[w + 'x' + h] = fov;
          /* the portrait framing of the same sensor */
          db.settings.fovByFrame[h + 'x' + w] = fov;
          if (window.save) save();
        }
      }
    }

    if (window.ui && ui.cap && window.paintCaptureHud) paintCaptureHud();
    if (window.ui && ui.live && window.paintLive) paintLive();
  };

  /* The deck is the LOWEST BROAD horizontal plane — not whichever plane ARKit
     happened to report last, which was the previous rule and which quietly
     made an RTU top the floor whenever one was found late. A 0.44 m "camera
     height" in the first real site's data is that bug wearing a number. */
  var recomputeFloor = function () {
    var best = null;
    Object.keys(N.planes).forEach(function (k) {
      var pl = N.planes[k];
      if (pl.alignment === 'vertical') return;  /* walls have no say in the floor */
      if (pl.w * pl.l < 2) return;              /* a deck is big; a duct is not */
      if (best == null || pl.z < best) best = pl.z;
    });
    N.floorY = best;
    if (window.ui && ui.live) ui.live.arFloor = best;
  };

  var proposeTimer = 0;
  window.__eeNativePlane = function (id, m, cx, cy, cz, w, h, rotY, cls, sess, alignment) {
    var r = EE.planeCornersFromARKit(m, cx, cy, cz, w, h, rotY);
    if (!r) return;
    r.id = id; r.cls = cls || 'none';
    r.alignment = alignment || 'horizontal';
    r.arSession = sess || N.sessionId; r.at = performance.now();
    N.planes[id] = r;
    recomputeFloor();
    /* Proposals are rebuilt at most once a second: planes grow continuously
       and the plan should not flicker with them. */
    if (window.proposeFromPlanes && !proposeTimer) {
      proposeTimer = setTimeout(function () {
        proposeTimer = 0;
        try { proposeFromPlanes(); } catch (e) { }
      }, 1000);
    }
  };
  window.__eeNativePlaneGone = function (id) {
    delete N.planes[id];
    recomputeFloor();
  };
  /* kept so an older shell build cannot throw */
  window.__eeNativeFloor = function (yMetres) { if (N.floorY == null) N.floorY = yMetres; };

  /* ---- capture ----

     The shell answers with a JPEG plus the pose it was taken at, so a shot is
     born already registered. Returns a promise; the phase-2 capture path
     consumes it in place of the canvas grab. */
  var pending = {}, seq = 0;
  window.__eeNativeFrame = function (id, jpegB64, m, fx, w, h, sessionId, photoId) {
    var cb = pending[id];
    delete pending[id];
    if (!cb) return;
    /* The frame the page will trace was shrunk by the shell; its lens entry is
       keyed to the size it actually has. */
    if (fx > 0 && w > 0 && window.db && db.settings) {
      var fov = EE.fovFromIntrinsics(fx, w, h);
      if (fov > 40 && fov < 100) {
        (db.settings.fovByFrame || (db.settings.fovByFrame = {}))[w + 'x' + h] = fov;
      }
    }
    cb({
      jpeg: jpegB64, pose: EE.arkitPose(m), fx: fx, w: w, h: h,
      sessionId: sessionId || N.sessionId,
      photoId: photoId || null
    });
  };

  /* Where the shell keeps a photograph it took, as a URL the page can fetch. */
  N.photoUrl = function (photoId) { return 'eagle-eye://app/_photos/' + photoId + '.jpg'; };
  N.deletePhoto = function (photoId) { if (photoId) send({ cmd: 'deletePhoto', id: photoId }); };

  /* A captured frame as something canvas can draw. The shell hands back base64
     rather than a blob URL because a data: URL crosses the bridge as plain
     text and needs no lifetime management on either side. */
  N.frameToImage = function (frame, cb) {
    if (!frame || !frame.jpeg) return cb(null);
    var img = new Image();
    img.onload = function () { cb(img, frame); };
    img.onerror = function () { cb(null); };
    img.src = 'data:image/jpeg;base64,' + frame.jpeg;
  };

  /* Ask the shell to draw the camera, or stop. The feed is only wanted on the
     capture and live screens; everywhere else the page paints its own ground
     and the AR view is power burnt behind it. */
  N.preview = function (on) { send({ cmd: 'preview', on: !!on }); };
  /* Callback first — the rest of this app is ES5 and callback-shaped, and a
     callback is testable without an event loop. A promise is returned too
     where the platform has one. */
  /* The shell shrinks the frame to the app's own pixel limit before saving,
     so the file on disk and the coordinates traced over it agree exactly. */
  var maxPxNow = function () {
    return (window.db && db.settings && db.settings.maxPx) || 1440;
  };
  N.captureFrame = function (cb) {
    var id = 'c' + (++seq);
    var fire = function (r) { if (cb) cb(r); };
    if (typeof Promise === 'function') {
      var p = new Promise(function (resolve) {
        pending[id] = function (r) { fire(r); resolve(r); };
      });
      send({ cmd: 'capture', id: id, maxPx: maxPxNow() });
      return p;
    }
    pending[id] = fire;
    send({ cmd: 'capture', id: id, maxPx: maxPxNow() });
    return null;
  };

  N.resetTracking = function () { send({ cmd: 'reset' }); };

  /* The hardware shutter — Camera Control, or either volume button. It fires
     wherever the app happens to be, so it checks that a shot is actually what
     the screen is offering rather than trusting the press. */
  window.__eeNativeShutter = function () {
    if (!window.view || view.screen !== 'capture') return;
    if (!window.ui || !ui.cap || !ui.cap.ready) return;
    if (N.tracking !== 'normal') return;      /* the same bar the on-screen one has */
    if (window.buzz) buzz(20);
    if (window.shoot) shoot();
  };

  /* The shell owns motion; never ask iOS for the web permission. */
  window.needsMotionPermission = function () { return false; };

  /* The page is opaque everywhere except the camera screens, where it must go
     clear for the AR view behind it to show. Toggled after every render rather
     than inside app.js, so the whole bridge stays additive. */
  var wrapRender = function () {
    var orig = window.render;
    if (typeof orig !== 'function' || orig.__eeWrapped) return;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      try {
        var camScreen = window.view &&
          (view.screen === 'capture' || view.screen === 'live');
        var want = !!(N.arkit && camScreen);
        if (want !== wrapped.__last) {
          wrapped.__last = want;
          document.documentElement.classList.toggle('ee-ar-live', want);
          N.preview(want);
        }
      } catch (e) { }
      return r;
    };
    wrapped.__eeWrapped = true;
    window.render = wrapped;
  };
  wrapRender();

  send({ cmd: 'ready' });
})();
