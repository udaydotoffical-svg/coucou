import unittest

from test_settings import TempDirs

from coucou import registry
from coucou.app import App, Host
from coucou.commands import core


class RecordingHost(Host):
    def __init__(self):
        self.calls = []

    def screen_info(self, pref):
        self.calls.append(("screen_info", pref))
        return super().screen_info(pref)

    def apply_geometry(self, pref, collapsed):
        self.calls.append(("apply_geometry", pref, collapsed))

    def refresh_click_through(self):
        self.calls.append(("refresh_click_through",))

    def set_taskbar_visible(self, visible):
        self.calls.append(("taskbar", visible))

    def set_autostart(self, enabled):
        self.calls.append(("autostart", enabled))

    def refresh_tray(self):
        self.calls.append(("tray",))

    def quit(self):
        self.calls.append(("quit",))


class CommandTests(TempDirs):
    def make(self):
        host = RecordingHost()
        app = App(host)
        seen = []
        app.events.subscribe(lambda e, p, t: seen.append((e, p, t)))
        return app, host, seen

    def test_unknown_command(self):
        app, _, _ = self.make()
        with self.assertRaises(registry.CommandError):
            registry.dispatch(app, "nope")

    def test_boot_shape_and_hooks_state_wins(self):
        app, host, _ = self.make()
        app.settings["hooksInstalled"] = True
        out = registry.dispatch(app, "boot")
        self.assertEqual(set(out), {"settings", "screen", "version", "hookPath", "cursorPoll", "knowuraHotkey"})
        self.assertFalse(out["settings"]["hooksInstalled"])
        self.assertTrue(out["cursorPoll"])
        self.assertIsNone(out["knowuraHotkey"])

    def test_save_applies_side_effects_and_keeps_owned_fields(self):
        app, host, seen = self.make()
        app.settings["phoneLink"] = True
        app.settings["desktopMochi"] = {"onDesktop": True, "spot": None}
        new = app.current_settings()
        new.update(
            phoneLink=False,
            desktopMochi={"onDesktop": False, "spot": None},
            islandWidth=900,
            showInTaskbar=True,
            autostart=True,
            alwaysOnTop=False,
        )
        registry.dispatch(app, "save_settings", {"settings": new})
        self.assertTrue(app.settings["phoneLink"])
        self.assertTrue(app.settings["desktopMochi"]["onDesktop"])
        self.assertEqual(app.settings["islandWidth"], 900.0)
        self.assertEqual(host.calls.count(("autostart", True)), 1)
        self.assertIn(("taskbar", True), host.calls)
        self.assertIn(("apply_geometry", "primary", True), host.calls)
        self.assertIn(("refresh_click_through",), host.calls)
        self.assertIn(("tray",), host.calls)
        self.assertEqual(seen[-1][0], "settings-changed")
        # and it hit the disk
        from coucou import settings

        self.assertEqual(settings.load()["islandWidth"], 900.0)

    def test_save_with_no_change_does_nothing_to_windows(self):
        app, host, seen = self.make()
        registry.dispatch(app, "save_settings", {"settings": app.current_settings()})
        self.assertEqual(host.calls, [])
        self.assertEqual(len(seen), 1)

    def test_backup_read_keeps_current_first(self):
        app, _, _ = self.make()
        from coucou import settings

        settings.save(settings.defaults())
        (self.config / "settings.json.backup-mine").write_text('{"showClock": true}')
        out = registry.dispatch(app, "settings_backup_read", {"name": "settings.json.backup-mine"})
        self.assertTrue(out["showClock"])
        self.assertTrue(any("before-restore" in n for n, _ in settings.backups()))
        self.assertIsNone(registry.dispatch(app, "settings_backup_read", {"name": "evil"}))

    def test_log_line(self):
        app, _, _ = self.make()
        registry.dispatch(app, "log_line", {"message": "hello"})
        from coucou import paths

        self.assertIn("ui  hello", (paths.local_dir() / "coucou.log").read_text())


if __name__ == "__main__":
    unittest.main()
