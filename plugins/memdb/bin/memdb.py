#!/usr/bin/env python3
"""memdb: searchable SQLite store for Claude's memories and notes.

The markdown memory files stay the source of truth for anything that must load
every session. This database indexes them, plus:
  - "notes": facts kept only here (too many or too niche for MEMORY.md)
  - "docs": long markdown files (handoff notes, plans) split by heading
and searches all of it with SQLite FTS5 (ranked, stemmed full-text search).

Every command first re-syncs changed memory files and indexed docs, so the
database never goes stale. Stdlib only (Python 3.8+ with SQLite FTS5).

Run it on its own:  python3 memdb.py --help
Files: DB at ~/.claude/memdb/memory.db (override with MEMDB_PATH); memory files
from ~/.claude/projects/*/memory/*.md. If CLAUDE_CONFIG_DIR is set it replaces
~/.claude in both places.
"""
import argparse
import datetime as dt
import os
import re
import sqlite3
import sys
from pathlib import Path

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or HOME / ".claude")
DB_PATH = Path(os.environ.get("MEMDB_PATH") or CONFIG_DIR / "memdb/memory.db")
MEMORY_DIRS = [p for p in (CONFIG_DIR / "projects").glob("*/memory") if p.is_dir()]

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- memory | note | doc
  name TEXT NOT NULL,              -- slug, or doc path + '#' + heading
  type TEXT,                       -- user | feedback | project | reference
  project TEXT,
  description TEXT,
  body TEXT NOT NULL,
  source TEXT,                     -- file path for memory/doc
  mtime REAL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  UNIQUE(kind, name)
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  name, description, body, content='entries', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, name, description, body)
  VALUES (new.id, new.name, new.description, new.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, name, description, body)
  VALUES ('delete', old.id, old.name, old.description, old.body);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, name, description, body)
  VALUES ('delete', old.id, old.name, old.description, old.body);
  INSERT INTO entries_fts(rowid, name, description, body)
  VALUES (new.id, new.name, new.description, new.body);
END;
CREATE TABLE IF NOT EXISTS indexed_docs (path TEXT PRIMARY KEY, project TEXT);
"""


def now():
    return dt.datetime.now().isoformat(timespec="seconds")


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def parse_frontmatter(text):
    """Minimal parser for the memory files' frontmatter (name/description/type)."""
    meta = {}
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return meta, text
    for line in m.group(1).splitlines():
        kv = re.match(r"^\s*(name|description|type):\s*(.*)$", line)
        if kv:
            meta[kv.group(1)] = kv.group(2).strip().strip('"').strip("'").replace('\\"', '"')
    return meta, m.group(2).strip()


