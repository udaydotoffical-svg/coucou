"""boot, save_settings, the settings backups, log_line, quit (lib.rs)."""

from __future__ import annotations

from typing import Any

from .. import log, paths, settings
from ..app import App
from ..registry import command

# Providers the other modules fill in as they are ported. Until a module exists, the
# value here is what the UI would see with that feature absent.
providers: dict[str, Any] = {
    "hooks_status": lambda: {"installed": False, "planRelayInstalled": False},
    "knowura_hotkey": lambda: None,
    "on_settings_saved": [],  # callables (app, old, new) run after a save
}


@command()
def boot(app: App, args: dict[str, Any]) -> dict[str, Any]:
    current = app.current_settings()
    # The real state of ~/.claude/settings.json wins over whatever we stored.
    status = providers["hooks_status"]()
    current["hooksInstalled"] = status["installed"]
    current["planRelayInstalled"] = status["planRelayInstalled"]
    return {
        "settings": current,
        "screen": app.host.screen_info(current["screen"]),
        "version": app.version,
        "hookPath": str(paths.hook_exe_path()),
        "cursorPoll": True,  # platform::CURSOR_POLL on Windows
        "knowuraHotkey": providers["knowura_hotkey"](),
    }


@command()
def save_settings(app: App, args: dict[str, Any]) -> None:
    incoming = settings.sanitized(settings.from_fields(args["settings"]))
    with app.settings_lock:
        old = app.settings
        # Where Mochi sits on the desktop, and the phone link, belong to their own commands.
        for key in settings.RUST_OWNED:
            incoming[key] = old[key]
        app.settings = incoming
        new = incoming
    try:
        settings.save(new)
    except OSError as err:
        log.line(f"could not save settings: {err}")

    def changed(*keys: str) -> bool:
        return any(old[k] != new[k] for k in keys)

    host = app.host
    if changed("autostart"):
        try:
            host.set_autostart(new["autostart"])
        except OSError as err:
            log.line(f"autostart: {err}")
    for hook in providers["on_settings_saved"]:
        hook(app, old, new)
    if changed("assistantMode", "autostart", "computerUse"):
        host.refresh_tray()
    if changed("showInTaskbar"):
        host.set_taskbar_visible(new["showInTaskbar"])
    size_changed = changed("islandWidth", "islandHeightExtra")
    if changed("screen", "alwaysOnTop", "showInTaskbar") or size_changed:
        host.apply_geometry(new["screen"], app.collapsed)
        if size_changed:
            host.refresh_click_through()
    # Keep the other window in step (island ⇄ settings window).
    app.emit("settings-changed", app.current_settings())


@command()
def settings_backups(app: App, args: dict[str, Any]) -> list[list[Any]]:
    return [list(item) for item in settings.backups()]


@command()
def settings_backup_read(app: App, args: dict[str, Any]) -> dict[str, Any] | None:
    backup = settings.read_backup(args["name"])
    if backup is None:
        return None
    settings.backup_current("before-restore")
    return backup


@command()
def log_line(app: App, args: dict[str, Any]) -> None:
    log.line(f"ui  {args['message']}")


@command()
def quit_app(app: App, args: dict[str, Any]) -> None:
    app.host.quit()
