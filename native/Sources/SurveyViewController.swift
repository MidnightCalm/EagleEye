import UIKit
import WebKit
import ARKit
import AVKit
import SceneKit
import CoreImage
import simd

/// The whole native shell: an ARSession feeding the existing web app.
///
/// The web app is not rewritten and not embedded piecemeal — it is the same
/// bundle that ships to GitHub Pages, served here over a custom scheme so it
/// runs in a secure context (file:// is not one, and half the browser APIs the
/// app relies on quietly degrade there). ARKit's pose and the lens's factory
/// intrinsics are pushed into it at frame rate; `native.js` on the other side
/// deposits them where the sensor path used to write, so nothing downstream
/// knows the difference except that it is now right.
final class SurveyViewController: UIViewController {

    private var webView: WKWebView!

    /// Phase 2: ARKit owns the camera. An ARSCNView behind a transparent web
    /// view draws the live frame, and shoot() is served from the same session
    /// — so the photograph and the pose it is measured against are one
    /// instant, and the web app never calls getUserMedia at all.
    /// Set false to fall back to the phase-1 shell: the web camera returns and
    /// everything still works, just without pose or factory intrinsics.
    private let arkitEnabled = true

    private var arView: ARSCNView!

    /// New every ARSession. Positions are only comparable within one: a cold
    /// start puts the world origin wherever the phone happens to be, so shots
    /// from different sessions must never be registered against each other by
    /// position alone.
    private let sessionId = UUID().uuidString

    private let session = ARSession()
    private var lastPush: TimeInterval = 0
    private var pendingCaptures: [(id: String, maxPx: Int)] = []

    /// Planes are re-reported by ARKit many times a second as they grow; the
    /// page wants the shape, not the heartbeat.
    private var planeLastSent: [UUID: TimeInterval] = [:]

    /// Which physical camera ARKit tracks with. Every ARKit device calibrates
    /// its visual-inertial tracking on the main wide camera; recent phones also
    /// list the ultra-wide as a trackable format. The page's setting chooses,
    /// and it is applied only before the first capture of a session — a
    /// restart moves the world origin, and a survey in progress must not.
    private var preferUltraWide = false
    private var capturedAny = false

    /// The native capture screen, while it is up. It borrows the AR view and
    /// gives it back on dismissal.
    private var captureVC: CaptureViewController?
    /// A deliberate shutter press on that screen, served from the next frame.
    private var pendingBank = false
    /// The page's recording preferences, mirrored so the native recorder
    /// behaves exactly as the page's did.
    private var recordPhotos = "all"
    private var maxPxPref = 1440
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    /// Pose pushes per second. 30 is smooth for an overlay and leaves the web
    /// app's own frame budget alone; ARKit itself runs at 60.
    private let pushInterval: TimeInterval = 1.0 / 30.0

    // MARK: - lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.039, green: 0.035, blue: 0.051, alpha: 1) // --lx-bg
        if arkitEnabled { buildARView() }
        buildWebView()
        buildHardwareShutter()
        session.delegate = self
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if arkitEnabled { startSession() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if arkitEnabled { session.pause() }
    }

    override var prefersStatusBarHidden: Bool { false }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    /// The Camera Control on iPhone 16, and the volume buttons on every phone,
    /// both arrive as capture events. On a roof in gloves, a physical button you
    /// can find without looking beats a target on glass — and pressing it moves
    /// the phone far less than reaching for the screen does, which for a
    /// measurement is the whole point.
    private func buildHardwareShutter() {
        guard #available(iOS 17.2, *) else { return }
        let interaction = AVCaptureEventInteraction { [weak self] event in
            // .ended is the release: a press-and-hold should not fire twice.
            guard event.phase == .ended else { return }
            self?.evaluate("window.__eeNativeShutter && window.__eeNativeShutter();")
        }
        view.addInteraction(interaction)
    }

    // MARK: - the camera behind the page

    private func buildARView() {
        arView = ARSCNView(frame: view.bounds)
        arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.session = session                 // shares the session we drive
        arView.automaticallyUpdatesLighting = false
        arView.rendersContinuously = true
        arView.isUserInteractionEnabled = false  // every touch belongs to the page
        arView.isHidden = true                   // shown only on camera screens
        view.addSubview(arView)
    }

