# Coucou — Python backend (Windows)

The Rust side of `windows/` rewritten in Python. The web UI in `windows/src` is **unchanged**:
it still calls `invoke(cmd, args)` and `listen(event)` (see `windows/src/core/bridge.ts`), and
`coucou/registry.py` answers the same commands and emits the same events.

`coucou-hook` (the relay Claude Code runs on every event) stays Rust: it must start instantly and
never block Claude Code.

```
python -m unittest discover -s tests    # backend tests, no window needed
python scripts/coverage.py              # which of the Rust commands are ported
```

## Layout
- `coucou/registry.py` — command registry + event bus (the contract with the UI)
- `coucou/app.py` — shared state, and `Host`: what only the window system can do
- `coucou/settings.py` — settings.json (load/salvage/migrate/sanitize/backups/safe save)
- `coucou/commands/` — one module per area; importing it registers its commands

## Status
See `python scripts/coverage.py`. Ported so far: settings, boot, backups, log, quit.
