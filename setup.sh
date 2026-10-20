#!/usr/bin/env bash
# Sets up these mods on a machine the way they run on the author's: each mod copied to
# ~/.claude/mods/<mod>, loaded through CLAUDE_CODE_PLUGIN_DIRS, auto-compact at 200k.
#
#   ./setup.sh                 all mods
#   ./setup.sh memdb cache-tax only these
#
# Run it again after a git pull to update. Only the env keys below are written to
# settings.json (a backup is kept next to it); everything else there is left alone.
# New sessions pick the mods up; running ones keep what they started with.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CONFIG" && CONFIG="$(cd "$CONFIG" && pwd)"
MODS="$CONFIG/mods"
THRESHOLD="${AUTO_COMPACT_THRESHOLD:-200k}"

command -v rsync >/dev/null || { echo "setup.sh needs rsync" >&2; exit 1; }
command -v python3 >/dev/null || { echo "setup.sh needs python3" >&2; exit 1; }

if [ $# -gt 0 ]; then names=("$@"); else names=(); for d in "$REPO"/plugins/*/; do names+=("$(basename "$d")"); done; fi

mkdir -p "$MODS"
for m in "${names[@]}"; do
  [ -d "$REPO/plugins/$m" ] || { echo "no mod called $m in $REPO/plugins" >&2; exit 1; }
  rsync -a --delete --exclude node_modules --exclude .claude-plugin/types "$REPO/plugins/$m/" "$MODS/$m/"
  echo "installed $m -> $MODS/$m"
done

python3 -I - "$CONFIG/settings.json" "$MODS" "$THRESHOLD" "${names[@]}" <<'EOF'
import json, os, re, shutil, sys

path, mods, threshold, names = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
m = re.fullmatch(r'(\d+(?:\.\d+)?)([km]?)', threshold.strip().lower())
if not m:
    sys.exit(f'AUTO_COMPACT_THRESHOLD must look like 200k, not {threshold!r}')
tokens = int(float(m[1]) * {'': 1, 'k': 1_000, 'm': 1_000_000}[m[2]])

settings = {}
if os.path.exists(path):
    with open(path) as f:
        settings = json.load(f)
    shutil.copy2(path, path + '.bak')
env = settings.setdefault('env', {})

# Keep plugin dirs already listed (other mods, other places); add these, no duplicates.
dirs = [d for d in env.get('CLAUDE_CODE_PLUGIN_DIRS', '').split(os.pathsep) if d]
for n in names:
    d = os.path.join(mods, n)
    if d not in dirs:
        dirs.append(d)
env['CLAUDE_CODE_PLUGIN_DIRS'] = os.pathsep.join(dirs)

if 'auto-compact' in names or os.path.isdir(os.path.join(mods, 'auto-compact')):
    env['AUTO_COMPACT_THRESHOLD'] = threshold
    # The built-in auto-compact fires at window - 13000; at the same size it compacts mid-turn and keeps going.
    env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'] = str(tokens + 13_000)

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path + '.tmp', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
if os.path.exists(path):
    shutil.copymode(path, path + '.tmp')
os.replace(path + '.tmp', path)
print(f'updated {path} (backup: {path}.bak)')
for k in ('CLAUDE_CODE_PLUGIN_DIRS', 'AUTO_COMPACT_THRESHOLD', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'):
    if k in env:
        print(f'  {k}={env[k]}')
EOF
echo "Start a new session to load them."