    // MARK: - web

    private func buildWebView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: AppScheme.name)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let ucc = WKUserContentController()
        ucc.add(self, name: "eagleEye")
        config.userContentController = ucc

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.uiDelegate = self
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Transparent, so the ARSCNView shows through wherever the page does
        // not paint. The page paints its own ground everywhere EXCEPT the
        // camera screens, which go clear under the .ee-ar-live class.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        if #available(iOS 16.4, *) { webView.isInspectable = true }   // Safari devtools over USB
        view.addSubview(webView)

        webView.load(URLRequest(url: AppScheme.indexURL))
    }

    // MARK: - ARKit

    private func startSession() {
        guard ARWorldTrackingConfiguration.isSupported else {
            evaluate("window.__eeNativePose && 0;")   // no-op; app stays on sensors
            return
        }
        let cfg = ARWorldTrackingConfiguration()
        // Gravity AND heading: the world frame is then east/up/south, which is
        // what geo.js's conversion assumes, and yaw is true-north referenced —
        // so a survey lands correctly oriented with no compass guesswork.
        cfg.worldAlignment = .gravityAndHeading
        cfg.planeDetection = [.horizontal]
        cfg.isAutoFocusEnabled = true

        // What this phone offers, and which camera each format tracks on.
        let formats = ARWorldTrackingConfiguration.supportedVideoFormats
        var ultraWideAvailable = false
        for f in formats {
            NSLog("%@", "ARKit format \(Int(f.imageResolution.width))x\(Int(f.imageResolution.height)) "
                  + "@\(f.framesPerSecond)fps on \(f.captureDeviceType.rawValue)")
            if f.captureDeviceType == .builtInUltraWideCamera { ultraWideAvailable = true }
        }
        if preferUltraWide,
           let uw = formats.first(where: { $0.captureDeviceType == .builtInUltraWideCamera }) {
            cfg.videoFormat = uw
        }
        session.run(cfg, options: [.resetTracking, .removeExistingAnchors])
        capturedAny = false

        let active = cfg.videoFormat
        evaluate("window.__eeNativeLens && window.__eeNativeLens("
                 + "\(active.captureDeviceType.rawValue.jsQuoted), "
                 + "\(Int(active.imageResolution.width)), \(Int(active.imageResolution.height)), "
                 + "\(ultraWideAvailable ? "true" : "false"));")
    }

    private func evaluate(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func trackingWord(_ state: ARCamera.TrackingState) -> String {
        switch state {
        case .normal: return "normal"
        case .limited(let why):
            switch why {
            case .initializing: return "initializing"
            case .excessiveMotion: return "excessive-motion"
            case .insufficientFeatures: return "few-features"
            case .relocalizing: return "relocalizing"
            @unknown default: return "limited"
            }
        case .notAvailable: return "unavailable"
        }
    }

    /// The captured frame as a PORTRAIT JPEG, base64, with the dimensions it
    /// ended up with. ARKit hands over a landscape buffer regardless of how the
    /// device is held; the app is portrait-locked and its geometry assumes the
    /// photograph matches the interface, so the rotation is baked in here once
    /// rather than compensated for in four places later.
    private func portraitJPEG(from pixelBuffer: CVPixelBuffer, maxPx: Int,
                              quality: CGFloat = 0.72) -> (b64: String, data: Data, width: Int, height: Int)? {
        let ci = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return nil }

        // .right turns a landscape sensor buffer upright for a portrait UI.
        let rotated = UIImage(cgImage: cg, scale: 1, orientation: .right)
        var size = rotated.size
        let long = max(size.width, size.height)
        if maxPx > 0, long > CGFloat(maxPx) {
            let s = CGFloat(maxPx) / long
            size = CGSize(width: (size.width * s).rounded(), height: (size.height * s).rounded())
        }
        UIGraphicsBeginImageContextWithOptions(size, true, 1)
        rotated.draw(in: CGRect(origin: .zero, size: size))
        let baked = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()

        guard let out = baked, let data = out.jpegData(compressionQuality: quality) else { return nil }
        return (data.base64EncodedString(), data, Int(size.width), Int(size.height))
    }

    /// A frame banked by the native screen: saved to disk, then handed to the
    /// page as a finished station — pose, intrinsics, file name — with no
    /// image crossing the bridge at all.
    private func bankFrame(_ frame: ARFrame, maxPx: Int) {
        let m = frame.camera.transform.jsArray
        let k = frame.camera.intrinsics
        let captureLong = max(frame.camera.imageResolution.width, frame.camera.imageResolution.height)
        guard let shot = portraitJPEG(from: frame.capturedImage, maxPx: maxPx) else { return }
        let fx = Double(k.columns.0.x) * Double(max(shot.width, shot.height)) / Double(captureLong)
        let photoId = savePhoto(shot.data, id: "b" + String(UUID().uuidString.prefix(12)))
        capturedAny = true
        evaluate("window.__eeNativeBank && window.__eeNativeBank("
                 + "\(m), \(fx), \(shot.width), \(shot.height), "
                 + "\(sessionId.jsQuoted), \(photoId.jsQuoted));")
    }

    // MARK: - the native capture screen

    private func presentCapture() {
        guard arkitEnabled, captureVC == nil else { return }
        arView.removeFromSuperview()
        let vc = CaptureViewController(arView: arView)
        vc.prefs = CaptureViewController.Prefs(recordPhotos: recordPhotos, maxPx: maxPxPref)
        vc.onShutter = { [weak self] in self?.pendingBank = true }
        vc.onClose = { [weak self] banked in self?.dismissCapture(banked: banked) }
        captureVC = vc
        present(vc, animated: true)
    }

    private func dismissCapture(banked: Int) {
        guard let vc = captureVC else { return }
        vc.dismiss(animated: true) { [weak self] in
            guard let self = self else { return }
            self.arView.removeFromSuperview()
            self.arView.frame = self.view.bounds
            self.arView.isHidden = true
            self.view.insertSubview(self.arView, at: 0)
            self.captureVC = nil
            self.evaluate("window.__eeNativeCaptureClosed && window.__eeNativeCaptureClosed(\(banked));")
        }
    }

    /// Photographs live in the app's Documents directory as ordinary files —
    /// backed up, unlimited but for the device, and readable by the scheme
    /// handler below. Returns the name the page should remember, or "" if the
    /// write failed, which the page treats as a photo that does not exist.
    private func savePhoto(_ data: Data, id: String) -> String {
        let safe = String(id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        guard !safe.isEmpty else { return "" }
        let url = AppScheme.photosDir.appendingPathComponent("\(safe).jpg")
        do {
            try data.write(to: url, options: .atomic)
            return safe
        } catch {
            NSLog("%@", "photo write failed: \(error.localizedDescription)")
            return ""
        }
    }
}

