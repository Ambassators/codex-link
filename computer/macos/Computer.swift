import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
import Carbon

// One bounded request per process. No listener, shell evaluation, permission changes,
// clipboard access. Permission prompts are owner-only. Background pointer routing
// uses one runtime-checked, undocumented coordinate setter (see WindowPointer).
struct ComputerError: Error {
    let code: String
    let message: String
}
func require(_ condition: Bool, _ code: String, _ message: String) throws {
    if !condition { throw ComputerError(code: code, message: message) }
}
func string(_ object: [String: Any], _ key: String, _ max: Int = 4096) throws -> String {
    guard let value = object[key] as? String, !value.isEmpty, value.utf16.count <= max else {
        throw ComputerError(code: "invalid_request", message: "Invalid \(key)")
    }
    return value
}
func number(_ object: [String: Any], _ key: String) throws -> Double {
    guard let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else {
        throw ComputerError(code: "invalid_request", message: "Invalid numeric \(key)")
    }
    return value.doubleValue
}
func boundedInt(_ object: [String: Any], _ key: String, _ fallback: Int, _ low: Int, _ high: Int) throws -> Int {
    if object[key] == nil { return fallback }
    let value = try number(object, key)
    try require(value.rounded() == value && value >= Double(low) && value <= Double(high), "invalid_request", "Invalid \(key)")
    return Int(value)
}
func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) }
func fingerprint(_ value: Any) -> String {
    let data = (try? json(value)) ?? Data()
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
func rectJSON(_ rect: CGRect) -> [String: Any] {
    ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}
func rectFrom(_ value: [String: Any]) throws -> CGRect {
    let rect = CGRect(x: try number(value, "x"), y: try number(value, "y"), width: try number(value, "width"), height: try number(value, "height"))
    try require(rect.width > 0 && rect.height > 0 && rect.width <= 65536 && rect.height <= 65536, "invalid_geometry", "Window geometry is not usable")
    return rect
}
func closeRect(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
}
func windowPoint(_ point: CGPoint, in bounds: CGRect) -> CGPoint {
    CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func axString(_ element: AXUIElement, _ name: String) -> String {
    String(((attribute(element, name) as? String) ?? "").prefix(1000))
}
func axRect(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, kAXPositionAttribute), let s = attribute(element, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
          [point.x, point.y, size.width, size.height].allSatisfy({ $0.isFinite }) else { return nil }
    return CGRect(origin: point, size: size)
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    var values: CFArray?
    let result = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, 500, &values)
    return result == .success ? (values as? [AXUIElement] ?? []) : []
}
func protectedElement(_ element: AXUIElement) -> Bool {
    axString(element, kAXSubroleAttribute) == "AXSecureTextField" || (attribute(element, "AXProtectedContent") as? Bool) == true
}
func descriptor(_ element: AXUIElement) -> [String: Any] {
    let secure = protectedElement(element)
    var actions: CFArray?
    _ = AXUIElementCopyActionNames(element, &actions)
    let role = axString(element, kAXRoleAttribute)
    let subrole = axString(element, kAXSubroleAttribute)
    let title = secure ? "[protected]" : axString(element, kAXTitleAttribute)
    let label = secure ? "[protected]" : axString(element, kAXDescriptionAttribute)
    let identifier = axString(element, kAXIdentifierAttribute)
    let bounds = axRect(element).map(rectJSON) ?? [:]
    var value: [String: Any] = ["role": role, "subrole": subrole, "name": title.isEmpty ? label : title,
        "automationId": identifier, "bounds": bounds, "protected": secure,
        "enabled": (attribute(element, kAXEnabledAttribute) as? Bool) ?? true,
        "actions": actions as? [String] ?? []]
    value["fingerprint"] = fingerprint([role, subrole, title, label, identifier, bounds] as [Any])
    if !secure, let raw = attribute(element, kAXValueAttribute) {
        if let v = raw as? String { value["value"] = String(v.prefix(1000)) }
        else if let v = raw as? NSNumber { value["value"] = v }
    }
    return value
}

// Layout-only Electron groups can nest dozens of levels before a control. Keep
// their real child paths for stale-element validation, but not in the public tree.
func layoutOnly(_ node: [String: Any]) -> Bool {
    node["role"] as? String == "AXGroup" && ["", "AXApplicationGroup"].contains(node["subrole"] as? String ?? "") &&
        node["name"] as? String == "" && node["automationId"] as? String == "" &&
        ((node["value"] as? String) ?? "").isEmpty && node["protected"] as? Bool != true &&
        node["enabled"] as? Bool != false &&
        !(node["actions"] as? [String] ?? []).contains(kAXPressAction)
}

// The chain must first be verified to end at the approved window. Validate the
// whole ancestry before choosing an action, including protected/disabled parents.
func pressIndex(_ chain: [[String: Any]], at point: CGPoint) throws -> Int {
    try require(!chain.contains { $0["protected"] as? Bool == true || $0["enabled"] as? Bool == false },
                "protected_element", "The clicked control or its parent is protected or disabled.")
    for (index, node) in chain.enumerated() {
        if (node["actions"] as? [String] ?? []).contains(kAXPressAction),
           let data = node["bounds"] as? [String: Any], let rect = try? rectFrom(data), rect.contains(point) { return index }
    }
    throw ComputerError(code: "unsupported_action", message: "This point has no accessible press action. Observe again and use a supported element action or an approved foreground session.")
}

// Some AppKit hit tests return a containing view (Music's mini player, for
// example). Descend only that verified view, rejecting overlapping targets.
func descendantPress<Node>(_ root: Node, at point: CGPoint,
                           inspect: (Node) throws -> [String: Any], children: (Node) -> [Node]) throws -> Node? {
    var visited = 0
    let deadline = Date().addingTimeInterval(3)
    func visit(_ node: Node, depth: Int) throws -> Node? {
        visited += 1
        try require(visited <= 500 && depth <= 64 && Date() < deadline, "hit_test_failed", "Control hit test exceeded its bounds.")
        let data = try inspect(node)
        let bounds = (data["bounds"] as? [String: Any]).flatMap { try? rectFrom($0) }
        if let bounds, !bounds.contains(point) { return nil }
        try require(data["protected"] as? Bool != true && data["enabled"] as? Bool != false,
                    "protected_element", "The clicked control or its parent is protected or disabled.")
        var candidate: Node?
        for child in children(node) {
            if let found = try visit(child, depth: depth + 1) {
                try require(candidate == nil, "ambiguous_element", "Multiple overlapping controls match this point. Use an element ID.")
                candidate = found
            }
        }
        if let candidate { return candidate }
        return bounds?.contains(point) == true && (data["actions"] as? [String] ?? []).contains(kAXPressAction) ? node : nil
    }
    return try visit(root, depth: 0)
}

@MainActor
final class PointerProbeView: NSView {
    var received: CGPoint?
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { received = convert(event.locationInWindow, from: nil) }
}

// postToPid alone loses both the window association and window-local position.
// Fields 51/52 carry the AppKit window routing (51 is also emitted by
// NSEvent.mouseEvent); 91/92 alone do not route AppKit events. These fields and the local
// coordinate setter are not a stable API contract. Verify actual delivery to our own
// offscreen window before sending any pointer event to the approved application.
@MainActor
final class WindowPointer {
    typealias SetLocation = @convention(c) (CGEvent, CGPoint) -> Void
    let setLocation: SetLocation
    init() throws {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else {
            throw ComputerError(code: "background_pointer_unavailable", message: "This macOS version lacks background window coordinates. Use an accessible element or an approved foreground session.")
        }
        setLocation = unsafeBitCast(symbol, to: SetLocation.self)
        try probe()
    }
    func route(_ event: CGEvent, pid: Int32, window: Int64, bounds: CGRect) {
        event.flags = []
        event.setIntegerValueField(CGEventField(rawValue: 51)!, value: window)
        event.setIntegerValueField(CGEventField(rawValue: 52)!, value: window)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: window)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: window)
        setLocation(event, windowPoint(event.location, in: bounds))
        event.postToPid(pid)
    }
    private func probe() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.finishLaunching()
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 160, height: 120),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let view = PointerProbeView(frame: CGRect(x: 0, y: 0, width: 160, height: 120))
        window.contentView = view
        window.orderBack(nil)
        window.displayIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        defer { window.close() }
        let id = window.windowNumber
        guard let data = (CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(id)) as? [[String: Any]])?.first,
              let rectData = data[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: rectData) else {
            throw ComputerError(code: "background_pointer_unavailable", message: "Cannot check background pointer delivery on this macOS version.")
        }
        let expected = CGPoint(x: 43, y: 71)
        let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let cursor = CGEvent(source: nil)?.location
        for type: CGEventType in [.leftMouseDown, .leftMouseUp] {
            guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                                      mouseCursorPosition: CGPoint(x: bounds.minX + expected.x, y: bounds.minY + expected.y), mouseButton: .left) else {
                throw ComputerError(code: "input_failed", message: "Cannot create a pointer test event.")
            }
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            route(event, pid: getpid(), window: Int64(id), bounds: bounds)
        }
        let deadline = Date().addingTimeInterval(0.75)
        while view.received == nil && Date() < deadline {
            if let event = app.nextEvent(matching: .any, until: Date().addingTimeInterval(0.02), inMode: .default, dequeue: true) { app.sendEvent(event) }
        }
        try require(view.received.map { hypot($0.x - expected.x, $0.y - expected.y) < 1 } == true &&
                    foreground == NSWorkspace.shared.frontmostApplication?.processIdentifier && cursor == CGEvent(source: nil)?.location,
                    "background_pointer_unavailable", "Background pointer delivery failed its coordinate/focus check. No input was sent to the target app.")
    }
}

