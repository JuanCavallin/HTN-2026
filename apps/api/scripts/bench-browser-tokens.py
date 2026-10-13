"""Token counts for a bench-browser.ts run.

    pip install tiktoken
    python apps/api/scripts/bench-browser-tokens.py .data/bench-browser

Reads <dir>/results.json and the page dumps beside it, counts tokens with
o200k_base (the GPT-4o tokenizer; Jev's own tokenizer is not public), prints
medians over the pages that were not bot walls, and writes
<dir>/results.tokens.json.
"""

import json
import statistics
import sys
from pathlib import Path

import tiktoken

ENCODING = tiktoken.get_encoding("o200k_base")


def count(path: Path) -> int:
    return len(ENCODING.encode(path.read_text(encoding="utf-8"), disallowed_special=()))


out = Path(sys.argv[1] if len(sys.argv) > 1 else ".data/bench-browser")
run = json.loads((out / "results.json").read_text(encoding="utf-8"))
for row in run["rows"]:
    dumps = out / "dumps"
    row["domTokens"] = count(dumps / f"{row['dump']}.dom.html")
    row["ariaTokens"] = count(dumps / f"{row['dump']}.aria.txt")
    row["requestTokens"] = count(dumps / f"{row['dump']}.request.json")
run["meta"]["tokenizer"] = f"o200k_base (tiktoken {tiktoken.__version__})"

kept = [row for row in run["rows"] if not row["blocked"]]
median = statistics.median
print(f"pages: {len(kept)} measured, {len(run['rows']) - len(kept)} bot walls left out")
for row in kept:
    print(
        f"  {row['url'].split('/')[2]:28} DOM {row['domTokens']:>9,}  "
        f"ARIA {row['ariaTokens']:>7,}  Jev request {row['requestTokens']:>6,}"
    )
print(
    "request vs raw DOM:   median "
    f"{median(1 - r['requestTokens'] / r['domTokens'] for r in kept):.1%} fewer tokens, "
    f"lowest {min(1 - r['requestTokens'] / r['domTokens'] for r in kept):.1%}"
)
print(
    "request vs full ARIA: median "
    f"{median(1 - r['requestTokens'] / r['ariaTokens'] for r in kept):.1%} fewer tokens"
)
print(f"request size:         median {median(r['requestTokens'] for r in kept):,.0f} tokens")

(out / "results.tokens.json").write_text(json.dumps(run, indent=2) + "\n", encoding="utf-8")
print(f"wrote {out / 'results.tokens.json'}")