// MARK: - ARSessionDelegate

extension SurveyViewController: ARSessionDelegate {

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let now = CACurrentMediaTime()

        // Any capture the web app asked for is served from THIS frame, so the
        // photograph and the pose it is measured against are the same instant.
        if !pendingCaptures.isEmpty {
            let requests = pendingCaptures
            pendingCaptures.removeAll()
            let m = frame.camera.transform.jsArray
            let k = frame.camera.intrinsics
            let captureLong = max(frame.camera.imageResolution.width, frame.camera.imageResolution.height)
            for req in requests {
                // The captured buffer is always landscape whatever the device is
                // doing; the app is portrait and its geometry assumes the frame
                // matches. Rotate — and shrink to the app's own pixel limit —
                // once here, so every downstream consumer stays as written.
                guard let shot = portraitJPEG(from: frame.capturedImage, maxPx: req.maxPx) else { continue }
                // Intrinsics are per pixel of the ORIGINAL frame; a shrunk frame
                // has a proportionally shorter focal length.
                let fx = Double(k.columns.0.x) * Double(max(shot.width, shot.height)) / Double(captureLong)
                // The photograph is written to disk HERE, by the shell, and the
                // page keeps only its name. IndexedDB in a custom-scheme origin
                // swallowed 220 frames of a real roof without a word.
                let photoId = savePhoto(shot.data, id: req.id)
                capturedAny = true
                evaluate("window.__eeNativeFrame && window.__eeNativeFrame("
                         + "\(req.id.jsQuoted), \(shot.b64.jsQuoted), \(m), \(fx), "
                         + "\(shot.width), \(shot.height), \(sessionId.jsQuoted), \(photoId.jsQuoted));")
            }
        }

