"""Small append-only log at %LOCALAPPDATA%\\Coucou\\coucou.log (log.rs). Nothing leaves the machine."""

import time

from . import paths

_MAX_BYTES = 1_000_000


def line(message: object) -> None:
    try:
        directory = paths.local_dir()
        paths.ensure_private_dir(directory)
        path = directory / "coucou.log"
        # Keep it from growing forever: start fresh past ~1 MB.
        if path.exists() and path.stat().st_size > _MAX_BYTES:
            path.unlink()
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{stamp} {message}\n")
    except OSError:
        pass
