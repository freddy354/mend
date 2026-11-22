# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/freddy354/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/freddy354/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and `mend` reads all of them:

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

Every file is changed or nothing is. `SPEC.md` is the whole contract.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`) and `ok: <n> files`. Exit 1 lists the edits that failed and `failed: <k> of <n> edits`; no file is written. Exit 2 is a usage, patch, format or parse error, with exactly one `error: ...` line.

Matching is in three tiers: exact lines first, then lines equal once trailing spaces and tabs are removed, then lines equal once leading and trailing spaces and tabs are removed. A match that is not unique where the format gives no way to choose is never applied.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the environment and runs `main.ts` on each one.
- `check.ts`: runs `main.ts` on the kit's public practice set.
- `SPEC.md`: the specification this tool implements.
- `LICENSE`: MIT.

## Checking it locally

From the kit directory:

    node check.ts ../program/generator/practice.json

or, as the server grades it:

    node cli/makefun.mjs grade-local --kit . --bot <repository> --driver process

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