        if let vc = captureVC {
            let word = trackingWord(frame.camera.trackingState)
            let wantAuto = vc.tick(frame: frame, tracking: word, surfaces: planeLastSent.count)
            if wantAuto || pendingBank {
                pendingBank = false
                bankFrame(frame, maxPx: maxPxPref)
                vc.noteBanked()
            }
        }

        guard now - lastPush >= pushInterval else { return }
        lastPush = now

        let m = frame.camera.transform.jsArray
        let fx = frame.camera.intrinsics.columns.0.x
        let size = frame.camera.imageResolution
        let state = trackingWord(frame.camera.trackingState).jsQuoted
        // Portrait dimensions, matching what portraitJPEG will hand back, so
        // the lens lands under the frame size the photographs actually carry.
        evaluate("window.__eeNativePose && window.__eeNativePose("
                 + "\(m), \(state), \(fx), \(Int(size.height)), \(Int(size.width)), "
                 + "\(sessionId.jsQuoted));")
    }

    /// Every plane ARKit knows about, as it learns it. A rooftop is planes all
    /// the way down: the deck is the lowest broad horizontal one, every RTU top
    /// is an elevated horizontal rectangle, and the parapet is a ring of
    /// vertical ones — which is the survey, before anyone has tapped anything.
    /// The page decides which is which.
    private func forwardPlanes(_ anchors: [ARAnchor], force: Bool) {
        let now = CACurrentMediaTime()
        for a in anchors {
            guard let plane = a as? ARPlaneAnchor else { continue }
            let alignment = plane.alignment == .vertical ? "vertical" : "horizontal"
            if !force, let t = planeLastSent[plane.identifier], now - t < 0.5 { continue }
            planeLastSent[plane.identifier] = now
            let c = plane.center
            let e = plane.planeExtent
            let cls: String
            switch plane.classification {
            case .floor: cls = "floor"
            case .table: cls = "table"
            case .ceiling: cls = "ceiling"
            case .wall: cls = "wall"
            default: cls = "none"
            }
            evaluate("window.__eeNativePlane && window.__eeNativePlane("
                     + "\(plane.identifier.uuidString.jsQuoted), \(plane.transform.jsArray), "
                     + "\(c.x), \(c.y), \(c.z), \(e.width), \(e.height), \(e.rotationOnYAxis), "
                     + "\(cls.jsQuoted), \(sessionId.jsQuoted), \(alignment.jsQuoted));")
        }
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        forwardPlanes(anchors, force: true)
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        forwardPlanes(anchors, force: false)
    }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for a in anchors where a is ARPlaneAnchor {
            planeLastSent[a.identifier] = nil
            evaluate("window.__eeNativePlaneGone && window.__eeNativePlaneGone(\(a.identifier.uuidString.jsQuoted));")
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        NSLog("%@", "ARSession failed: \(error.localizedDescription)")
    }

    func sessionWasInterrupted(_ session: ARSession) {
        evaluate("window.EENative && (window.EENative.tracking = 'interrupted');")
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        evaluate("window.EENative && (window.EENative.tracking = 'relocalizing');")
    }

    func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { true }
}

// MARK: - messages from the web app

