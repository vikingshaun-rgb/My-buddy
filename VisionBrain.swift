//
//  VisionBrain.swift
//  The entire client side of Vision, in one file.
//
//  Drop this into a new Xcode project and the app can already talk, listen and
//  see. Nothing here decides anything — the brain does that. This file only
//  moves words and pictures between the phone and the server, which is exactly
//  what the roadmap means by "thin connector".
//
//  Deliberately NOT included, because the brain already does them and doing
//  them twice is how a three-day burst becomes three weeks:
//    · working out which skill he meant  → POST /route
//    · deciding what to say              → every response carries `spoken`
//    · remembering anything              → the server's memory, not the phone's
//    · which skills need a camera        → POST /native/hello tells you
//
//  Requires iOS 15.2+ (same floor as the Meta AI app). No third-party packages.
//
//  Info.plist needs:
//    NSMicrophoneUsageDescription       "Vision listens when you talk to it."
//    NSSpeechRecognitionUsageDescription "Vision turns what you say into words."
//    NSCameraUsageDescription           "Vision looks at what you show it."
//    NSLocationWhenInUseUsageDescription "Vision uses where you are for directions."
//

import Foundation
import AVFoundation
import Speech

// MARK: - Configuration

/// Where the brain lives and how to prove we're allowed to talk to it.
/// Both come from Settings in the app — never hardcode the token into a build.
struct VisionConfig {
    var baseURL: URL
    var token: String

    static func fromDefaults() -> VisionConfig? {
        let d = UserDefaults.standard
        guard let s = d.string(forKey: "vision_url"),
              let url = URL(string: s),
              let tok = d.string(forKey: "vision_token"), !tok.isEmpty
        else { return nil }
        return VisionConfig(baseURL: url, token: tok)
    }

    func save() {
        let d = UserDefaults.standard
        d.set(baseURL.absoluteString, forKey: "vision_url")
        d.set(token, forKey: "vision_token")
    }
}

// MARK: - What the brain sends back

/// Every model-backed endpoint returns `spoken`. That promise is the whole
/// reason this file is short: the client never has to know which field to read.
struct BrainReply: Decodable {
    let spoken: String?
    let reply: String?
    let skill: String?
    let args: [String: AnyCodable]?
    let confidence: Double?
    let fallback: Bool?
    let error: String?

    /// The one line to say out loud, whatever the endpoint was.
    var speakable: String {
        if let s = spoken, !s.isEmpty { return s }
        if let r = reply, !r.isEmpty { return r }
        if let e = error, !e.isEmpty { return "Something went wrong: \(e)" }
        return ""
    }
}

/// What /native/hello tells us about this particular server.
struct Handshake: Decodable {
    struct Skill: Decodable {
        let name: String
        let what: String
        let needsImage: Bool
        let needsLocation: Bool
        let confirmFirst: Bool
    }
    struct Limits: Decodable {
        let imageMaxBase64Bytes: Int
        let imageMinEdgePx: Int
        let imageRecommendedMaxEdgePx: Int
        let callsPerMinute: Int
        let requestTimeoutMs: Int
    }
    let contract: Int
    let skills: [Skill]
    let have: [String: Bool]
    let limits: Limits

    func skill(_ name: String) -> Skill? { skills.first { $0.name == name } }
}

/// JSON args come back with mixed types; this keeps them usable without
/// inventing a struct per skill.
struct AnyCodable: Decodable {
    let value: Any
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode(Int.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode(Bool.self) { value = v }
        else { value = "" }
    }
    var string: String { value as? String ?? "\(value)" }
}

// MARK: - The brain

@MainActor
final class VisionBrain: ObservableObject {

    @Published private(set) var handshake: Handshake?
    @Published private(set) var lastError: String?
    @Published private(set) var isThinking = false

    private let config: VisionConfig
    private let session: URLSession

    init(config: VisionConfig) {
        self.config = config
        let c = URLSessionConfiguration.default
        // Vision calls can involve a photo and a model, so the default 60s is
        // right — but a hung request must not sit there forever.
        c.timeoutIntervalForRequest = 60
        c.waitsForConnectivity = true
        self.session = URLSession(configuration: c)
    }

    // MARK: Talking to it

    /// One call for every endpoint. Returns the decoded reply, or throws with
    /// something worth saying out loud.
    func post(_ path: String, _ body: [String: Any] = [:]) async throws -> BrainReply {
        var req = URLRequest(url: config.baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: req)
        let http = response as? HTTPURLResponse
        let code = http?.statusCode ?? 0

        // 401 and 429 are the two he'll actually hit, and both deserve a real
        // sentence rather than a status code.
        if code == 401 {
            throw VisionError.spoken("I can't reach your brain — check the token in Settings.")
        }
        if code == 429 {
            throw VisionError.spoken("You're going a bit fast for me — give me a moment.")
        }

        let reply = try JSONDecoder().decode(BrainReply.self, from: data)

        // The brain answers 200 with fallback:true rather than an error status,
        // precisely so the client can always say something.
        if code >= 500 && reply.speakable.isEmpty {
            throw VisionError.spoken("My brain hiccuped there — try me again.")
        }
        return reply
    }