@MainActor
final class MacComputer {
    let request: [String: Any]
    let ownerPids: Set<Int32>
    init(_ request: [String: Any]) {
        self.request = request
        self.ownerPids = Set((request["ownerPids"] as? [Int] ?? []).compactMap { Int32(exactly: $0) })
    }
    func availableSession() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              (session[kCGSessionOnConsoleKey as String] as? Bool) == true else { return false }
        // This is a conservative session check, not a locked-use/unlock implementation.
        if (session["CGSSessionScreenIsLocked"] as? Bool) == true { return false }
        return NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.apple.loginwindow"
    }
    func checkSession() throws {
        try require(availableSession(), "session_locked", "Unlock the Mac locally. Locked use is not supported.")
    }
    func checkAccessibility() throws {
        try require(AXIsProcessTrusted(), "accessibility_permission", "Grant Accessibility permission to the native helper in macOS System Settings.")
    }
    func blocked(_ app: NSRunningApplication) -> Bool {
        let bundle = (app.bundleIdentifier ?? "").lowercased()
        let name = (app.localizedName ?? "").lowercased()
        let executable = app.executableURL?.lastPathComponent.lowercased() ?? ""
        let bundles: Set<String> = ["dev.codexlink.desktop", "dev.codexlink.computer", "com.openai.codex", "com.openai.chat", "com.apple.terminal", "com.googlecode.iterm2", "dev.warp.warp-stable", "net.kovidgoyal.kitty", "org.alacritty", "com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.securityagent", "com.apple.loginwindow"]
        let names: Set<String> = ["codex link", "codex-link-computer", "codex", "chatgpt", "terminal", "iterm2", "warp", "keychain access", "system settings", "securityagent", "loginwindow"]
        return ownerPids.contains(app.processIdentifier) || bundles.contains(bundle) || names.contains(name) || names.contains(executable)
    }
    func windows() -> [[String: Any]] {
        guard let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return [] }
        var result: [[String: Any]] = []
        for item in list {
            guard result.count < 256, (item[kCGWindowLayer as String] as? Int) == 0,
                  let pid = item[kCGWindowOwnerPID as String] as? Int32,
                  let id = item[kCGWindowNumber as String] as? UInt32,
                  let data = item[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: data as CFDictionary), bounds.width > 1, bounds.height > 1,
                  let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
                  let executable = app.executableURL?.resolvingSymlinksInPath().path,
                  let launched = app.launchDate else { continue }
            let appId = app.bundleIdentifier ?? "path:\(executable)"
            let denied = blocked(app)
            result.append(["windowId": String(id), "pid": Int(pid), "processStart": String(format: "%.6f", launched.timeIntervalSince1970),
                "appId": appId, "appName": app.localizedName ?? appId, "executable": executable,
                "title": String(((item[kCGWindowName as String] as? String) ?? "").prefix(1000)),
                "bounds": rectJSON(bounds), "onscreen": (item[kCGWindowIsOnscreen as String] as? Bool) ?? false,
                "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                "blocked": denied, "blockReason": denied ? "Control panels, terminals, credential/security interfaces and the controlling agent are not computer-use targets." : ""])
        }
        return result
    }
    func describe(_ id: String) throws -> [String: Any] {
        guard let target = windows().first(where: { $0["windowId"] as? String == id }) else {
            throw ComputerError(code: "window_missing", message: "The window no longer exists or its process identity cannot be verified.")
        }
        return target
    }
    func verify(_ expected: [String: Any]) throws -> [String: Any] {
        let current = try describe(string(expected, "windowId", 128))
        for key in ["appId", "executable", "windowId", "processStart"] {
            try require((current[key] as? String) == (expected[key] as? String), "target_changed", "The approved application or window changed.")
        }
        try require((current["pid"] as? Int) == (expected["pid"] as? Int), "target_changed", "The application process changed.")
        try require(current["blocked"] as? Bool != true, "blocked_app", "This application cannot be automated.")
        return current
    }
    func root(_ target: [String: Any]) throws -> AXUIElement {
        try checkAccessibility()
        let pid = Int32(try boundedInt(target, "pid", 0, 1, Int(Int32.max)))
        let app = AXUIElementCreateApplication(pid)
        _ = AXUIElementSetMessagingTimeout(app, 0.5)
        guard let candidates = attribute(app, kAXWindowsAttribute) as? [AXUIElement],
              let boundsData = target["bounds"] as? [String: Any] else {
            throw ComputerError(code: "accessibility_unavailable", message: "The app does not expose accessible windows.")
        }
        let bounds = try rectFrom(boundsData)
        let matches = candidates.filter { candidate in axRect(candidate).map { closeRect($0, bounds) } ?? false }
        // Public Accessibility has no universal CGWindowID mapping. Never guess between equal rectangles.
        try require(matches.count == 1, "ambiguous_accessibility_window", "Cannot uniquely match the native window to an accessibility window.")
        _ = AXUIElementSetMessagingTimeout(matches[0], 0.5)
        // Electron's documented switch is debounced for two seconds on modern
        // macOS. Exiting after a short sleep can cancel activation entirely.
        // Avoid resetting its timer when this window already exposes web content.
        if !hasWebContent(matches[0]), (attribute(app, "AXManualAccessibility") as? Bool) != nil,
           AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
            let deadline = Date().addingTimeInterval(3)
            // A partial native tree can appear before the complete mode's timer
            // fires. Do not return early and race the first control action.
            usleep(2100000)
            while Date() < deadline && !hasWebContent(matches[0]) { usleep(100000) }
        }
        return matches[0]
    }
    func hasWebContent(_ root: AXUIElement) -> Bool {
        var pending = [root], visited = 0
        while !pending.isEmpty && visited < 64 {
            let element = pending.removeFirst(); visited += 1
            let descendants = children(element)
            if axString(element, kAXRoleAttribute) == "AXWebArea" && !descendants.isEmpty { return true }
            pending.append(contentsOf: descendants.prefix(max(0, 64 - visited - pending.count)))
        }
        return false
    }
    func tree(_ root: AXUIElement, maxNodes: Int, maxDepth: Int) -> ([[String: Any]], Bool) {
        var output: [[String: Any]] = []
        var seen = Set<CFHashCode>()
        var truncated = false
        let deadline = Date().addingTimeInterval(5)
        let viewport = axRect(root)
        func visit(_ element: AXUIElement, _ path: [Int], _ depth: Int) {
            if output.count >= maxNodes || Date() > deadline { truncated = true; return }
            if seen.contains(CFHash(element)) { return }
            seen.insert(CFHash(element))
            var node = descriptor(element)
            let layout = !path.isEmpty && layoutOnly(node)
            // Chromium clips scrolled-out rows to zero-area bounds. Excluding
            // those subtrees prevents a long sidebar from exhausting maxNodes.
            // Empty layout wrappers may still contain absolutely positioned UI.
            if !path.isEmpty, let bounds = axRect(element), let viewport,
               (!layout && bounds.isEmpty) || (!bounds.isEmpty && !bounds.intersects(viewport)) { return }
            if !layout {
                node["id"] = "e\(output.count)"; node["path"] = path
                output.append(node)
            }
            if protectedElement(element) { return }
            let nextDepth = depth + (layout ? 0 : 1)
            if path.count >= 64 || nextDepth > maxDepth { if !children(element).isEmpty { truncated = true }; return }
            for (i, child) in children(element).enumerated() {
                if output.count >= maxNodes || Date() > deadline { truncated = true; break }
                visit(child, path + [i], nextDepth)
            }
        }
        visit(root, [], 0)
        return (output, truncated)
    }
    func resolve(_ root: AXUIElement, _ reference: [String: Any]) throws -> AXUIElement {
        guard let path = reference["path"] as? [Int], path.count <= 64 else { throw ComputerError(code: "invalid_element", message: "Invalid element path.") }
        var element = root
        for index in path {
            try require(!protectedElement(element), "protected_element", "Protected content is not an automation target.")
            let next = children(element)
            try require(index >= 0 && index < next.count, "stale_element", "Accessibility element changed; observe again.")
            element = next[index]
        }
        let current = descriptor(element)
        try require((current["fingerprint"] as? String) == (reference["fingerprint"] as? String), "stale_element", "Accessibility element changed; observe again.")
        try require(!protectedElement(element) && (current["enabled"] as? Bool) != false, "protected_element", "Element is protected or disabled.")
        return element
    }
    func hitChain(_ point: CGPoint, root: AXUIElement, pid: Int32) throws -> [AXUIElement] {
        // Application-scoped hit testing works even when another app covers the
        // window. System-wide hit testing would pick that foreground app instead.
        var hit: AXUIElement?
        try require(AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(point.x), Float(point.y), &hit) == .success && hit != nil,
                    "hit_test_failed", "The approved app could not identify a control at this point.")
        var chain: [AXUIElement] = [], cursor = hit
        while let element = cursor, chain.count < 64 {
            var owner: pid_t = 0
            try require(AXUIElementGetPid(element, &owner) == .success && owner == pid,
                        "off_target_element", "The clicked control belongs to another application.")
            chain.append(element)
            if CFEqual(element, root) { break }
            cursor = axElement(attribute(element, kAXParentAttribute))
        }
        try require(chain.last.map { CFEqual($0, root) } == true,
                    "off_target_element", "Cannot verify that the clicked control belongs to the approved window.")
        let ancestry = chain.map(descriptor)
        try require(!ancestry.contains { $0["protected"] as? Bool == true || $0["enabled"] as? Bool == false },
                    "protected_element", "The clicked control or its parent is protected or disabled.")
        return chain
    }
    func pressAt(_ point: CGPoint, root: AXUIElement, pid: Int32) throws -> Bool {
        let chain = try hitChain(point, root: root, pid: pid)
        let ancestry = chain.map(descriptor)
        let descendant = try descendantPress(chain[0], at: point, inspect: { element in
            var owner: pid_t = 0
            try require(AXUIElementGetPid(element, &owner) == .success && owner == pid, "off_target_element", "Control belongs to another application.")
            return descriptor(element)
        }, children: children)
        let element: AXUIElement
        if let descendant { element = descendant }
        else {
            do { element = chain[try pressIndex(ancestry, at: point)] }
            catch let error as ComputerError where error.code == "unsupported_action" { return false }
        }
        try require(AXUIElementPerformAction(element, kAXPressAction as CFString) == .success,
                    "unsupported_action", "The application rejected this control's press action. No mouse-event fallback was attempted.")
        return true
    }
    func capture(_ target: [String: Any], side: Int) async throws -> ([String: Any], Data) {
        try require(CGPreflightScreenCaptureAccess(), "screen_capture_permission", "Grant Screen Recording permission to the native helper in macOS System Settings.")
        let id = UInt32(try string(target, "windowId"))!
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == id }) else {
            throw ComputerError(code: "capture_unavailable", message: "ScreenCaptureKit cannot capture this window. Restore it locally and try again.")
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let bounds = try rectFrom(target["bounds"] as! [String: Any])
        let scale = min(1.0, Double(side) / max(bounds.width, bounds.height))
        let config = SCStreamConfiguration()
        config.width = max(1, Int((bounds.width * scale).rounded()))
        config.height = max(1, Int((bounds.height * scale).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.scalesToFit = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ComputerError(code: "capture_encoding", message: "Cannot encode window screenshot.")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
        try require(CGImageDestinationFinalize(destination), "capture_encoding", "Cannot finish screenshot encoding.")
        try require(data.length <= 5 * 1024 * 1024, "capture_too_large", "Screenshot exceeds the output limit; reduce maxImageSide.")
        var frame = rectJSON(bounds); frame["imageWidth"] = image.width; frame["imageHeight"] = image.height
        return (frame, data as Data)
    }
    func cornerFailsafe() throws {
        guard let location = CGEvent(source: nil)?.location else { return }
        var displays = [CGDirectDisplayID](repeating: 0, count: 32), count: UInt32 = 0
        guard CGGetActiveDisplayList(32, &displays, &count) == .success else { return }
        for display in displays.prefix(Int(count)) {
            let rect = CGDisplayBounds(display)
            let nearX = abs(location.x - rect.minX) <= 2 || abs(location.x - (rect.maxX - 1)) <= 2
            let nearY = abs(location.y - rect.minY) <= 2 || abs(location.y - (rect.maxY - 1)) <= 2
            try require(!(nearX && nearY), "failsafe", "Mouse-corner fail-safe triggered. Move the pointer away from the corner locally.")
        }
    }
    func post(_ event: CGEvent, _ pid: Int32, _ mode: String) {
        if mode == "background" { event.postToPid(pid) }
        else { event.post(tap: .cghidEventTap) }
    }
    func checkFocus(_ target: [String: Any], _ root: AXUIElement, _ mode: String) throws {
        let pid = Int32(target["pid"] as! Int)
        let app = AXUIElementCreateApplication(pid)
        if mode == "foreground" {
            try require(NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, "focus_changed", "Target is not foreground. Use focus in an approved foreground session, then observe again.")
        }
        guard let focused = axElement(attribute(app, kAXFocusedWindowAttribute)), CFEqual(focused, root) else {
            throw ComputerError(code: "focus_changed", message: "The target app's focused window differs from the approved window.")
        }
        if let field = axElement(attribute(app, kAXFocusedUIElementAttribute)) {
            try require(!protectedElement(field), "protected_element", "Typing into protected fields is not supported.")
        }
        try checkHumanInput()
    }
    func checkHumanInput() throws {
        for key: CGKeyCode in [54, 55, 56, 58, 59, 60, 61, 62] {
            try require(!CGEventSource.keyState(.hidSystemState, key: key), "human_input", "A keyboard modifier is held. Input has not been sent.")
        }
        for button: CGMouseButton in [.left, .right, .center] {
            try require(!CGEventSource.buttonState(.hidSystemState, button: button), "human_input", "A mouse button is held. Input has not been sent.")
        }
        try require(!IsSecureEventInputEnabled(), "secure_input", "Secure keyboard entry is active. Complete sensitive input locally.")
    }
    func point(_ nameX: String, _ nameY: String, _ bounds: CGRect) throws -> CGPoint {
        let p = CGPoint(x: try number(request, nameX), y: try number(request, nameY))
        try require(bounds.contains(p), "outside_window", "Input coordinates are outside the approved window.")
        return p
    }
    func interact(_ target: [String: Any]) throws -> [String: Any] {
        try checkAccessibility(); try cornerFailsafe()
        let action = try string(request, "action", 32), mode = try string(request, "mode", 16)
        try require(["background", "foreground"].contains(mode), "invalid_mode", "Invalid input mode.")
        let bounds = try rectFrom(target["bounds"] as! [String: Any])
        guard let frame = request["frame"] as? [String: Any] else { throw ComputerError(code: "stale_frame", message: "Observe before acting.") }
        try require(closeRect(bounds, try rectFrom(frame)), "stale_frame", "Window moved or resized; observe again.")
        let root = try self.root(target), pid = Int32(target["pid"] as! Int)
        let oldForeground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var inputMethod = "quartz"
        if let reference = request["element"] as? [String: Any] {
            inputMethod = "accessibility"
            let element = try resolve(root, reference)
            let status: AXError
            switch action {
            case "invoke", "toggle": status = AXUIElementPerformAction(element, kAXPressAction as CFString)
            case "set_value":
                let value = request["text"] as? String ?? ""
                try require(value.utf16.count <= 20000 && !value.contains("\0"), "invalid_text", "Invalid text.")
                var settable = DarwinBoolean(false)
                try require(AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue, "unsupported_action", "The element does not support setting its value.")
                status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
            case "select": status = AXUIElementSetAttributeValue(element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
            case "expand", "collapse": status = AXUIElementSetAttributeValue(element, kAXExpandedAttribute as CFString, action == "expand" ? kCFBooleanTrue : kCFBooleanFalse)
            default: throw ComputerError(code: "unsupported_action", message: "Unsupported semantic action.")
            }
            try require(status == .success, "unsupported_action", "Application rejected the accessibility action (\(status.rawValue)). No pixel fallback was attempted.")
        } else if action == "focus" {
            inputMethod = "accessibility"
            try require(mode == "foreground", "foreground_required", "Focus requires foreground approval.")
            guard let app = NSRunningApplication(processIdentifier: pid) else { throw ComputerError(code: "window_missing", message: "Application exited.") }
            try require(app.activate(options: []), "focus_failed", "The application could not be activated.")
            try require(AXUIElementPerformAction(root, kAXRaiseAction as CFString) == .success, "focus_failed", "The window could not be raised.")
            // Activation is asynchronous, and NSWorkspace caches its foreground
            // application until the run loop processes the notification.
            let deadline = Date().addingTimeInterval(2)
            repeat {
                RunLoop.current.run(until: Date().addingTimeInterval(0.02))
                try checkSession(); try cornerFailsafe()
            } while !app.isActive && Date() < deadline
            try checkFocus(target, root, mode)
        } else if action == "key" || action == "type" {
            try checkFocus(target, root, mode)
            if action == "type" {
                guard let value = request["text"] as? String, value.utf16.count <= 20000, !value.contains("\0") else { throw ComputerError(code: "invalid_text", message: "Invalid text.") }
                // Unicode key events preserve the system clipboard, including non-text formats.
                var typed = 0
                for character in value {
                    if typed % 32 == 0 { try checkSession(); try cornerFailsafe(); try checkFocus(target, root, mode) }; typed += 1
                    let units = Array(String(character).utf16)
                    for down in [true, false] {
                        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { throw ComputerError(code: "input_failed", message: "Cannot create a keyboard event.") }
                        event.flags = []
                        units.withUnsafeBufferPointer { buffer in event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!) }
                        post(event, pid, mode)
                    }
                }
            } else {
                let chord = try keyChord(request["keys"] as? [String] ?? [])
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: chord.0, keyDown: down) else { throw ComputerError(code: "input_failed", message: "Cannot create a keyboard event.") }
                    event.flags = chord.1; post(event, pid, mode)
                }
            }
        } else {
            let location = try point("x", "y", bounds)
            let buttonName = request["button"] as? String ?? "left"
            try require(["left", "right", "middle"].contains(buttonName), "invalid_button", "Invalid mouse button.")
            let accessibleClick = mode == "background" && action == "click" && buttonName == "left"
            // Window-routed pointer input does not require keyboard focus. A
            // newly opened inactive window may have no app-focused window.
            if mode == "background" { try checkHumanInput(); _ = try hitChain(location, root: root, pid: pid) }
            else { try checkFocus(target, root, mode) }
            if mode == "foreground" {
                try checkFocus(target, root, mode)
                var hit: AXUIElement?
                if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(location.x), Float(location.y), &hit) == .success, let hit {
                    var hitPid: pid_t = 0; _ = AXUIElementGetPid(hit, &hitPid)
                    try require(hitPid == pid, "occluded_window", "Another app covers this point. No input was sent.")
                    try require(!protectedElement(hit), "protected_element", "Protected fields are not input targets.")
                } else { throw ComputerError(code: "hit_test_failed", message: "Cannot verify the app at this point.") }
            }
            var pointer: WindowPointer?
            var pressed = false
            func recheckPointerTarget() throws {
                try checkSession(); try cornerFailsafe(); try checkHumanInput()
                let current = try verify(target)
                try require(closeRect(bounds, try rectFrom(current["bounds"] as! [String: Any])),
                            "stale_frame", "Window moved or resized during input preparation; observe again.")
            }
            if accessibleClick {
                try recheckPointerTarget()
                // A successful self-probe does not prove another application
                // accepts inactive-window mouse events. In particular Chromium
                // drops plain background clicks. Use its actual control action
                // before attempting raw events, and never replay a press.
                pressed = try pressAt(location, root: root, pid: pid)
            }
            if mode == "background" && !pressed {
                let app = AXUIElementCreateApplication(pid)
                try require(NSRunningApplication(processIdentifier: pid)?.isActive == true ||
                            attribute(app, "AXManualAccessibility") == nil,
                            "foreground_required", "This inactive app does not reliably accept unmodified pointer events. Use an accessible control, or start a foreground session, focus the window, and observe again. No input was sent.")
                pointer = try WindowPointer()
            }
            if pressed {
                inputMethod = "accessibility"
            } else {
                try recheckPointerTarget()
                if pointer != nil { inputMethod = "window-quartz" }
                let windowID = Int64(try string(target, "windowId"))!
                func sendPointer(_ event: CGEvent) {
                    if let pointer { pointer.route(event, pid: pid, window: windowID, bounds: bounds) }
                    else { post(event, pid, mode) }
                }
                let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
                let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
                let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
                let dragged: CGEventType = button == .right ? .rightMouseDragged : button == .center ? .otherMouseDragged : .leftMouseDragged
                func mouse(_ type: CGEventType, _ at: CGPoint, _ count: Int64 = 1) throws {
                    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: button) else { throw ComputerError(code: "input_failed", message: "Cannot create mouse event.") }
                    event.setIntegerValueField(.mouseEventClickState, value: count)
                    sendPointer(event)
                    usleep(10000)
                }
                switch action {
                case "move": try mouse(.mouseMoved, location)
                case "click", "double_click":
                    for count in 1...(action == "double_click" ? 2 : 1) { try mouse(down, location, Int64(count)); try mouse(up, location, Int64(count)) }
                case "drag":
                    let destination = try point("toX", "toY", bounds)
                    if mode == "background" { _ = try hitChain(destination, root: root, pid: pid) }
                    try mouse(down, location)
                    defer { try? mouse(up, destination) }
                    for step in 1...12 { let f = Double(step) / 12; try mouse(dragged, CGPoint(x: location.x + (destination.x - location.x) * f, y: location.y + (destination.y - location.y) * f)) }
                case "scroll":
                    let amount = try boundedInt(request, "amount", 0, -30, 30)
                    let horizontal = request["horizontal"] as? Bool ?? false
                    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: horizontal ? 0 : Int32(amount), wheel2: horizontal ? Int32(amount) : 0, wheel3: 0) else { throw ComputerError(code: "input_failed", message: "Cannot create scroll event.") }
                    event.location = location; sendPointer(event)
                default: throw ComputerError(code: "unsupported_action", message: "Unsupported action.")
                }
            }
        }
        // Sleeping leaves NSWorkspace's activation cache stale. Process its
        // notifications before reporting focus changes to the session owner.
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        return ["protocol": 1, "ok": true, "action": action, "delivery": mode,
            "inputMethod": inputMethod,
            "foregroundChanged": oldForeground != NSWorkspace.shared.frontmostApplication?.processIdentifier,
            "verificationRequired": true]
    }
    func run() async throws -> [String: Any] {
        try require((request["protocol"] as? Int) == 1, "protocol_mismatch", "Expected native protocol 1.")
        let op = try string(request, "op", 32)
        if op == "request_permissions" {
            try checkSession()
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let accessibility = AXIsProcessTrustedWithOptions(options)
            let capture = CGRequestScreenCaptureAccess()
            return ["protocol": 1, "accessibility": accessibility, "screenCapture": capture,
                "message": "Complete any macOS prompts locally. The helper cannot grant its own permissions. Recheck diagnostics afterwards."]
        }
        if op == "status" {
            return ["protocol": 1, "platform": "darwin", "backend": "ScreenCaptureKit/Accessibility/Quartz",
                "permissions": ["screenCapture": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "sessionAvailable": availableSession()],
                "capabilities": ["windowCapture": true, "accessibilityTree": true, "semanticActions": true, "unicodeInput": true,
                    "backgroundPixelInput": "left clicks prefer AXPress; raw window-routed pointer input is app-dependent; inactive Chromium apps require foreground mode for raw pointer events; verify results in each app", "foregroundInput": true,
                    "lockedUse": false, "clipboardModified": false, "multipleDisplays": true],
                "minimumOS": "macOS 14"]
        }
        try checkSession()
        if op == "windows" { return ["protocol": 1, "windows": windows()] }
        if op == "describe" { return ["protocol": 1, "target": try describe(string(request, "windowId", 128))] }
        guard let expected = request["target"] as? [String: Any] else { throw ComputerError(code: "invalid_target", message: "Missing target identity.") }
        let target = try verify(expected)
        if op == "interact" { return try interact(target) }
        try require(op == "observe", "unknown_operation", "Unknown native operation.")
        let includeImage = request["includeImage"] as? Bool ?? true, includeTree = request["includeTree"] as? Bool ?? true
        let maxNodes = try boundedInt(request, "maxNodes", 250, 1, 500), maxDepth = try boundedInt(request, "maxDepth", 8, 1, 12)
        let side = try boundedInt(request, "maxImageSide", 1800, 320, 2560)
        var result: [String: Any] = ["protocol": 1, "target": target, "elements": [[String: Any]](), "treeTruncated": false]
        var frame = target["bounds"] as! [String: Any]; frame["imageWidth"] = 0; frame["imageHeight"] = 0
        if includeImage {
            let capture = try await self.capture(target, side: side)
            frame = capture.0; result["data"] = capture.1.base64EncodedString(); result["mimeType"] = "image/jpeg"
            result["captureMethod"] = "ScreenCaptureKit desktop-independent window"
        }
        if includeTree {
            let context = try tree(root(target), maxNodes: maxNodes, maxDepth: maxDepth)
            result["elements"] = context.0; result["treeTruncated"] = context.1
        }
        let after = try verify(target)
        try require(closeRect(try rectFrom(after["bounds"] as! [String: Any]), try rectFrom(frame)), "window_changed", "Window changed during capture; observe again.")
        result["frame"] = frame
        return result
    }
}

