# claude-mods

A small collection of Claude Code mods (plugins that hook into the session). Install only the ones you want.

| Mod | What it does |
| --- | --- |
| [agent-dashboard](#agent-dashboard) | One Dashboard pane with usage and context bars, tasks, tests, sessions and subagents |
| [auto-handover](#auto-handover) | `/handover` writes a handover note and starts (or proposes) a fresh session |
| [auto-compact](#auto-compact) | Compacts past 250k tokens and saves the full transcript before every compaction |
| [build-trimmer](#build-trimmer) | Trims long `xcodebuild` / `swift build` output so it does not fill your context |
| [prompt-upgrade](#prompt-upgrade) | `/improve` rewrites a rough prompt into a clear one |
| [memdb](#memdb) | A searchable memory database Claude can query and add to |
| [cache-tax](#cache-tax) | Keeps the prompt cache warm during breaks and stops a cold send once with its price (third-party, MIT) |
| [reflect-mod](#reflect-mod) | Turns your corrections into CLAUDE.md rules, saved with one press (third-party, MIT) |

## Requirements

- A Claude Code version that supports mods. Tested on **2.1.299**.
- Python 3.8 or newer for `memdb` (it also needs SQLite with FTS5, which most Python builds have) and for `build-trimmer`'s `xctrim.py`.
- `build-trimmer` is for Apple development (Xcode / SwiftPM). `agent-dashboard` and `auto-handover` work best in the desktop app, where panes and new sessions are available.

## Set up a new machine

To get every mod and the settings this repo is used with (auto-compact at 200k, the built-in auto-compact at the same size), clone it and run the setup script:

```
git clone https://github.com/flyingpurplepizzaeater/claude-mods.git
cd claude-mods && ./setup.sh
```

It copies each mod to `~/.claude/mods/<mod>` and adds three keys to the `env` of `~/.claude/settings.json`: `CLAUDE_CODE_PLUGIN_DIRS` (the mods, kept alongside any plugin folders already listed), `AUTO_COMPACT_THRESHOLD` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Nothing else in the file changes, and the old one is kept as `settings.json.bak`. Name mods to install only those (`./setup.sh memdb cache-tax`), set `AUTO_COMPACT_THRESHOLD=300k` before it for another size, and run it again after `git pull` to update. New sessions load the mods. It needs `rsync` and `python3`, and follows `CLAUDE_CONFIG_DIR` if you set it.

Use either this or the marketplace install below for a mod, not both, or its hooks run twice.

## Install

At the prompt of a terminal session (swap `memdb` for any mod name above):

```
/plugin install memdb --marketplace flyingpurplepizzaeater/claude-mods
```

Claude asks `Add marketplace?`: answer `y`, then pick a scope (user scope is the first one). If the mod has options, a screen lets you set them. You then see `Installed memdb. Plugin is now active.`, and its hooks run from then on, with no reload needed.

From a shell:

```
claude plugin install memdb --marketplace flyingpurplepizzaeater/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `flyingpurplepizzaeater/claude-mods`, then **Add plugin**.

If you have already added the marketplace, `claude plugin install <mod>@claude-mods` is enough.

## The mods

### agent-dashboard

Opens one **Dashboard** pane at session start and stacks everything in it:

- **Usage**: your 5-hour and weekly limits with reset times, plus a context bar for the current session (yellow past 150k tokens, red past 400k, with a toast the first time).
- **Tasks**: follows the session's task list (TodoWrite, TaskCreate or the desktop app's plan tool).
- **Tests**: the last test runs (xcodebuild, swift, pytest, npm, go, cargo and similar), including background runs, with pass/fail.
- **Sessions**: every Claude Code session running on the machine.
- **Subagents**: running and recent subagents of this session.

`/dashboard` brings the pane to the front. The pane refreshes every 5 seconds.

Options (all can be changed later in `/config`):

| Option | Default | Meaning |
| --- | --- | --- |
| `planNote` | on | Tell Claude to write long or multi-part requests into its task list first |
| `queueMessages` | on | A message sent while Claude is working goes to the end of its task list instead of derailing it. Start the message with `!now` to act on it immediately |
| `buildReminder` | off | After a long build or test run in the foreground, remind Claude to use the background next time |

### auto-handover

`/handover` asks Claude to write a short handover note (goal, state, done, next steps, key files, gotchas) to `~/.claude/handovers/` and then starts a fresh session that continues from it. In the desktop app it starts the session directly (or proposes it as a card); elsewhere it leaves the "continue" prompt in the prompt box for you to send after `/clear`.

```
/handover                    write the note and hand over now
/handover status             show whether auto mode is on, the threshold and this session's size
/handover on | off           automatic handover past a context threshold (off by default)
/handover threshold 200k     set the threshold (at least 1k; never above 80% of the window)
```

The threshold can also be set with the environment variable `AUTO_HANDOVER_THRESHOLD` or per project in `.claude/auto-handover.json` (`{ "threshold": "120k" }`). Notes go to `$CLAUDE_CONFIG_DIR/handovers` if that variable is set. No plugin options.

### auto-compact

After each answer, if the context is past 250k tokens, it compacts the conversation, telling the summary to keep the goal, decisions, files changed and next steps. Before **every** compaction (your `/compact`, the built-in auto-compact, or its own) it saves the full conversation as markdown to `~/.claude/compact-saves/`: every message and each tool call with its result, long ones clipped. Common secrets (API keys, tokens, JWTs, private keys, `password: …`) are redacted, and the folder is owner-only (`700`, files `600`). A failed save never blocks the compaction. With [memdb](#memdb) installed, the saves become searchable there.

```
/autocompact status            on or off, the threshold, this session's size and the last save
/autocompact on | off          automatic compaction (on by default; saves happen either way)
/autocompact threshold 250k    set the threshold (at least 10k)
/autocompact now               save and compact now
```

The threshold can also be set with the environment variable `AUTO_COMPACT_THRESHOLD`. Saves go to `$CLAUDE_CONFIG_DIR/compact-saves` if that variable is set. If the model's context window is no larger than the threshold, the built-in auto-compact fires first (the transcript is still saved). No plugin options.

Its own compaction runs between turns, so after one it sends a short prompt telling the session to carry on where it left off (or say in one line that it was done or waiting for you); `/autocompact now` doesn't. Long autonomous runs are smoother if the built-in auto-compact, which compacts mid-turn and keeps going, fires at the same size: set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to the threshold plus 13000 (e.g. `213000` for `200k`). The mod then stays as a backup and still saves the transcript before every compaction.

### build-trimmer

Wraps `xcodebuild`, `swift build` and `swift test` commands that Claude runs in Bash. The full output goes to a log file and Claude sees only the errors, failing tests, the summary and the tail, plus the log path. The exit code is preserved. Logs are in `~/.claude/build-trimmer/logs` and are deleted after 7 days. Add `# no-trim` to a command to leave it alone.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `developerDir` | empty (off) | `DEVELOPER_DIR` to build with, e.g. `/Applications/Xcode-beta.app/Contents/Developer` |
| `developerDirPathMatch` | empty | Use `developerDir` only when the command or working folder contains this text, e.g. `/MyApp`. Empty means every build |
| `extraBuildScripts` | empty | Comma-separated script names that run xcodebuild or swift test themselves, e.g. `test.sh,ci.sh` |

A command that already sets `DEVELOPER_DIR` is never changed. If `python3` is missing the full log is shown instead.

### prompt-upgrade

`/improve <rough prompt>` rewrites a rough prompt into a clear, specific one, using what the session already knows about your project, and puts it in the prompt box so you can review and edit it. Run `/improve send` to submit the last one. It keeps your intent and does not add goals you did not ask for. No options.

### memdb

A searchable memory database (SQLite full-text search, ranked and stemmed) for Claude. It indexes your Claude memory files (`~/.claude/projects/*/memory/*.md`) automatically, and also holds:

- **notes**: small facts kept only in the database (`memdb_add`)
- **docs**: long markdown files such as plans or old handover notes, split by heading (`memdb_index`)
- **transcripts**: if you use auto-compact, each conversation it saves to `~/.claude/compact-saves/` is indexed automatically, one entry per exchange (your prompt and the work that answered it), titled with the date and the prompt's first line and filed under the folder the session ran in. Search ranks memories and notes above docs and docs above transcripts, shows at most two old conversations by default (the best exchange of each) and says how many more matched; search with kind `transcript` for all of them. Deleting a save removes it; the database file is owner-only (`600`).

Claude gets these tools: `memdb_search`, `memdb_add`, `memdb_get`, `memdb_index` and `memdb_forget`, and a short note in the system prompt telling it to search before rereading long notes. You get `/memdb <words>` to search, plus `/memdb stats`, `/memdb list`, `/memdb get <name>` and `/memdb sync`.

If Python is missing, older than 3.8, or lacks FTS5, the tools answer with a clear message instead of failing.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `python` | `python3` | Python command to run the script |
| `dbPath` | empty | Database file. Empty means `~/.claude/memdb/memory.db` (or under `$CLAUDE_CONFIG_DIR`) |
| `promptNote` | on | Add the short "memdb is available" note to the system prompt |

The script also works on its own, with no Claude involved. After installing, find it under the plugin folder (or clone this repo):

```
python3 plugins/memdb/bin/memdb.py --help
python3 plugins/memdb/bin/memdb.py search "database port"
python3 plugins/memdb/bin/memdb.py add staging-port "It is 5433" -d "staging DB port"
```

`MEMDB_PATH` overrides the database location.

### cache-tax

[cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT), copied here at upstream commit `432a08d` (2.3.0) so it installs with the rest. `/keepwarm` keeps the one-hour prompt cache warm through a break by sending a tiny ping 50 minutes after the last request; `/keepwarm always` does that for every session, for up to six hours after each turn. When the cache has gone cold, it stops the first send once and shows what the rewrite will cost. `/cache-tax` shows the cache state and prices. See [its README](plugins/cache-tax/README.md).

One change from upstream: after a compaction in the middle of a turn (the built-in auto-compact), it starts pinging again as soon as the next request comes back, rather than when the turn ends. Without it, a long autonomous turn that compacted and then sat at a permission prompt or a question went cold. Two tests at the end of `tests/register.test.ts` cover it.

### reflect-mod

reflect-mod from [claude-reflect](https://github.com/bayramannakov/claude-reflect) by Bayram Annakov (MIT), copied unchanged at upstream commit `b6c4232` (3.3.0). After a short prompt that corrects Claude, a model check decides whether it is a reusable rule; if so, a band above the prompt offers to save it to CLAUDE.md with one press. See [its README](plugins/reflect-mod/README.md).

## Change options, update, uninstall

- Change options: `/config` in a terminal session (each mod's options are rows there), or reinstall and answer the options screen.
- Update: `claude plugin update <mod>` (or `claude plugin marketplace update claude-mods` first).
- Turn off without removing: `claude plugin disable <mod>`; turn back on with `claude plugin enable <mod>`.
- Uninstall: `claude plugin uninstall <mod>`. To drop the marketplace too: `claude plugin marketplace remove claude-mods`.
- memdb keeps its database in `~/.claude/memdb/`; delete that folder if you want the data gone. auto-handover notes stay in `~/.claude/handovers/`, auto-compact saves in `~/.claude/compact-saves/` and build-trimmer logs in `~/.claude/build-trimmer/logs/`.

## Develop

Each mod is a folder under `plugins/`. Check one with:

```
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
claude plugin validate .        # the marketplace file
```

MIT licensed, see [LICENSE](LICENSE).
