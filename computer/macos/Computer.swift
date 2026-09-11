import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
import Carbon

// One bounded request per process. No listener, shell evaluation, permission changes,
// clipboard access or private event-injection APIs. Permission prompts are owner-only.
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
        return matches[0]
    }
    func tree(_ root: AXUIElement, maxNodes: Int, maxDepth: Int) -> ([[String: Any]], Bool) {
        var output: [[String: Any]] = []
        var seen = Set<CFHashCode>()
        var truncated = false
        let deadline = Date().addingTimeInterval(3)
        func visit(_ element: AXUIElement, _ path: [Int]) {
            if output.count >= maxNodes || Date() > deadline { truncated = true; return }
            if seen.contains(CFHash(element)) { return }
            seen.insert(CFHash(element))
            var node = descriptor(element)
            node["id"] = "e\(output.count)"; node["path"] = path
            output.append(node)
            if protectedElement(element) { return }
            if path.count >= maxDepth { if !children(element).isEmpty { truncated = true }; return }
            for (i, child) in children(element).enumerated() {
                if output.count >= maxNodes || Date() > deadline { truncated = true; break }
                visit(child, path + [i])
            }
        }
        visit(root, [])
        return (output, truncated)
    }
    func resolve(_ root: AXUIElement, _ reference: [String: Any]) throws -> AXUIElement {
        guard let path = reference["path"] as? [Int], path.count <= 12 else { throw ComputerError(code: "invalid_element", message: "Invalid element path.") }
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
        if let reference = request["element"] as? [String: Any] {
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
            try require(mode == "foreground", "foreground_required", "Focus requires foreground approval.")
            guard let app = NSRunningApplication(processIdentifier: pid) else { throw ComputerError(code: "window_missing", message: "Application exited.") }
            try require(app.activate(options: []), "focus_failed", "The application could not be activated.")
            try require(AXUIElementPerformAction(root, kAXRaiseAction as CFString) == .success, "focus_failed", "The window could not be raised.")
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
            try checkFocus(target, root, mode)
            if mode == "foreground" {
                try checkFocus(target, root, mode)
                var hit: AXUIElement?
                if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(location.x), Float(location.y), &hit) == .success, let hit {
                    var hitPid: pid_t = 0; _ = AXUIElementGetPid(hit, &hitPid)
                    try require(hitPid == pid, "occluded_window", "Another app covers this point. No input was sent.")
                    try require(!protectedElement(hit), "protected_element", "Protected fields are not input targets.")
                } else { throw ComputerError(code: "hit_test_failed", message: "Cannot verify the app at this point.") }
            }
            let buttonName = request["button"] as? String ?? "left"
            try require(["left", "right", "middle"].contains(buttonName), "invalid_button", "Invalid mouse button.")
            let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
            let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
            let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
            let dragged: CGEventType = button == .right ? .rightMouseDragged : button == .center ? .otherMouseDragged : .leftMouseDragged
            func mouse(_ type: CGEventType, _ at: CGPoint, _ count: Int64 = 1) throws {
                guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: button) else { throw ComputerError(code: "input_failed", message: "Cannot create mouse event.") }
                event.setIntegerValueField(.mouseEventClickState, value: count)
                post(event, pid, mode)
            }
            switch action {
            case "move": try mouse(.mouseMoved, location)
            case "click", "double_click":
                for count in 1...(action == "double_click" ? 2 : 1) { try mouse(down, location, Int64(count)); try mouse(up, location, Int64(count)) }
            case "drag":
                try require(mode == "foreground", "foreground_required", "Dragging requires foreground approval.")
                let destination = try point("toX", "toY", bounds)
                try mouse(down, location)
                defer { try? mouse(up, destination) }
                for step in 1...12 { let f = Double(step) / 12; try mouse(dragged, CGPoint(x: location.x + (destination.x - location.x) * f, y: location.y + (destination.y - location.y) * f)) }
            case "scroll":
                let amount = try boundedInt(request, "amount", 0, -30, 30)
                let horizontal = request["horizontal"] as? Bool ?? false
                guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: horizontal ? 0 : Int32(amount), wheel2: horizontal ? Int32(amount) : 0, wheel3: 0) else { throw ComputerError(code: "input_failed", message: "Cannot create scroll event.") }
                event.location = location; post(event, pid, mode)
            default: throw ComputerError(code: "unsupported_action", message: "Unsupported action.")
            }
        }
        usleep(100000) // Allow the app to process input before checking for focus changes.
        return ["protocol": 1, "ok": true, "action": action, "delivery": mode,
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
                    "backgroundPixelInput": "app-dependent CGEvent.postToPid; not an independent system cursor", "foregroundInput": true,
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