func keyChord(_ input: [String]) throws -> (CGKeyCode, CGEventFlags) {
    try require(!input.isEmpty && input.count <= 5, "invalid_keys", "Provide one to five keys.")
    var flags: CGEventFlags = [], ordinary: [String] = []
    for key in input.map({ $0.lowercased() }) {
        switch key {
        case "command", "cmd", "meta": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        default: ordinary.append(key)
        }
    }
    let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"equal":24,"9":25,"7":26,"minus":27,"8":28,"0":29,"rightbracket":30,"o":31,"u":32,"leftbracket":33,"i":34,"p":35,"enter":36,"return":36,"l":37,"j":38,"quote":39,"k":40,"semicolon":41,"backslash":42,"comma":43,"slash":44,"n":45,"m":46,"period":47,"tab":48,"space":49,"backquote":50,"backspace":51,"escape":53,"esc":53,"f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111,"home":115,"end":119,"pageup":116,"pagedown":121,"delete":117,"left":123,"right":124,"down":125,"up":126]
    try require(ordinary.count == 1, "invalid_keys", "Use one non-modifier key per chord.")
    guard let code = codes[ordinary[0]] else { throw ComputerError(code: "invalid_keys", message: "Unsupported key name. Use type for Unicode text.") }
    return (code, flags)
}