    /// Call once on launch. After this the app knows what this server can do,
    /// which skills need a camera, and what it must handle itself.
    @discardableResult
    func hello() async throws -> Handshake {
        var req = URLRequest(url: config.baseURL.appendingPathComponent("native/hello"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "authorization")
        req.httpBody = "{}".data(using: .utf8)

        let (data, _) = try await session.data(for: req)
        let h = try JSONDecoder().decode(Handshake.self, from: data)
        self.handshake = h
        return h
    }

    // MARK: The one flow that matters

    /// Everything the app does goes through here: he says a thing, the brain
    /// decides what it was, the right endpoint runs, and we speak the answer.
    ///
    /// `provideImage` is only called if the chosen skill actually needs a photo,
    /// so the camera never opens speculatively.
    func handle(
        said: String,
        location: (lat: Double, lng: Double)? = nil,
        provideImage: (() async -> String?)? = nil,
        confirm: ((String) async -> Bool)? = nil
    ) async {
        isThinking = true
        defer { isThinking = false }

        do {
            // 1. What did he mean? Always ask — local pattern-matching is how
            //    a client drifts out of step with the brain.
            let routed = try await post("route", ["message": said])
            let skill = routed.skill ?? "chat"

            // 2. Plain conversation needs nothing else.
            if skill == "chat" || (routed.confidence ?? 0) < 0.55 {
                let r = try await post("chat", ["message": said])
                await Speaker.shared.say(r.speakable)
                return
            }

            let meta = handshake?.skill(skill)
            var body: [String: Any] = ["message": said]
            if let args = routed.args {
                for (k, v) in args { body[k] = v.value }
            }

            // 3. Only open the camera if this skill genuinely needs one.
            if meta?.needsImage == true {
                guard let getImage = provideImage, let b64 = await getImage() else {
                    await Speaker.shared.say("I'd need to see it — show me and ask again.")
                    return
                }
                body["image"] = b64
                body["mediaType"] = "image/jpeg"
            }

            if meta?.needsLocation == true, let loc = location {
                body["lat"] = loc.lat
                body["lng"] = loc.lng
            }

            // 4. Anything touching a shared list gets confirmed first. Four of
            //    his lists are his wife's, so a mis-heard word is her problem.
            if meta?.confirmFirst == true, let ask = confirm {
                let ok = await ask("\(said) — go ahead?")
                if !ok { await Speaker.shared.say("Left it alone."); return }
            }

            let r = try await post(endpointFor(skill), body)
            await Speaker.shared.say(r.speakable)

        } catch let e as VisionError {
            await Speaker.shared.say(e.spokenText)
        } catch {
            lastError = error.localizedDescription
            await Speaker.shared.say("I couldn't reach my brain just then.")
        }
    }

    /// Most skills map to an endpoint of the same name. The handful that don't
    /// are listed here rather than scattered through the app.
    private func endpointFor(_ skill: String) -> String {
        switch skill {
        case "jobreport":   return "job/report"
        case "jobcapture":  return "job/capture"
        case "jobrecall":   return "job/recall"
        case "myday":       return "calendar/day"
        case "showlist":    return "calendar/list"
        case "tickoff":     return "calendar/tick/prepare"
        case "addlist":     return "calendar/add"
        case "addevent":    return "calendar/event"
        case "amifree":     return "calendar/free"
        case "talkto":      return "converse/turn"
        case "phrasebook":  return "converse/phrases"
        case "readtexts":   return "texts/check"
        case "nearby":      return "places"
        case "navigate":    return "directions"
        default:            return skill
        }
    }

    // MARK: Watchers

    /// Poll on foreground, then acknowledge ONLY what was shown. The server
    /// deliberately does not mark things seen on read — a finding he never sees
    /// is the same as no finding.
    func checkWatchers(show: ([String]) -> Void) async {
        do {
            let r = try await post("watchers", ["action": "latest"])
            guard let raw = try? await postRaw("watchers", ["action": "latest"]),
                  let fresh = raw["fresh"] as? [[String: Any]], !fresh.isEmpty else { return }
            let shown = Array(fresh.prefix(3))
            show(shown.compactMap { $0["spoken"] as? String })
            if let newest = shown.compactMap({ $0["at"] as? Double }).max() {
                _ = try? await post("watchers", ["action": "seen", "upto": newest])
            }
            _ = r
        } catch { /* watchers are best-effort — never block the app on them */ }
    }

    private func postRaw(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        var req = URLRequest(url: config.baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await session.data(for: req)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

enum VisionError: Error {
    case spoken(String)
    var spokenText: String { if case .spoken(let s) = self { return s }; return "Something went wrong." }
}

// MARK: - Speaking

/// AVSpeechSynthesizer, which is the main reason to go native at all: it can be
/// stopped mid-word, it has proper voices for Thai and Vietnamese, and it works
/// with the screen off.
@MainActor
final class Speaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = Speaker()
    private let synth = AVSpeechSynthesizer()
    @Published private(set) var speaking = false

    override init() {
        super.init()
        synth.delegate = self
        // .duckOthers so music drops rather than stops; .spokenAudio so it keeps
        // playing with the screen locked, which the web app could never do.
        try? AVAudioSession.sharedInstance().setCategory(
            .playback, mode: .spokenAudio, options: [.duckOthers, .allowBluetooth, .allowBluetoothA2DP])
    }

    func say(_ text: String, language: String? = nil) async {
        guard !text.isEmpty else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: language ?? "en-AU")
        // Foreign speech slightly slower — at native rate it's a wall of sound
        // to whoever's trying to follow it.
        if let l = language, !l.hasPrefix("en") { u.rate = 0.46 } else { u.rate = 0.5 }
        speaking = true
        synth.speak(u)
    }

    /// Barge-in: the standout feature of a native build. He can cut it off
    /// mid-sentence and the mic is still live — the web app could never do this.
    func stop() {
        synth.stopSpeaking(at: .immediate)
        speaking = false
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in self.speaking = false }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in self.speaking = false }
    }
}

