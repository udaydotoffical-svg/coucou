"""Which Rust commands (windows/src-tauri/src/lib.rs) the Python backend answers yet."""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from coucou import registry  # noqa: E402
from coucou import commands  # noqa: E402,F401

lib = (ROOT / "windows/src-tauri/src/lib.rs").read_text(encoding="utf-8")
block = lib[lib.index("generate_handler!["):]
block = block[: block.index("])")]
rust = sorted({m.split("::")[-1] for m in re.findall(r"^\s+([a-z_0-9:]+),?\s*$", block, re.M)})
done = [c for c in rust if c in registry.COMMANDS]
extra = sorted(set(registry.COMMANDS) - set(rust))
print(f"{len(done)}/{len(rust)} commands ported")
print("missing:", " ".join(c for c in rust if c not in registry.COMMANDS))
if extra:
    print("not in Rust:", " ".join(extra))
