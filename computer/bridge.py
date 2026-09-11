#!/usr/bin/env python3
"""One bounded desktop action per invocation. No network listeners or eval.
Requires a logged-in graphical session and OS screen/accessibility permissions.
Coordinates are PRIMARY DISPLAY logical coordinates reported by PyAutoGUI.
"""
import base64
import io
import json
import sys
import time


def main():
    import pyautogui as gui
    gui.FAILSAFE = True
    gui.PAUSE = 0.12
    raw = sys.stdin.buffer.read(131073)
    if len(raw) > 131072:
        raise ValueError("Desktop request exceeds 128 KiB")
    request = json.loads(raw)
    if not isinstance(request, dict):
        raise ValueError("Desktop request must be an object")
    action = request.get("action")
    width, height = gui.size()
    if action == "status":
        print(json.dumps({"width": width, "height": height, "failSafe": True, "display": "primary"}))
        return
    if action == "screenshot":
        from PIL import Image
        image = gui.screenshot()
        native_width, native_height = image.size
        # Retina captures can be twice the input coordinate dimensions. Normalize
        # the output image so a model's pixel coordinates are input coordinates.
        if image.size != (width, height):
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="JPEG", quality=85)
        print(json.dumps({"mimeType": "image/jpeg", "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
                          "width": width, "height": height, "nativeWidth": native_width, "nativeHeight": native_height,
                          "coordinateSpace": "primary-display-logical", "origin": [0, 0]}))
        return
    if action in ("move", "click", "double_click", "drag"):
        x, y = request.get("x"), request.get("y")
        if not isinstance(x, int) or not isinstance(y, int) or not (0 <= x < width and 0 <= y < height):
            raise ValueError("Coordinates are outside the primary display")
        button = request.get("button", "left")
        if button not in ("left", "right", "middle"):
            raise ValueError("Invalid mouse button")
        if action == "move":
            gui.moveTo(x, y, duration=0.2)
        elif action == "drag":
            gui.dragTo(x, y, duration=0.5, button=button)
        else:
            gui.click(x, y, clicks=2 if action == "double_click" else 1, interval=0.12, button=button)
    elif action == "type":
        # Clipboard paste supports Unicode; the prior text clipboard is restored.
        import pyperclip
        text = request.get("text", "")
        if not isinstance(text, str) or len(text) > 20000:
            raise ValueError("Text exceeds 20000 characters")
        previous = pyperclip.paste()
        try:
            pyperclip.copy(text)
            gui.hotkey("command" if sys.platform == "darwin" else "ctrl", "v")
            time.sleep(0.3)
        finally:
            pyperclip.copy(previous)
    elif action == "key":
        keys = request.get("keys", [])
        if not keys or len(keys) > 5 or any(key not in gui.KEYBOARD_KEYS for key in keys):
            raise ValueError("Invalid key combination")
        gui.hotkey(*keys)
    elif action == "scroll":
        amount = request.get("amount", 0)
        if not isinstance(amount, int) or not (-30 <= amount <= 30):
            raise ValueError("Scroll amount must be between -30 and 30")
        gui.scroll(amount)
    else:
        raise ValueError("Unknown desktop action")
    print(json.dumps({"ok": True, "action": action, "width": width, "height": height}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error), "hint": "Check graphical session, screen/accessibility permissions and the mouse-corner fail-safe."}))
        sys.exit(1)
