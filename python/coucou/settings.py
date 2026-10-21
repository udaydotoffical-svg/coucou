"""Preferences, stored as plain JSON in settings.json under paths.config_dir() (settings.rs).

No secret ever lands here: API keys live in the OS keychain (see secrets.py).
Field names are the camelCase ones the web UI reads. A field the file lacks takes
its default, so a settings.json written by an older build still loads.
"""

from __future__ import annotations

import copy
import json
import math
import os
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

from . import log, paths

DEFAULT_MODEL = "claude-opus-5"  # claude.rs
ANTHROPIC = "anthropic"  # chat.rs

ISLAND_WIDTH_MIN, ISLAND_WIDTH_MAX = 560.0, 1100.0
COMPACT_HEIGHT_MIN, COMPACT_HEIGHT_MAX = 16.0, 48.0
ISLAND_HEIGHT_EXTRA_MIN, ISLAND_HEIGHT_EXTRA_MAX = -60.0, 200.0

SPEAK_MODELS = ("whisper-large-v3-turbo", "whisper-large-v3")


def defaults() -> dict[str, Any]:
    """A fresh copy of the default settings (Default for Settings)."""
    return {
        "soundEnabled": True,
        "soundVolume": 0.12,
        "autoCloseInterval": 15.0,
        "openOnHover": False,
        "absenceInterval": 180.0,
        "activeIntegrations": [
            "integration_resend",
            "integration_n8n",
            "integration_vercel",
            "integration_github",
        ],
        "mainPill": "integration_claude",
        "screen": "primary",
        "autostart": False,
        "hooksInstalled": False,
        "model": DEFAULT_MODEL,
        "showPlanInNotch": False,
        "planRelayInstalled": False,
        "showCodexPlanInNotch": False,
        "chatProvider": ANTHROPIC,
        "chatModels": {},
        "ollamaUrl": "",
        "lmstudioUrl": "",
        "customUrl": "",
        "shortcuts": {},
        "mochiOutfit": "auto",
        "pillColors": {},
        "language": "",
        "desktopMochi": {"onDesktop": False, "spot": None},
        "islandWidth": 640.0,
        "islandHeightExtra": 0.0,
        "compactHeight": 32.0,
        "assistantMode": "knowura",
        "squareSlots": ["", ""],
        "showMusicOnNotch": True,
        "mochiHeadphones": True,
        "mochiDances": True,
        "weatherPlace": "",
        "weatherLat": 0.0,
        "weatherLon": 0.0,
        "weatherFahrenheit": False,
        "showWeather": True,
        "showMiniPills": True,
        "closeOnClickOutside": True,
        "autoHide": True,
        "alwaysOnTop": True,
        "showInTaskbar": False,
        "speakEnabled": False,
        "speakModel": "whisper-large-v3-turbo",
        "speakLanguage": "auto",
        "speakWords": "Knowura, Coucou, Mochi",
        "computerUse": False,
        "computerBrain": "main",
        "computerOpencodeModel": "",
        "mochiFeelsPc": True,
        "phoneLink": False,
        "phoneChat": False,
        "phoneChatModels": [],
        "phoneDetails": False,
        "phoneAnswers": False,
        "phoneDiffs": False,
        "phoneUsage": False,
        "phoneServices": [],
        "phoneRelay": False,
        "phoneRelayUrl": "",
        "showClock": False,
    }


# Fields the phone link and the desktop Mochi own: what a webview sends back is ignored (lib.rs save_settings).
RUST_OWNED = (
    "desktopMochi",
    "phoneLink",
    "phoneChat",
    "phoneDetails",
    "phoneAnswers",
    "phoneDiffs",
    "phoneUsage",
    "phoneServices",
    "phoneRelay",
    "phoneRelayUrl",
    "phoneChatModels",
)


# ── Typing: what serde would accept for each field ───────────────────────────


