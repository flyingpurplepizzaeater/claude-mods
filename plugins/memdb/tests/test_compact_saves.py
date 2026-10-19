"""Transcript saves from auto-compact are indexed, searchable, and dropped when deleted.

Run: python3 -I plugins/memdb/tests/test_compact_saves.py
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MEMDB = Path(__file__).resolve().parent.parent / "bin" / "memdb.py"

SAVE = """# Pre-compaction save

- Session: abc12345
- Folder: /home/me/work/clearpack
- Saved: 2026-10-20T00:00:00.000Z
- Trigger: auto at 201k tokens
- Messages: 2

## 1. user

How do we wire the flying gantry sealer interlock?

## 2. assistant

The sealer interlock goes through the safety relay on input I0.3.
"""


class CompactSaves(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmp.name)
        self.saves = self.cfg / "compact-saves"
        self.saves.mkdir()
        self.env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.cfg)}
        self.env.pop("MEMDB_PATH", None)

    def tearDown(self):
        self.tmp.cleanup()

    def memdb(self, *args):
        r = subprocess.run([sys.executable, "-I", str(MEMDB), *args], env=self.env,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_save_is_searchable_under_its_folder(self):
        (self.saves / "2026-10-20T00-00-00_abc12345_auto.md").write_text(SAVE)
        out = self.memdb("search", "interlock", "-p", "clearpack")
        self.assertIn("safety relay", out + self.memdb("search", "relay", "-f"))
        self.assertIn("clearpack", out)

    def test_precompute_scratch_is_skipped(self):
        (self.saves / "abc12345_precompute.md").write_text(SAVE)
        self.assertNotIn("interlock", self.memdb("search", "interlock"))

    def test_deleted_save_is_dropped(self):
        f = self.saves / "2026-10-20T00-00-00_abc12345_manual.md"
        f.write_text(SAVE)
        self.assertIn("interlock", self.memdb("search", "interlock"))
        f.unlink()
        self.assertNotIn("interlock", self.memdb("search", "interlock"))

    def test_database_is_owner_only(self):
        self.memdb("stats")
        mode = (self.cfg / "memdb" / "memory.db").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)


if __name__ == "__main__":
    unittest.main()