extension SurveyViewController: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "ready":
            NSLog("Eagle Eye web bundle reported ready")
        case "capture":
            if let id = body["id"] as? String {
                let maxPx = (body["maxPx"] as? Int) ?? 1440
                pendingCaptures.append((id: id, maxPx: maxPx))
            }
        case "openCapture":
            presentCapture()
        case "prefs":
            recordPhotos = (body["recordPhotos"] as? String) ?? "all"
            maxPxPref = (body["maxPx"] as? Int) ?? 1440
            captureVC?.prefs = CaptureViewController.Prefs(recordPhotos: recordPhotos, maxPx: maxPxPref)
        case "proposals":
            let items = (body["items"] as? [[String: Any]]) ?? []
            let floorZ = (body["floorZ"] as? Double) ?? 0
            captureVC?.setProposals(items, floorZ: floorZ)
        case "lens":
            // Honoured only before the first capture of a session: switching
            // the tracked camera restarts tracking and moves the world origin,
            // which a survey in progress cannot survive.
            let want = (body["ultraWide"] as? Bool) ?? false
            if want != preferUltraWide {
                preferUltraWide = want
                if arkitEnabled && !capturedAny { startSession() }
            }
        case "deletePhoto":
            if let id = body["id"] as? String {
                let safe = String(id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
                try? FileManager.default.removeItem(at: AppScheme.photosDir.appendingPathComponent("\(safe).jpg"))
            }
        case "reset":
            startSession()
        case "preview":
            // The camera feed is only wanted on the capture and live screens;
            // everywhere else the page paints its own ground and the AR view is
            // wasted power behind it.
            let on = (body["on"] as? Bool) ?? false
            DispatchQueue.main.async {
                if self.captureVC == nil { self.arView?.isHidden = !on }
            }
        default:
            break
        }
    }
}

// MARK: - permission prompts the shell answers on the app's behalf

extension SurveyViewController: WKUIDelegate {

    /// Without this WebKit denies every getUserMedia call outright and both
    /// camera screens show a Safari-settings message that means nothing in a
    /// native bundle. The only origin served is our own bundle, and both call
    /// sites ask for video alone.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .camera ? .grant : .deny)
    }

    /// The documented route for DeviceOrientationEvent.requestPermission. With
    /// ARKit gated off this is the app's ONLY attitude source, so it is load
    /// bearing rather than insurance.
    func webView(_ webView: WKWebView,
                 requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}

// MARK: - serving the bundled web app

enum AppScheme {
    static let name = "eagle-eye"
    static let host = "app"
    static var indexURL: URL { URL(string: "\(name)://\(host)/index.html")! }
    static var root: URL { Bundle.main.bundleURL.appendingPathComponent("www") }

    /// Documents/photos — created on first use.
    static var photosDir: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("photos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

/// Serves `www/` from the app bundle over a custom scheme. WKWebView treats a
/// registered scheme as a first-class origin, so localStorage and IndexedDB
/// behave as they do on the deployed site. Service workers do NOT: WebKit
/// registers those only for http(s) origins, so sw.js is inert here and the
/// in-app update check falls back to its no-worker path. Nothing is lost —
/// the bundle is already local.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {

    private static let types: [String: String] = [
        "html": "text/html", "js": "text/javascript", "css": "text/css",
        "json": "application/json", "webmanifest": "application/manifest+json",
        "png": "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml"
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { task.didFailWithError(SchemeError.badURL); return }
        var rel = url.path
        if rel.isEmpty || rel == "/" { rel = "/index.html" }
        // A query string is cache-busting, never part of the path.
        // Photographs are served from Documents, everything else from the bundle.
        let photoPrefix = "/_photos/"
        let file: URL
        if rel.hasPrefix(photoPrefix) {
            let name = String(rel.dropFirst(photoPrefix.count))
            guard !name.contains("/"), !name.contains("..") else {
                task.didFailWithError(SchemeError.badURL); return
            }
            file = AppScheme.photosDir.appendingPathComponent(name)
        } else {
            file = AppScheme.root.appendingPathComponent(rel)
        }

        guard let data = try? Data(contentsOf: file) else {
            task.didFailWithError(SchemeError.notFound(rel))
            return
        }
        let ext = file.pathExtension.lowercased()
        let mime = Self.types[ext] ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": mime,
                                                      "Cache-Control": "no-cache"])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { }

    enum SchemeError: Error { case badURL, notFound(String) }
}

// MARK: - small conveniences

extension simd_float4x4 {
    /// Column-major, exactly as `geo.js`'s arkitPose expects it.
    var jsArray: String {
        let c = [columns.0, columns.1, columns.2, columns.3]
        let flat = c.flatMap { [$0.x, $0.y, $0.z, $0.w] }
        return "[" + flat.map { String(format: "%.6f", $0) }.joined(separator: ",") + "]"
    }
}

extension String {
    /// JSON-safe single-quoted literal for embedding in an evaluateJavaScript call.
    var jsQuoted: String {
        let escaped = self
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "")
        return "'\(escaped)'"
    }
}
