"""Where Coucou keeps things (platform/windows.rs)."""

import os
from pathlib import Path

HOOK_EXE = "coucou-hook.exe"


def _base(var: str, override: str) -> Path:
    if os.environ.get(override):
        return Path(os.environ[override])
    value = os.environ.get(var)
    return (Path(value) if value else Path(".")) / "Coucou"


def config_dir() -> Path:
    """%APPDATA%\\Coucou, where settings.json lives. COUCOU_CONFIG_DIR overrides it (tests)."""
    return _base("APPDATA", "COUCOU_CONFIG_DIR")


def local_dir() -> Path:
    """%LOCALAPPDATA%\\Coucou, where coucou-hook.exe, the inbox and the log live."""
    return _base("LOCALAPPDATA", "COUCOU_LOCAL_DIR")


def hook_exe_path() -> Path:
    return local_dir() / "bin" / HOOK_EXE


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
