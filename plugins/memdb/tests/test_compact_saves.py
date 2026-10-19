"""Transcript saves from auto-compact: one entry per exchange, ranked below curated entries.

Run: python3 -I plugins/memdb/tests/test_compact_saves.py
"""
import os
import sqlite3
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
- Messages: 5

## 1. user

How do we wire the flying gantry sealer interlock?

## 2. assistant

Reading the drawings.

**Read** `{"file_path":"/x.md"}`
> the sealer interlock goes through the safety relay on input I0.3

> tool result: more relay detail

## 4. assistant

The sealer interlock goes through the safety relay on input I0.3.

## 5. user

Now tune the film tension loop.

## 6. assistant

Raised the tension loop gain to 0.8.
"""

MEMORY = """---
name: sealer-interlock
description: Sealer interlock wiring
metadata:
  type: project
---

The sealer interlock uses the safety relay.
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

    def rows(self, kind):
        db = sqlite3.connect(self.cfg / "memdb" / "memory.db")
        return db.execute("SELECT name, description, body, project FROM entries WHERE kind=? ORDER BY id", (kind,)).fetchall()

    def save(self, name="2026-10-20T00-00-00_abc12345_auto.md", text=SAVE):
        (self.saves / name).write_text(text)

    def test_one_entry_per_exchange_named_by_its_prompt(self):
        self.save()
        self.memdb("sync")
        rows = self.rows("transcript")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][1], "2026-10-20 How do we wire the flying gantry sealer interlock?")
        self.assertIn("more relay detail", rows[0][2])
        self.assertIn("safety relay on input I0.3", rows[0][2])
        self.assertEqual(rows[1][1], "2026-10-20 Now tune the film tension loop.")
        self.assertEqual({r[3] for r in rows}, {"clearpack"})

    def test_long_exchange_is_split(self):
        self.save(text=SAVE.replace("Reading the drawings.", "x " * 5000))
        self.memdb("sync")
        names = [r[1] for r in self.rows("transcript")]
        self.assertIn("2026-10-20 How do we wire the flying gantry sealer interlock? (2)", names)

    def test_search_finds_it_with_its_date(self):
        self.save()
        out = self.memdb("search", "tension")
        self.assertIn("transcript:", out)
        self.assertIn("2026-10-20 Now tune the film tension loop.", out)

    def test_memory_ranks_above_transcript(self):
        mem = self.cfg / "projects" / "p" / "memory"
        mem.mkdir(parents=True)
        (mem / "sealer-interlock.md").write_text(MEMORY)
        self.save()
        out = self.memdb("search", "sealer interlock relay")
        self.assertLess(out.index("memory:sealer-interlock"), out.index("transcript:"))

    def test_transcripts_capped_at_two_saves_by_default(self):
        for n in range(4):
            self.save(f"2026-10-2{n}T00-00-00_abc1234{n}_auto.md")
        out = self.memdb("search", "interlock")
        self.assertEqual(out.count("● transcript:"), 2)
        self.assertIn("+2 more in old conversations", out)
        full = self.memdb("search", "interlock", "-k", "transcript")
        self.assertEqual(full.count("● transcript:"), 4)

    def test_precompute_scratch_is_skipped(self):
        self.save("abc12345_precompute.md")
        self.assertIn("No matches", self.memdb("search", "interlock"))

    def test_deleted_save_is_dropped(self):
        self.save()
        self.assertIn("interlock", self.memdb("search", "interlock"))
        next(self.saves.glob("*.md")).unlink()
        self.assertIn("No matches", self.memdb("search", "interlock"))

    def test_old_per_message_doc_entries_are_replaced(self):
        self.save()
        self.memdb("sync")
        db = sqlite3.connect(self.cfg / "memdb" / "memory.db")
        src = str(next(self.saves.glob("*.md")))
        db.execute("INSERT INTO entries(kind,name,body,source,created,updated) VALUES ('doc','old#1. user','interlock',?,'x','x')", (src,))
        db.commit(); db.close()
        self.memdb("sync")
        self.assertEqual(self.rows("doc"), [])

    def test_list_leaves_transcripts_out(self):
        self.save()
        self.assertNotIn("transcript:", self.memdb("list"))

    def test_database_is_owner_only(self):
        self.memdb("stats")
        mode = (self.cfg / "memdb" / "memory.db").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)


if __name__ == "__main__":
    unittest.main()