def _kind(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "str"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "dict"
    return "null"


def _fits(default: Any, value: Any) -> bool:
    """Would serde load `value` into a field whose default is `default`?"""
    kind = _kind(default)
    if _kind(value) != kind:
        return False
    if kind == "list" and default:
        inner = _kind(default[0])
        return all(_kind(item) == inner for item in value)
    if kind == "dict" and default and all(_kind(v) == "str" for v in default.values()):
        return all(_kind(v) == "str" for v in value.values())
    return True


def _fits_field(key: str, default: Any, value: Any) -> bool:
    if key == "chatModels" or key == "pillColors":
        return _kind(value) == "dict" and all(_kind(v) == "str" for v in value.values())
    if key == "shortcuts":
        return _kind(value) == "dict" and all(
            _kind(v) == "dict"
            and _kind(v.get("keys", "")) == "str"
            and _kind(v.get("enabled", True)) == "bool"
            for v in value.values()
        )
    if key == "desktopMochi":
        if _kind(value) != "dict":
            return False
        if _kind(value.get("onDesktop", False)) != "bool":
            return False
        spot = value.get("spot")
        return spot is None or (
            _kind(spot) == "dict"
            and all(_kind(spot.get(k)) == "number" for k in ("x", "y"))
            and _kind(spot.get("space")) == "str"
        )
    return _fits(default, value)


# ── Sanitizing and migrating ─────────────────────────────────────────────────


def _control(c: str) -> bool:
    return unicodedata.category(c) == "Cc"


def _clamp(v: float, lo: float, hi: float) -> float:
    return min(max(v, lo), hi) if math.isfinite(v) else lo


def sanitized(settings: dict[str, Any]) -> dict[str, Any]:
    """Keeps what the island can actually draw: sizes inside their range, names it knows."""
    s = settings
    s["islandWidth"] = _clamp(float(s["islandWidth"]), ISLAND_WIDTH_MIN, ISLAND_WIDTH_MAX)
    s["islandHeightExtra"] = _clamp(
        float(s["islandHeightExtra"]), ISLAND_HEIGHT_EXTRA_MIN, ISLAND_HEIGHT_EXTRA_MAX
    )
    s["compactHeight"] = _clamp(float(s["compactHeight"]), COMPACT_HEIGHT_MIN, COMPACT_HEIGHT_MAX)
    if s["assistantMode"] not in ("knowura", "mochi"):
        s["assistantMode"] = "knowura"
    slots = list(s["squareSlots"])[:2]
    while len(slots) < 2:
        slots.append("")
    s["squareSlots"] = slots
    s["weatherPlace"] = s["weatherPlace"][:80]
    if s["speakModel"] not in SPEAK_MODELS:
        s["speakModel"] = "whisper-large-v3-turbo"
    lang = s["speakLanguage"]
    if lang != "auto" and (
        len(lang) < 2 or len(lang) > 3 or not all("a" <= c <= "z" for c in lang)
    ):
        s["speakLanguage"] = "auto"
    if s["computerBrain"] not in ("main", "claude", "opencode", "groq"):
        s["computerBrain"] = "main"
    s["computerOpencodeModel"] = "".join(
        c for c in s["computerOpencodeModel"] if not _control(c) and not c.isspace()
    )[:120]
    # A short list of words, not a document: Whisper only reads a few hundred characters of it.
    s["speakWords"] = "".join(c for c in s["speakWords"] if not _control(c))[:300]
    return s


def _empty(fields: dict[str, Any], key: str) -> bool:
    v = fields.get(key)
    return v is None or v == "" or v == {}


def migrate(fields: dict[str, Any]) -> None:
    """A settings.json from before Louis's Windows 0.2 holds a few things under their old names."""
    main_avatar = fields.get("mainAvatar")
    if isinstance(main_avatar, str) and main_avatar and _empty(fields, "mainPill"):
        fields["mainPill"] = main_avatar
    colors = fields.get("mochiColors")
    if isinstance(colors, dict) and colors and _empty(fields, "pillColors"):
        fields["pillColors"] = colors
    if fields.get("aiProvider") == "openai" and _empty(fields, "chatProvider"):
        url = fields.get("aiBaseUrl") if isinstance(fields.get("aiBaseUrl"), str) else ""
        model = fields.get("model") if isinstance(fields.get("model"), str) else ""
        if "generativelanguage.googleapis.com" in url:
            provider = "google"
        elif "api.openai.com" in url:
            provider = "openai"
        elif "openrouter.ai" in url:
            provider = "openrouter"
        elif "localhost:11434" in url:
            provider = "ollama"
        elif "localhost:1234" in url:
            provider = "lmstudio"
        else:
            provider = "custom"
        fields["chatProvider"] = provider
        if model:
            models = dict(fields["chatModels"]) if isinstance(fields.get("chatModels"), dict) else {}
            models.setdefault(provider, model)
            fields["chatModels"] = models
        if provider == "ollama" and _empty(fields, "ollamaUrl"):
            fields["ollamaUrl"] = url
        elif provider == "lmstudio" and _empty(fields, "lmstudioUrl"):
            fields["lmstudioUrl"] = url
        elif provider == "custom" and _empty(fields, "customUrl"):
            fields["customUrl"] = url
        # `model` was the OpenAI-compatible model; the Claude model goes back to its default.
        fields.pop("model", None)


def _note(message: str) -> None:
    log.line(message)


def _unusable_field(key: str) -> str:
    # The name comes straight from the file: written escaped so a line break in it
    # cannot start what looks like another line of coucou.log.
    return f"settings.json: {json.dumps(key)} is not usable — its default is used instead"


def from_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """Settings from the fields of a settings.json. Each field is taken on its own:
    one that is not the kind of value expected falls back to its default instead of
    costing every other setting. Unknown fields are dropped, as serde does."""
    out = defaults()
    for key, default in list(out.items()):
        if key not in fields:
            continue
        value = fields[key]
        if _fits_field(key, default, value):
            out[key] = copy.deepcopy(value)
        else:
            _note(_unusable_field(key))
    return out


def parse(data: bytes) -> dict[str, Any] | None:
    """The settings held in the bytes of a settings.json, or None when nothing usable is in them."""
    # PowerShell 5 and Notepad write a UTF-8 BOM.
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    if not data.strip():
        return defaults()
    try:
        fields = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(fields, dict):
        return None
    migrate(fields)
    return sanitized(from_fields(fields))


# ── Files ────────────────────────────────────────────────────────────────────


def settings_path() -> Path:
    return paths.config_dir() / "settings.json"


# settings.json files that are there but whose contents never made it into memory: the next
# save must not quietly replace them (see keep_what_was_not_loaded).
_not_loaded: list[Path] = []
_not_loaded_lock = threading.Lock()

MAX_COPIES_PER_SECOND = 100


def load() -> dict[str, Any]:
    return load_from(settings_path())


def load_from(path: Path) -> dict[str, Any]:
    """A missing file means the defaults. One that cannot be read or used also gives the
    defaults, but it still holds what the user had: it is kept, not written over."""
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return defaults()
    except OSError as err:
        _note(f"can't read {path}: {err} — using the defaults")
        _protect(path)
        return defaults()
    parsed = parse(data)
    if parsed is not None:
        return parsed
    try:
        copy_path = _set_aside(path, "corrupt", data)
        _note(f"{path} is not usable — kept as {copy_path}, using the defaults")
    except OSError as err:
        _note(f"{path} is not usable and could not be copied: {err}")
        _protect(path)
    return defaults()


def _protect(path: Path) -> None:
    with _not_loaded_lock:
        if path not in _not_loaded:
            _not_loaded.append(path)


def _keep_what_was_not_loaded(path: Path) -> None:
    with _not_loaded_lock:
        if path not in _not_loaded:
            return
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            _not_loaded.remove(path)
            return
        # Any other error propagates: the file is left as it is and the save is refused.
        copy_path = _set_aside(path, "unread", data)
        _note(f"{path} was never loaded — kept as {copy_path}")
        _not_loaded.remove(path)


def _same_copy(path: Path, kind: str, data: bytes) -> Path | None:
    """The copy of `path` of this `kind` that already holds exactly `data`."""
    prefix = f"{path.name}.{kind}-"
    try:
        for entry in path.parent.iterdir():
            if entry.name.startswith(prefix):
                try:
                    if entry.stat().st_size == len(data) and entry.read_bytes() == data:
                        return entry
                except OSError:
                    continue
    except OSError:
        return None
    return None


def _set_aside(path: Path, kind: str, data: bytes) -> Path:
    """Keeps `data`, the contents of `path`, in a file beside it named after it with
    `.<kind>-YYYYMMDD-HHMMSS` appended. Contents an earlier copy already holds are not
    copied again: a file nobody repairs would otherwise leave one more copy at every launch."""
    existing = _same_copy(path, kind, data)
    if existing:
        return existing
    return _set_aside_as(path, kind, time.strftime("%Y%m%d-%H%M%S"), data)


def _write_whole(fd: int, data: bytes) -> None:
    os.write(fd, data)
    os.fsync(fd)


def _set_aside_as(path: Path, kind: str, stamp: str, data: bytes) -> Path:
    base = f"{path.name}.{kind}-{stamp}"
    for attempt in range(MAX_COPIES_PER_SECOND):
        target = path.with_name(base if attempt == 0 else f"{base}-{attempt}")
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        try:
            try:
                _write_whole(fd, data)
            finally:
                os.close(fd)
        except OSError:
            target.unlink(missing_ok=True)
            raise
        return target
    raise FileExistsError(f"too many copies named {base}")


def save(settings: dict[str, Any]) -> None:
    paths.ensure_private_dir(paths.config_dir())
    save_to(settings_path(), settings)


def save_to(path: Path, settings: dict[str, Any]) -> None:
    _keep_what_was_not_loaded(path)
    blob = json.dumps(settings, indent=2, ensure_ascii=False).encode("utf-8")
    # Write beside the target and rename over it: a crash, a full disk or a power cut
    # leaves the previous settings.json intact rather than half a file.
    temp = path.with_suffix(f".json.coucou-{os.getpid()}")
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            _write_whole(fd, blob)
        finally:
            os.close(fd)
        os.replace(temp, path)
    except OSError:
        temp.unlink(missing_ok=True)
        raise


# ── Backups: an upgrade never costs you your settings ────────────────────────

BACKUP_PREFIX = "settings.json.backup-"
KEEP_BACKUPS = 12


def backup_for_upgrade(version: str) -> None:
    """Before a new version first runs on this settings.json, a copy is kept next to it
    (settings.json.backup-before-<version>), once per version. Never fails the start-up."""
    directory = paths.config_dir()
    file = settings_path()
    marker = directory / "settings.json.last-version"
    try:
        last = marker.read_text(encoding="utf-8").strip()
    except OSError:
        last = ""
    if last == version:
        return
    if file.is_file():
        name = f"{BACKUP_PREFIX}before-{version}"
        target = directory / name
        if not target.exists():
            try:
                target.write_bytes(file.read_bytes())
                _note(f"settings: backed up as {name}")
            except OSError as err:
                _note(f"settings: could not back up before {version}: {err}")
        _prune_backups(directory)
    try:
        marker.write_text(version, encoding="utf-8")
    except OSError:
        pass


def _backup_files(directory: Path) -> list[tuple[float, Path]]:
    """(modified time, path), oldest first."""
    out: list[tuple[float, Path]] = []
    try:
        for entry in directory.iterdir():
            if entry.name.startswith(BACKUP_PREFIX):
                try:
                    out.append((entry.stat().st_mtime, entry))
                except OSError:
                    pass
    except OSError:
        pass
    out.sort(key=lambda item: item[0])
    return out


def _prune_backups(directory: Path) -> None:
    """Only the newest KEEP_BACKUPS stay; the ones made by hand count too."""
    files = _backup_files(directory)
    while len(files) > KEEP_BACKUPS:
        _, oldest = files.pop(0)
        oldest.unlink(missing_ok=True)


def backups() -> list[tuple[str, int]]:
    """The backups on this PC, newest first: (file name, modified time as Unix seconds)."""
    return [(p.name, int(t)) for t, p in reversed(_backup_files(paths.config_dir()))]


def read_backup(name: str) -> dict[str, Any] | None:
    """A backup, read like the settings file is, or None when `name` is not one of ours or
    cannot be read."""
    if not name.startswith(BACKUP_PREFIX) or "/" in name or "\\" in name or ".." in name:
        return None
    try:
        data = (paths.config_dir() / name).read_bytes()
    except OSError:
        return None
    return parse(data)


def backup_current(label: str) -> None:
    """Keeps what is in force now before a restore replaces it."""
    file = settings_path()
    if file.is_file():
        try:
            (paths.config_dir() / f"{BACKUP_PREFIX}{label}-{int(time.time())}").write_bytes(
                file.read_bytes()
            )
        except OSError:
            pass
