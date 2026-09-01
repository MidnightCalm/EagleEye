import UIKit
import ARKit
import SceneKit
import AVKit
import simd

/// The native capture screen — the first screen to leave the web view.
///
/// The page keeps the model: stations, proposals, storage, the plan, the
/// export. This screen owns everything the bridge served worst: the AR view,
/// the HUD, the decision of when a walking recorder banks a frame, the
/// shutter, and — the point of going native — the proposals drawn IN the
/// scene by SceneKit, in correct perspective, rather than re-projected onto a
/// canvas over a video. The host (SurveyViewController) still drives the
/// ARSession and talks to the page; this screen is told what to draw and asks
/// for frames.
final class CaptureViewController: UIViewController {

    // MARK: - the host's hooks

    /// A deliberate shutter press. The host captures the current frame.
    var onShutter: (() -> Void)?
    /// The screen is done; `banked` is how many frames the walk produced.
    var onClose: ((_ banked: Int) -> Void)?

    // MARK: - state

    struct Prefs {
        var recordPhotos = "all"     // all | sparse | none
        var maxPx = 1440
    }
    var prefs = Prefs() { didSet { refreshHUD() } }

    let arView: ARSCNView
    private let proposalsNode = SCNNode()

    private(set) var recording = false
    private(set) var banked = 0
    private(set) var walked: Float = 0
    private var surfaces = 0
    private var proposed = 0
    private var trackingWord = "initializing"
    private var trackingNormal = false

    private var lastBankPos: simd_float3?
    private var lastBankRot: simd_quatf?
    private var lastBankTime: TimeInterval = 0
    private var lastTickPos: simd_float3?

    /// The same thresholds the page's recorder used, so the field behaviour
    /// does not change underfoot: bank on a half-stride OR a glance, never
    /// faster than this, and never more than this many.
    static let moveM: Float = 0.35
    static let turnDeg: Float = 18
    static let sparseM: Float = 5
    static let minInterval: TimeInterval = 0.9
    static let maxShots = 500

    // MARK: - HUD

    private let trackingChip = PaddedLabel()
    private let surfacesValue = UILabel()
    private let proposedValue = UILabel()
    private let walkedValue = UILabel()
    private let hintLabel = UILabel()
    private let recordButton = UIButton(type: .system)
    private let doneButton = UIButton(type: .system)
    private let shutterButton = UIButton(type: .custom)
    private let shutterInner = UIView()
    private let closeButton = UIButton(type: .system)

    // MARK: - lifecycle

    init(arView: ARSCNView) {
        self.arView = arView
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Palette.bg

        arView.frame = view.bounds
        arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.isHidden = false
        view.addSubview(arView)
        arView.scene.rootNode.addChildNode(proposalsNode)

        buildHUD()

        // The Camera Control and the volume buttons, on this screen too: the
        // interaction on the host's view is underneath a presented controller.
        if #available(iOS 17.2, *) {
            let interaction = AVCaptureEventInteraction { [weak self] event in
                guard event.phase == .ended else { return }
                self?.shutterTapped()
            }
            view.addInteraction(interaction)
        }
        refreshHUD()
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: - what the host tells us

    /// Called for every ARKit frame. Returns true when the recorder wants
    /// this frame banked; the host captures it and calls `noteBanked()`.
    func tick(frame: ARFrame, tracking: String, surfaces: Int) -> Bool {
        trackingWord = tracking
        trackingNormal = (tracking == "normal")
        self.surfaces = surfaces

        let t = frame.camera.transform
        let pos = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        let rot = simd_quatf(t)

        if let lp = lastTickPos {
            // horizontal distance only: the walk, not the bobbing
            walked += simd_distance(simd_float2(pos.x, pos.z), simd_float2(lp.x, lp.z))
        }
        lastTickPos = pos

        defer { refreshHUD() }

        guard recording, trackingNormal, prefs.recordPhotos != "none" else { return false }

        let now = CACurrentMediaTime()
        if let lb = lastBankPos, let lr = lastBankRot {
            if now - lastBankTime < Self.minInterval { return false }
            let moved = simd_distance(pos, lb)
            let turned = Self.angleDeg(lr, rot)
            if prefs.recordPhotos == "sparse" {
                if moved < Self.sparseM { return false }
            } else if moved < Self.moveM && turned < Self.turnDeg {
                return false
            }
        }
        if banked >= Self.maxShots {
            recording = false
            hintLabel.text = "Banked \(banked) frames — plenty for one walk. Review, then start again if you need more."
            return false
        }
        lastBankPos = pos
        lastBankRot = rot
        lastBankTime = now
        return true
    }

