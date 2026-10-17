"""Print the parts of a build log worth reading: errors, failing tests, the
summary and the tail. Usage: xctrim.py <log> <exit code>"""

import re
import sys

SHOW_ALL_UNDER = 60
TAIL = 20
MAX_ERROR_LINES = 80
MAX_LINES = 220

SUMMARY = re.compile(
    r"\*\* .+ \*\*"
    r"|Executed \d+ tests?, with"
    r"|Test run with \d+ tests?"
    r"|Tests? (Passed|Failed): \d+ failed"
    r"|\b(Test|Build|Archive) (Succeeded|Failed)\b"
    r"|Testing failed:|Testing started|Test session results"
    r"|\.xcresult\b"
    r"|^Build complete!"
)
ERROR = re.compile(
    r"\berror:|fatal error|❌|✘|\bXCTAssert\w* failed"
    r"|Test Case .* failed|Test .* (failed|recorded an issue)"
    r"|Assertion failed|Undefined symbols?|^ld: |Command \w+ failed"
    r"|Could not |Unable to |The following build commands failed"
)
WARNING = re.compile(r"\bwarning:|⚠️")
NOISE = re.compile(r"Test Case .* (passed|started)|^\s*[✔◇] Test |^\s*✓ ")
FAILING_HEAD = re.compile(r"^(Failing tests:|The following build commands failed:)")


def main() -> None:
    path, rc = sys.argv[1], sys.argv[2]
    try:
        with open(path, errors="replace") as f:
            lines = f.read().splitlines()
    except OSError as err:
        print(f"[xctrim] could not read {path}: {err}")
        return

    if len(lines) <= SHOW_ALL_UNDER:
        print("\n".join(lines))
        print(f"[xctrim] exit {rc} · full log: {path}")
        return

    keep: set = set()
    seen_errors: set = set()
    error_lines = 0
    warnings = 0
    i = 0
    while i < len(lines):
        line = lines[i]
        if FAILING_HEAD.search(line):
            keep.add(i)
            j = i + 1
            while j < len(lines) and lines[j].strip() and j - i < 60:
                keep.add(j)
                j += 1
            i = j
            continue
        if ERROR.search(line):
            # the same error repeats, re-indented or quoted under a macro expansion: key on its message
            found = re.search(r"error: (.*)", line)
            text = found.group(1).strip() if found else line.strip()
            if text not in seen_errors and error_lines < MAX_ERROR_LINES:
                seen_errors.add(text)
                keep.add(i)
                error_lines += 1
                # a compiler error is followed by the source line and a caret
                if "error:" in line:
                    for j in (i + 1, i + 2):
                        if j < len(lines) and lines[j].strip() and not ERROR.search(lines[j]):
                            keep.add(j)
        elif WARNING.search(line):
            warnings += 1
        elif SUMMARY.search(line):
            keep.add(i)
        i += 1
    keep.update(j for j in range(max(0, len(lines) - TAIL), len(lines)) if not NOISE.search(lines[j]))

    out = []
    last = -1
    for idx in sorted(keep):
        if idx != last + 1:
            out.append(f"  … {idx - last - 1} lines …")
        out.append(lines[idx])
        last = idx
    if len(out) > MAX_LINES:
        out = out[: MAX_LINES - TAIL] + ["  … cut …"] + out[-TAIL:]

    print("\n".join(out))
    note = f"{len(lines)} lines → {len(out)} shown"
    if warnings:
        note += f" · {warnings} warnings hidden"
    if error_lines >= MAX_ERROR_LINES:
        note += f" · errors capped at {MAX_ERROR_LINES}"
    print(f"[xctrim] {note} · exit {rc} · full log: {path}")


main()