// MARK: - Listening

/// Continuous speech recognition. The other reason to go native: this runs
/// while Vision is speaking, so "stop", "not now" and "tell me later" actually
/// land — which is impossible in a browser.
@MainActor
final class Listener: ObservableObject {
    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-AU"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    @Published private(set) var listening = false
    @Published var heard = ""

    /// Words that stop Vision immediately, checked on every partial result so
    /// they work mid-sentence rather than after it finishes.
    private let interrupts = ["stop", "shut up", "not now", "quiet", "enough"]

    func requestPermission() async -> Bool {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { s in c.resume(returning: s == .authorized) }
        }
    }

    func start(onFinal: @escaping (String) -> Void, onInterrupt: @escaping () -> Void) throws {
        guard !listening else { return }
        task?.cancel(); task = nil

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        request = req

        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buf, _ in
            req.append(buf)
        }
        engine.prepare()
        try engine.start()
        listening = true

        task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let r = result {
                let text = r.bestTranscription.formattedString
                Task { @MainActor in
                    self.heard = text
                    // Barge-in, checked on PARTIAL results so it lands mid-word.
                    let low = text.lowercased()
                    if Speaker.shared.speaking, self.interrupts.contains(where: { low.hasSuffix($0) }) {
                        Speaker.shared.stop()
                        onInterrupt()
                        return
                    }
                    if r.isFinal { onFinal(text) }
                }
            }
            if error != nil || result?.isFinal == true {
                Task { @MainActor in self.stop() }
            }
        }
    }

    func stop() {
        guard listening else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        listening = false
    }
}

// MARK: - Pictures

enum Capture {
    /// Downscale and encode the way the brain expects. Sending a full-resolution
    /// photo means waiting out the upload only to have Anthropic reject it —
    /// which on hotel wifi is a long wait for nothing.
    static func base64(_ image: UIImage, maxEdge: CGFloat = 1400, quality: CGFloat = 0.82) -> String? {
        let w = image.size.width, h = image.size.height
        guard w > 0, h > 0 else { return nil }
        // The brain refuses anything under 200px on the long edge, so don't send it.
        guard max(w, h) >= 200 else { return nil }

        let scale = min(1, maxEdge / max(w, h))
        let size = CGSize(width: w * scale, height: h * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return resized.jpegData(compressionQuality: quality)?.base64EncodedString()
    }
}

#if canImport(UIKit)
import UIKit
#endif

/*
 A whole working loop, for reference:

     let cfg = VisionConfig.fromDefaults()!
     let brain = VisionBrain(config: cfg)
     try await brain.hello()                       // once, on launch

     let listener = Listener()
     guard await listener.requestPermission() else { return }

     try listener.start(
         onFinal: { said in
             Task {
                 await brain.handle(
                     said: said,
                     location: currentLocation,
                     provideImage: { Capture.base64(await camera.snap()) },
                     confirm: { question in await ui.askYesNo(question) }
                 )
             }
         },
         onInterrupt: { print("he cut me off") }
     )

 That is the entire app. Everything else — which skills exist, what to say,
 what to remember — comes from the brain.
*/