@main
struct Entry {
    @MainActor static func main() async {
        do {
            if CommandLine.arguments.dropFirst() == ["--self-test"] {
                try require(closeRect(CGRect(x: -500, y: 0, width: 100, height: 100), CGRect(x: -500, y: 0, width: 100, height: 100)), "self_test", "Geometry test failed")
                _ = try keyChord(["command", "shift", "a"])
                do { _ = try keyChord(["a", "b"]); throw ComputerError(code: "self_test", message: "Bad chord accepted") }
                catch let error as ComputerError { if error.code == "self_test" { throw error } }
                let textNode: [String: Any] = ["actions": [], "protected": false, "enabled": true]
                let linkNode: [String: Any] = ["actions": [kAXPressAction], "protected": false, "enabled": true,
                    "bounds": rectJSON(CGRect(x: -500, y: 100, width: 100, height: 40))]
                let clickPoint = CGPoint(x: -450, y: 120)
                try require(windowPoint(clickPoint, in: CGRect(x: -500, y: 100, width: 100, height: 40)) == CGPoint(x: 50, y: 20),
                            "self_test", "Window-local pointer coordinates failed with a negative display origin")
                let chosen = try pressIndex([textNode, linkNode, textNode], at: clickPoint)
                try require(chosen == 1, "self_test", "Click did not resolve text to its enclosing link")
                for (chain, point, expectedCode) in [
                    ([linkNode, ["protected": true]], clickPoint, "protected_element"),
                    ([linkNode, ["enabled": false]], clickPoint, "protected_element"),
                    ([textNode], clickPoint, "unsupported_action"),
                    ([linkNode], CGPoint(x: 50, y: 50), "unsupported_action")
                ] {
                    do { _ = try pressIndex(chain, at: point); throw ComputerError(code: "self_test", message: "Unsafe/unsupported click accepted") }
                    catch let error as ComputerError { try require(error.code == expectedCode, "self_test", "Wrong click rejection") }
                }
                let descendants: [[String: Any]] = [textNode, textNode, linkNode, linkNode]
                func findPress(_ edges: [Int: [Int]], _ nodes: [[String: Any]] = descendants) throws -> Int? {
                    try descendantPress(0, at: clickPoint, inspect: { nodes[$0] }, children: { edges[$0] ?? [] })
                }
                try require(try findPress([0: [1], 1: [2]]) == 2, "self_test", "Container hit did not resolve its nested button")
                try require(try findPress([0: [1]]) == nil, "self_test", "A layout-only hit incorrectly became pressable")
                for (edges, nodes, expectedCode) in [
                    ([0: [2, 3]], descendants, "ambiguous_element"),
                    ([0: [1], 1: [2]], [textNode, ["protected": true], linkNode, linkNode], "protected_element")
                ] {
                    do { _ = try findPress(edges, nodes); throw ComputerError(code: "self_test", message: "Unsafe descendant click accepted") }
                    catch let error as ComputerError { try require(error.code == expectedCode, "self_test", "Wrong descendant click rejection") }
                }
                let group: [String: Any] = ["role": "AXGroup", "subrole": "", "name": "", "automationId": "", "actions": ["AXShowMenu", "AXScrollToVisible"]]
                try require(layoutOnly(group) && !layoutOnly(group.merging(["actions": [kAXPressAction]]) { _, new in new }) &&
                            !layoutOnly(group.merging(["protected": true]) { _, new in new }), "self_test", "Interactive/protected group omitted")
                try require(layoutOnly(group.merging(["subrole": "AXApplicationGroup"]) { _, new in new }) &&
                            !layoutOnly(group.merging(["subrole": "AXLandmarkNavigation"]) { _, new in new }), "self_test", "Layout and landmark groups confused")
                FileHandle.standardOutput.write(try json(["protocol": 1, "ok": true, "selfTest": true])); return
            }
            try require(CommandLine.arguments.count == 1, "invalid_request", "No command-line arguments are accepted.")
            var data = Data()
            while data.count <= 131072 {
                let chunk = try FileHandle.standardInput.read(upToCount: min(8192, 131073 - data.count)) ?? Data()
                if chunk.isEmpty { break }; data.append(chunk)
            }
            try require(data.count <= 131072, "request_too_large", "Request exceeds 128 KiB.")
            guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ComputerError(code: "invalid_request", message: "Expected a JSON object.") }
            let result = try await MacComputer(request).run()
            FileHandle.standardOutput.write(try json(result))
        } catch {
            let native = error as? ComputerError
            let result: [String: Any] = ["protocol": 1, "error": ["code": native?.code ?? "native_error", "message": native?.message ?? error.localizedDescription]]
            if let data = try? json(result) { FileHandle.standardOutput.write(data) }
            exit(1)
        }
    }
}