    func noteBanked() {
        banked += 1
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        refreshHUD()
    }

    /// The page's proposals — merged unit tops and the parapet — in the app's
    /// frame (x east, y north, z up, metres). Drawn as wireframe boxes standing
    /// on the deck and a line loop at its edge. ARKit's world is x east, y up,
    /// z south, so app (x, y, z) lands at scene (x, z, -y).
    func setProposals(_ items: [[String: Any]], floorZ: Double) {
        proposalsNode.childNodes.forEach { $0.removeFromParentNode() }
        var nProposed = 0
        for it in items {
            let kind = it["kind"] as? String ?? ""
            let isProposed = (it["proposed"] as? Bool) ?? false
            if isProposed { nProposed += 1 }
            let color = isProposed ? Palette.purple : Palette.gold

            if kind == "rect",
               let cx = Self.num(it["cx"]), let cy = Self.num(it["cy"]),
               let w = Self.num(it["w"]), let l = Self.num(it["l"]),
               let rot = Self.num(it["rot"]), let h = Self.num(it["h"]), h > 0 {
                let box = SCNBox(width: CGFloat(w), height: CGFloat(h), length: CGFloat(l), chamferRadius: 0)
                box.materials = [Self.wire(color)]
                let node = SCNNode(geometry: box)
                node.position = SCNVector3(Float(cx), Float(floorZ + h / 2), Float(-cy))
                node.eulerAngles.y = Float(rot)
                proposalsNode.addChildNode(node)
            } else if kind == "outline", let pts = it["pts"] as? [[String: Any]] {
                var verts: [SCNVector3] = []
                for q in pts {
                    if let x = Self.num(q["x"]), let y = Self.num(q["y"]) {
                        verts.append(SCNVector3(Float(x), Float(floorZ + 0.05), Float(-y)))
                    }
                }
                guard verts.count >= 2 else { continue }
                var idx: [Int32] = []
                for i in 0..<verts.count {
                    idx.append(Int32(i))
                    idx.append(Int32((i + 1) % verts.count))
                }
                let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: verts)],
                                           elements: [SCNGeometryElement(indices: idx, primitiveType: .line)])
                geometry.materials = [Self.wire(color)]
                proposalsNode.addChildNode(SCNNode(geometry: geometry))
            }
        }
        proposed = nProposed
        refreshHUD()
    }

    // MARK: - actions

    @objc private func shutterTapped() {
        guard trackingNormal else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onShutter?()
    }

    @objc private func recordTapped() {
        recording.toggle()
        lastBankPos = nil
        lastBankRot = nil
        refreshHUD()
    }

    @objc private func doneTapped() {
        recording = false
        onClose?(banked)
    }

    // MARK: - HUD

    private func refreshHUD() {
        trackingChip.text = trackingNormal ? "TRACKING" : trackingWord.uppercased()
        trackingChip.textColor = trackingNormal ? Palette.green : Palette.amber
        trackingChip.layer.borderColor = (trackingNormal ? Palette.green : Palette.amber).withAlphaComponent(0.5).cgColor

        surfacesValue.text = "\(surfaces)"
        proposedValue.text = "\(proposed)"
        walkedValue.text = "\(Int(walked.rounded())) m"

        shutterButton.isEnabled = trackingNormal
        shutterButton.alpha = trackingNormal ? 1 : 0.4

        let policyNote: String
        switch prefs.recordPhotos {
        case "none": policyNote = "surfaces only"
        case "sparse": policyNote = "one photo per 5 m"
        default: policyNote = "every half-stride"
        }
        if recording {
            recordButton.setTitle("◉ Recording · \(banked) banked", for: .normal)
            recordButton.backgroundColor = Palette.purple
            recordButton.setTitleColor(Palette.bg, for: .normal)
            recordButton.layer.borderColor = Palette.purple.cgColor
        } else {
            recordButton.setTitle("◯ Walk and record", for: .normal)
            recordButton.backgroundColor = Palette.chip
            recordButton.setTitleColor(Palette.ink2, for: .normal)
            recordButton.layer.borderColor = Palette.line.cgColor
        }
        doneButton.isHidden = !(banked > 0 || walked > 1)

        if !trackingNormal {
            hintLabel.text = "ARKit is finding its bearings — move slowly across something with texture."
        } else if recording {
            hintLabel.text = "Walk past every unit; slow down where it is dense. Banking \(policyNote)."
        } else {
            hintLabel.text = "Proposed units and the parapet appear as you walk. Record, or shoot by hand."
        }
    }

    private func buildHUD() {
        let mono = UIFont.monospacedSystemFont(ofSize: 11, weight: .medium)
        let monoBig = UIFont.monospacedDigitSystemFont(ofSize: 22, weight: .regular)

        // top: tracking chip, close
        trackingChip.font = mono
        trackingChip.backgroundColor = Palette.chip
        trackingChip.layer.cornerRadius = 12
        trackingChip.layer.borderWidth = 1
        trackingChip.clipsToBounds = true
        trackingChip.insets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)

        closeButton.setTitle("✕", for: .normal)
        closeButton.titleLabel?.font = UIFont.systemFont(ofSize: 20)
        closeButton.setTitleColor(Palette.ink, for: .normal)
        closeButton.backgroundColor = Palette.chip
        closeButton.layer.cornerRadius = 17
        closeButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)

        // bottom sheet
        let foot = UIView()
        foot.backgroundColor = Palette.bg.withAlphaComponent(0.88)
        foot.layer.cornerRadius = 18
        foot.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]

        let stats = UIStackView(arrangedSubviews: [
            statCell("SURFACES", surfacesValue, monoBig, mono),
            statCell("PROPOSED", proposedValue, monoBig, mono, color: Palette.purple),
            statCell("WALKED", walkedValue, monoBig, mono)
        ])
        stats.axis = .horizontal
        stats.distribution = .fillEqually
        stats.spacing = 8

        hintLabel.font = UIFont.systemFont(ofSize: 13)
        hintLabel.textColor = Palette.ink2
        hintLabel.textAlignment = .center
        hintLabel.numberOfLines = 2

        recordButton.titleLabel?.font = mono
        recordButton.layer.cornerRadius = 15
        recordButton.layer.borderWidth = 1
        recordButton.contentEdgeInsets = UIEdgeInsets(top: 8, left: 14, bottom: 8, right: 14)
        recordButton.addTarget(self, action: #selector(recordTapped), for: .touchUpInside)

        doneButton.setTitle("Done · review", for: .normal)
        doneButton.titleLabel?.font = mono
        doneButton.setTitleColor(Palette.gold, for: .normal)
        doneButton.backgroundColor = Palette.chip
        doneButton.layer.cornerRadius = 15
        doneButton.layer.borderWidth = 1
        doneButton.layer.borderColor = Palette.gold.withAlphaComponent(0.5).cgColor
        doneButton.contentEdgeInsets = UIEdgeInsets(top: 8, left: 14, bottom: 8, right: 14)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)

        let pills = UIStackView(arrangedSubviews: [recordButton, doneButton])
        pills.axis = .horizontal
        pills.spacing = 8
        pills.alignment = .center

        shutterButton.layer.cornerRadius = 34
        shutterButton.layer.borderWidth = 3
        shutterButton.layer.borderColor = Palette.ink.cgColor
        shutterButton.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)
        shutterInner.backgroundColor = Palette.ink
        shutterInner.layer.cornerRadius = 27
        shutterInner.isUserInteractionEnabled = false
        shutterButton.addSubview(shutterInner)

        let column = UIStackView(arrangedSubviews: [stats, hintLabel, pills, shutterButton])
        column.axis = .vertical
        column.spacing = 12
        column.alignment = .center

        [trackingChip, closeButton, foot, column, shutterInner].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
        stats.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(trackingChip)
        view.addSubview(closeButton)
        view.addSubview(foot)
        foot.addSubview(column)

        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            trackingChip.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
            trackingChip.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 14),

            closeButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 10),
            closeButton.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -14),
            closeButton.widthAnchor.constraint(equalToConstant: 34),
            closeButton.heightAnchor.constraint(equalToConstant: 34),

            foot.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            foot.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            foot.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            column.topAnchor.constraint(equalTo: foot.topAnchor, constant: 14),
            column.leadingAnchor.constraint(equalTo: foot.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: foot.trailingAnchor, constant: -16),
            column.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -12),
            stats.widthAnchor.constraint(equalTo: column.widthAnchor),

            shutterButton.widthAnchor.constraint(equalToConstant: 68),
            shutterButton.heightAnchor.constraint(equalToConstant: 68),
            shutterInner.centerXAnchor.constraint(equalTo: shutterButton.centerXAnchor),
            shutterInner.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
            shutterInner.widthAnchor.constraint(equalToConstant: 54),
            shutterInner.heightAnchor.constraint(equalToConstant: 54)
        ])
    }

    private func statCell(_ title: String, _ value: UILabel, _ big: UIFont, _ small: UIFont,
                          color: UIColor = Palette.gold) -> UIView {
        let cell = UIView()
        cell.backgroundColor = Palette.chip
        cell.layer.cornerRadius = 10
        cell.layer.borderWidth = 1
        cell.layer.borderColor = Palette.line.cgColor

        let label = UILabel()
        label.text = title
        label.font = small
        label.textColor = Palette.muted
        label.textAlignment = .center

        value.font = big
        value.textColor = color
        value.textAlignment = .center

        let stack = UIStackView(arrangedSubviews: [value, label])
        stack.axis = .vertical
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: cell.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: cell.bottomAnchor, constant: -8),
            stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6)
        ])
        return cell
    }

    // MARK: - helpers

    private static func wire(_ color: UIColor) -> SCNMaterial {
        let m = SCNMaterial()
        m.diffuse.contents = color
        m.fillMode = .lines
        m.lightingModel = .constant
        m.isDoubleSided = true
        m.writesToDepthBuffer = false
        return m
    }

    private static func angleDeg(_ a: simd_quatf, _ b: simd_quatf) -> Float {
        let d = min(1, abs(simd_dot(a.vector, b.vector)))
        return acos(d) * 2 * 180 / .pi
    }

    private static func num(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }
}