def upsert(db, kind, name, body, *, type=None, project=None, description=None,
           source=None, mtime=None):
    row = db.execute("SELECT id FROM entries WHERE kind=? AND name=?", (kind, name)).fetchone()
    if row:
        db.execute(
            "UPDATE entries SET type=?, project=?, description=?, body=?, source=?, mtime=?, updated=? WHERE id=?",
            (type, project, description, body, source, mtime, now(), row["id"]))
    else:
        db.execute(
            "INSERT INTO entries(kind,name,type,project,description,body,source,mtime,created,updated) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (kind, name, type, project, description, body, source, mtime, now(), now()))


def sync_memories(db):
    seen = set()
    for d in MEMORY_DIRS:
        project = d.parent.name
        for f in d.glob("*.md"):
            if f.name == "MEMORY.md":
                continue
            src = str(f)
            seen.add(src)
            mtime = f.stat().st_mtime
            old = db.execute("SELECT mtime FROM entries WHERE kind='memory' AND source=?", (src,)).fetchone()
            if old and old["mtime"] == mtime:
                continue
            meta, body = parse_frontmatter(f.read_text(errors="replace"))
            db.execute("DELETE FROM entries WHERE kind='memory' AND source=?", (src,))
            upsert(db, "memory", meta.get("name", f.stem), body, type=meta.get("type"),
                   project=project, description=meta.get("description"), source=src, mtime=mtime)
    for row in db.execute("SELECT id, source FROM entries WHERE kind='memory'").fetchall():
        if row["source"] not in seen:  # memory file was deleted
            db.execute("DELETE FROM entries WHERE id=?", (row["id"],))


def split_by_heading(text):
    """Split markdown into (heading, body) chunks at #/##/### headings."""
    chunks, heading, buf = [], "(top)", []
    for line in text.splitlines():
        if re.match(r"^#{1,3} ", line):
            if "".join(buf).strip():
                chunks.append((heading, "\n".join(buf).strip()))
            heading, buf = line.lstrip("#").strip(), []
        else:
            buf.append(line)
    if "".join(buf).strip():
        chunks.append((heading, "\n".join(buf).strip()))
    return chunks


def sync_doc(db, path, project, force=False):
    p = Path(path)
    if not p.exists():
        db.execute("DELETE FROM entries WHERE kind='doc' AND source=?", (str(p),))
        return
    mtime = p.stat().st_mtime
    old = db.execute("SELECT mtime FROM entries WHERE kind='doc' AND source=? LIMIT 1", (str(p),)).fetchone()
    if old and old["mtime"] == mtime and not force:
        return
    db.execute("DELETE FROM entries WHERE kind='doc' AND source=?", (str(p),))
    counts = {}
    for heading, body in split_by_heading(p.read_text(errors="replace")):
        counts[heading] = counts.get(heading, 0) + 1
        suffix = f" ({counts[heading]})" if counts[heading] > 1 else ""
        upsert(db, "doc", f"{p.name}#{heading}{suffix}", body, project=project,
               description=heading, source=str(p), mtime=mtime)


def sync_all(db):
    sync_memories(db)
    for row in db.execute("SELECT path, project FROM indexed_docs").fetchall():
        sync_doc(db, row["path"], row["project"])
    db.commit()


def fts_query(q):
    """Turn free text into an FTS5 query: every word must match (prefix ok)."""
    words = re.findall(r"[\w.-]+", q)
    return " ".join(f'"{w}"*' for w in words) if words else '""'


def show(row, full=False):
    tag = row["type"] or row["kind"]
    proj = f" [{row['project']}]" if row["project"] and row["kind"] != "memory" else ""
    print(f"● {row['kind']}:{row['name']} ({tag}){proj}")
    if row["description"] and row["kind"] != "doc":
        print(f"  {row['description']}")
    if full:
        print(row["body"])
        if row["source"]:
            print(f"  — source: {row['source']}")
    print()


def cmd_search(db, a):
    sql = ("SELECT e.*, snippet(entries_fts, 2, '«', '»', ' … ', 24) AS snip "
           "FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid "
           "WHERE entries_fts MATCH ?")
    params = [fts_query(a.query)]
    if a.kind:
        sql += " AND e.kind=?"; params.append(a.kind)
    if a.project:
        sql += " AND e.project LIKE ?"; params.append(f"%{a.project}%")
    sql += " ORDER BY bm25(entries_fts, 10.0, 5.0, 1.0) LIMIT ?"
    params.append(a.limit)
    rows = db.execute(sql, params).fetchall()
    if len(rows) < 3 and " " in a.query.strip():  # top up with any-word matches
        params[0] = " OR ".join(f'"{w}"*' for w in re.findall(r"[\w.-]+", a.query))
        have = {r["id"] for r in rows}
        rows += [r for r in db.execute(sql, params).fetchall() if r["id"] not in have][: a.limit - len(rows)]
    if not rows:
        print("No matches."); return
    for r in rows:
        if a.full:
            show(r, full=True)
        else:
            show(r)
            print(f"  {r['snip']}\n")


def cmd_get(db, a):
    rows = db.execute("SELECT * FROM entries WHERE name=? OR name LIKE ? ORDER BY kind",
                      (a.name, f"%{a.name}%")).fetchall()
    if not rows:
        sys.exit(f"Nothing named {a.name!r}.")
    for r in rows[:5]:
        show(r, full=True)


def cmd_add(db, a):
    body = a.body if a.body != "-" else sys.stdin.read()
    upsert(db, "note", a.name, body.strip(), type=a.type, project=a.project, description=a.desc)
    db.commit()
    print(f"Saved note:{a.name}")


def cmd_forget(db, a):
    n = db.execute("DELETE FROM entries WHERE kind='note' AND name=?", (a.name,)).rowcount
    db.commit()
    print(f"Removed {n} note(s)." if n else
          f"No note named {a.name!r} (memory files are removed by deleting the .md file).")


def cmd_index(db, a):
    for path in a.paths:
        p = str(Path(path).expanduser().resolve())
        db.execute("INSERT OR REPLACE INTO indexed_docs(path, project) VALUES (?,?)", (p, a.project))
        sync_doc(db, p, a.project, force=True)
        n = db.execute("SELECT count(*) FROM entries WHERE kind='doc' AND source=?", (p,)).fetchone()[0]
        print(f"Indexed {p} ({n} sections)")
    db.commit()


def cmd_unindex(db, a):
    for path in a.paths:
        p = str(Path(path).expanduser().resolve())
        db.execute("DELETE FROM indexed_docs WHERE path=?", (p,))
        db.execute("DELETE FROM entries WHERE kind='doc' AND source=?", (p,))
        print(f"Stopped indexing {p}")
    db.commit()


def cmd_list(db, a):
    sql, params = "SELECT * FROM entries WHERE 1=1", []
    if a.kind:
        sql += " AND kind=?"; params.append(a.kind)
    if a.project:
        sql += " AND project LIKE ?"; params.append(f"%{a.project}%")
    if a.kind != "doc" and not a.kind:
        sql += " AND kind != 'doc'"
    for r in db.execute(sql + " ORDER BY kind, name", params):
        show(r)
    if not a.kind:
        for d in db.execute("SELECT path FROM indexed_docs"):
            print(f"○ indexed doc: {d['path']}")


def cmd_stats(db, a):
    for r in db.execute("SELECT kind, count(*) n FROM entries GROUP BY kind"):
        print(f"{r['kind']:7} {r['n']}")
    print(f"db: {DB_PATH} ({DB_PATH.stat().st_size // 1024} KB)")


def main():
    ap = argparse.ArgumentParser(prog="memdb", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search", help="ranked full-text search")
    s.add_argument("query"); s.add_argument("-k", "--kind", choices=["memory", "note", "doc"])
    s.add_argument("-p", "--project"); s.add_argument("-n", "--limit", type=int, default=8)
    s.add_argument("-f", "--full", action="store_true", help="print full bodies")
    s = sub.add_parser("get", help="show an entry by name (substring ok)"); s.add_argument("name")
    s = sub.add_parser("add", help="add/replace a DB-only note")
    s.add_argument("name"); s.add_argument("body", help="text, or - to read stdin")
    s.add_argument("-t", "--type", choices=["user", "feedback", "project", "reference"], default="project")
    s.add_argument("-d", "--desc"); s.add_argument("-p", "--project")
    s = sub.add_parser("forget", help="delete a DB-only note"); s.add_argument("name")
    s = sub.add_parser("index", help="index markdown files by heading (kept in sync)")
    s.add_argument("paths", nargs="+"); s.add_argument("-p", "--project")
    s = sub.add_parser("unindex", help="stop indexing files"); s.add_argument("paths", nargs="+")
    s = sub.add_parser("list", help="list memories and notes")
    s.add_argument("-k", "--kind", choices=["memory", "note", "doc"]); s.add_argument("-p", "--project")
    sub.add_parser("sync", help="re-sync now (every command does this anyway)")
    sub.add_parser("stats", help="counts and DB size")
    a = ap.parse_args()
    db = connect()
    sync_all(db)
    if a.cmd == "sync":
        print("Synced."); cmd_stats(db, a); return
    globals()[f"cmd_{a.cmd}"](db, a)


if __name__ == "__main__":
    main()
