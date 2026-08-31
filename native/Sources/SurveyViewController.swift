import UIKit
import WebKit
import ARKit

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
    private let session = ARSession()
    private var lastPush: TimeInterval = 0
    private var pendingCaptures: [String] = []
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    /// Pose pushes per second. 30 is smooth for an overlay and leaves the web
    /// app's own frame budget alone; ARKit itself runs at 60.
    private let pushInterval: TimeInterval = 1.0 / 30.0

    // MARK: - lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.039, green: 0.035, blue: 0.051, alpha: 1) // --lx-bg
        buildWebView()
        session.delegate = self
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startSession()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session.pause()
    }

    override var prefersStatusBarHidden: Bool { false }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

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
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
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
        if type(of: cfg).supportsFrameSemantics(.sceneDepth) {
            cfg.frameSemantics.insert(.sceneDepth)   // LiDAR when the light allows
        }
        session.run(cfg, options: [.resetTracking, .removeExistingAnchors])
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

    /// The captured frame as JPEG, in the orientation the buffer arrives in.
    private func jpeg(from pixelBuffer: CVPixelBuffer, quality: CGFloat = 0.72) -> String? {
        let ci = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return nil }
        let data = UIImage(cgImage: cg).jpegData(compressionQuality: quality)
        return data?.base64EncodedString()
    }
}

// MARK: - ARSessionDelegate

extension SurveyViewController: ARSessionDelegate {

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let now = CACurrentMediaTime()

        // Any capture the web app asked for is served from THIS frame, so the
        // photograph and the pose it is measured against are the same instant.
        if !pendingCaptures.isEmpty {
            let ids = pendingCaptures
            pendingCaptures.removeAll()
            let m = frame.camera.transform.jsArray
            let k = frame.camera.intrinsics
            let size = frame.camera.imageResolution
            if let b64 = jpeg(from: frame.capturedImage) {
                for id in ids {
                    evaluate("window.__eeNativeFrame && window.__eeNativeFrame("
                             + "\(id.jsQuoted), \(b64.jsQuoted), \(m), \(k.columns.0.x), "
                             + "\(Int(size.width)), \(Int(size.height)));")
                }
            }
        }

        guard now - lastPush >= pushInterval else { return }
        lastPush = now

        let m = frame.camera.transform.jsArray
        let fx = frame.camera.intrinsics.columns.0.x
        let size = frame.camera.imageResolution
        let state = trackingWord(frame.camera.trackingState).jsQuoted
        evaluate("window.__eeNativePose && window.__eeNativePose("
                 + "\(m), \(state), \(fx), \(Int(size.width)), \(Int(size.height)));")
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        // The lowest broad horizontal plane is the deck the survey stands on.
        for a in anchors {
            guard let plane = a as? ARPlaneAnchor, plane.alignment == .horizontal else { continue }
            let y = plane.transform.columns.3.y
            evaluate("window.__eeNativeFloor && window.__eeNativeFloor(\(y));")
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        NSLog("ARSession failed: \(error.localizedDescription)")
    }

    func sessionWasInterrupted(_ session: ARSession) {
        evaluate("window.EENative && (window.EENative.tracking = 'interrupted');")
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        startSession()
    }
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
            if let id = body["id"] as? String { pendingCaptures.append(id) }
        case "reset":
            startSession()
        default:
            break
        }
    }
}

// MARK: - serving the bundled web app

enum AppScheme {
    static let name = "eagle-eye"
    static let host = "app"
    static var indexURL: URL { URL(string: "\(name)://\(host)/index.html")! }
    static var root: URL { Bundle.main.bundleURL.appendingPathComponent("www") }
}

/// Serves `www/` from the app bundle over a custom scheme. WKWebView treats a
/// registered scheme as a first-class origin, which keeps the web app in a
/// secure context — storage, service worker and camera all behave as they do
/// on the deployed site.
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
        let file = AppScheme.root.appendingPathComponent(rel)

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