/// The app's own palette, for the one native screen: the same tokens the page
/// wears (Solar Calculations/luxe-dark-theme.css).
enum Palette {
    static let bg     = UIColor(red: 0.039, green: 0.035, blue: 0.051, alpha: 1)   // #0A090D
    static let chip   = UIColor(red: 0.071, green: 0.063, blue: 0.086, alpha: 0.86) // #121016
    static let line   = UIColor(red: 0.149, green: 0.129, blue: 0.188, alpha: 1)   // #262130
    static let ink    = UIColor(red: 0.929, green: 0.918, blue: 0.957, alpha: 1)   // #EDEAF4
    static let ink2   = UIColor(red: 0.702, green: 0.678, blue: 0.769, alpha: 1)   // #B3ADC4
    static let muted  = UIColor(red: 0.522, green: 0.498, blue: 0.588, alpha: 1)   // #857F96
    static let purple = UIColor(red: 0.616, green: 0.549, blue: 1.000, alpha: 1)   // #9D8CFF
    static let gold   = UIColor(red: 0.894, green: 0.710, blue: 0.290, alpha: 1)   // #E4B54A
    static let green  = UIColor(red: 0.431, green: 0.824, blue: 0.604, alpha: 1)   // #6ED29A
    static let amber  = UIColor(red: 0.910, green: 0.788, blue: 0.416, alpha: 1)   // #E8C96A
}

/// A label with padding, for chips.
final class PaddedLabel: UILabel {
    var insets = UIEdgeInsets.zero
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + insets.left + insets.right, height: s.height + insets.top + insets.bottom)
    }
}
