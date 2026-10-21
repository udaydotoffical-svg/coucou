"""The contract with the web UI: commands in, events out.

windows/src/core/bridge.ts calls `invoke(cmd, args)` and `listen(event)`. Here a
command is a function registered under the Rust command's name (snake_case), given
the app and the arguments the page sent (camelCase, as Tauri delivers them), and
returning something JSON-serialisable. Raising CommandError rejects the invoke with
that message, like a Rust `Err(String)`.
"""

from __future__ import annotations

import threading
from typing import Any, Callable

Handler = Callable[["Any", dict[str, Any]], Any]

COMMANDS: dict[str, Handler] = {}


class CommandError(Exception):
    """What a Rust command returned as `Err(message)`."""


def command(name: str | None = None) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        key = name or fn.__name__
        if key in COMMANDS:
            raise RuntimeError(f"command {key} registered twice")
        COMMANDS[key] = fn
        return fn

    return register


def dispatch(app: Any, name: str, args: dict[str, Any] | None = None) -> Any:
    handler = COMMANDS.get(name)
    if handler is None:
        raise CommandError(f"command {name} not found")
    return handler(app, args or {})


Listener = Callable[[str, Any, "str | None"], None]


class EventBus:
    """`app.emit(event, payload)` (every window) and `emit_to(label, ...)` of Tauri."""

    def __init__(self) -> None:
        self._listeners: list[Listener] = []
        self._lock = threading.Lock()

    def subscribe(self, listener: Listener) -> None:
        with self._lock:
            self._listeners.append(listener)

    def emit(self, event: str, payload: Any = None, target: str | None = None) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for listener in listeners:
            listener(event, payload, target)
