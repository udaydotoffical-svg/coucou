import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent


class TempDirs(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        os.environ["COUCOU_CONFIG_DIR"] = str(root / "config")
        os.environ["COUCOU_LOCAL_DIR"] = str(root / "local")
        self.config = root / "config"
        self.config.mkdir()
        from coucou import settings

        settings._not_loaded.clear()
        self.settings = settings

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("COUCOU_CONFIG_DIR", None)
        os.environ.pop("COUCOU_LOCAL_DIR", None)

    def write(self, text, name="settings.json"):
        (self.config / name).write_bytes(text if isinstance(text, bytes) else text.encode())


class LoadTests(TempDirs):
    def test_missing_file_is_defaults(self):
        self.assertEqual(self.settings.load(), self.settings.defaults())

    def test_custom_file_loads_exactly(self):
        custom = json.loads((HERE / "custom_settings.json").read_text())
        self.write(json.dumps(custom))
        loaded = self.settings.load()
        self.assertEqual(loaded, custom)
        defaults = self.settings.defaults()
        same = [k for k in custom if custom[k] == defaults[k]]
        self.assertEqual(same, [], "the fixture must differ from the defaults everywhere")

    def test_bom_and_blank(self):
        self.write(b"\xef\xbb\xbf" + b'{"openOnHover": true}')
        self.assertTrue(self.settings.load()["openOnHover"])
        self.write(b"  \n")
        self.assertEqual(self.settings.load(), self.settings.defaults())

    def test_unusable_field_costs_only_itself(self):
        self.write(json.dumps({"soundVolume": "loud", "openOnHover": True, "chatModels": {"a": 1}}))
        s = self.settings.load()
        self.assertEqual(s["soundVolume"], 0.12)
        self.assertEqual(s["chatModels"], {})
        self.assertTrue(s["openOnHover"])

    def test_corrupt_file_is_kept_aside_and_defaults_used(self):
        self.write("{ not json")
        self.assertEqual(self.settings.load(), self.settings.defaults())
        copies = [p.name for p in self.config.iterdir() if ".corrupt-" in p.name]
        self.assertEqual(len(copies), 1)
        self.settings.load()  # same contents: no second copy
        self.assertEqual(len([p for p in self.config.iterdir() if ".corrupt-" in p.name]), 1)

    def test_sanitize(self):
        self.write(
            json.dumps(
                {
                    "islandWidth": 5000,
                    "islandHeightExtra": -999,
                    "compactHeight": 1,
                    "assistantMode": "nope",
                    "squareSlots": ["a", "b", "c"],
                    "speakModel": "x",
                    "speakLanguage": "FR",
                    "computerBrain": "x",
                    "computerOpencodeModel": " a b\tc ",
                    "weatherPlace": "x" * 200,
                }
            )
        )
        s = self.settings.load()
        self.assertEqual(s["islandWidth"], 1100.0)
        self.assertEqual(s["islandHeightExtra"], -60.0)
        self.assertEqual(s["compactHeight"], 16.0)
        self.assertEqual(s["assistantMode"], "knowura")
        self.assertEqual(s["squareSlots"], ["a", "b"])
        self.assertEqual(s["speakModel"], "whisper-large-v3-turbo")
        self.assertEqual(s["speakLanguage"], "auto")
        self.assertEqual(s["computerBrain"], "main")
        self.assertEqual(s["computerOpencodeModel"], "abc")
        self.assertEqual(len(s["weatherPlace"]), 80)

    def test_migrate_old_names(self):
        self.write(
            json.dumps(
                {
                    "mainAvatar": "agent_cursor",
                    "mochiColors": {"integration_claude": "#fff"},
                    "aiProvider": "openai",
                    "aiBaseUrl": "http://localhost:11434/v1",
                    "model": "llama3",
                }
            )
        )
        s = self.settings.load()
        self.assertEqual(s["mainPill"], "agent_cursor")
        self.assertEqual(s["pillColors"], {"integration_claude": "#fff"})
        self.assertEqual(s["chatProvider"], "ollama")
        self.assertEqual(s["chatModels"], {"ollama": "llama3"})
        self.assertEqual(s["ollamaUrl"], "http://localhost:11434/v1")
        self.assertEqual(s["model"], self.settings.DEFAULT_MODEL)


class SaveTests(TempDirs):
    def test_round_trip(self):
        s = self.settings.defaults()
        s["openOnHover"] = True
        self.settings.save(s)
        self.assertEqual(self.settings.load(), s)
        self.assertEqual([p.name for p in self.config.iterdir()], ["settings.json"])

    def test_unloadable_file_is_not_silently_replaced(self):
        path = self.config / "settings.json"
        self.settings._protect(path)
        path.write_text('{"mainPill": "mine"}')
        self.settings.save(self.settings.defaults())
        kept = [p for p in self.config.iterdir() if ".unread-" in p.name]
        self.assertEqual(len(kept), 1)
        self.assertIn("mine", kept[0].read_text())

    def test_backups(self):
        self.write("{}")
        self.settings.backup_for_upgrade("9.9.9")
        self.assertIn("settings.json.backup-before-9.9.9", [n for n, _ in self.settings.backups()])
        self.assertIsNotNone(self.settings.read_backup("settings.json.backup-before-9.9.9"))
        self.assertIsNone(self.settings.read_backup("../settings.json"))
        self.assertIsNone(self.settings.read_backup("settings.json.backup-../x"))
        for i in range(20):
            self.write("{}", f"settings.json.backup-x{i}")
        self.settings.backup_for_upgrade("9.9.10")
        self.assertLessEqual(len(self.settings.backups()), self.settings.KEEP_BACKUPS)


if __name__ == "__main__":
    unittest.main()
