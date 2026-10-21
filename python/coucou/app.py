"""The app's shared state (lib.rs `Shared`) and what the host window system must provide."""

from __future__ import annotations

import threading
from typing import Any

from . import VERSION, settings
from .registry import EventBus


class Host:
    """What only the window system can do. The Qt host overrides these; the defaults do
    nothing, so the backend runs (and is tested) without any window."""

    def screen_info(self, screen_pref: str) -> dict[str, float]:
        return {"x": 0.0, "y": 0.0, "width": 1920.0, "height": 1080.0, "scale": 1.0}

    def apply_geometry(self, screen_pref: str, collapsed: bool) -> None: ...

    def refresh_click_through(self) -> None: ...

    def set_taskbar_visible(self, visible: bool) -> None: ...

    def set_autostart(self, enabled: bool) -> None: ...

    def refresh_tray(self) -> None: ...

    def quit(self) -> None: ...


class App:
    def __init__(self, host: Host | None = None) -> None:
        self.host = host or Host()
        self.events = EventBus()
        self.version = VERSION
        self.settings_lock = threading.Lock()
        self.settings: dict[str, Any] = settings.load()
        self.collapsed = True  # gate.collapsed
        self.paused = False

    def emit(self, event: str, payload: Any = None, target: str | None = None) -> None:
        self.events.emit(event, payload, target)

    def current_settings(self) -> dict[str, Any]:
        with self.settings_lock:
            import copy

            return copy.deepcopy(self.settings)
