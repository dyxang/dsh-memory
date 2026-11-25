# Changelog

## 0.3.1

Documentation and comment cleanup. No functional change: executable code,
runtime strings, on-disk format and the `memory` tool definition are unchanged.

### Changed
- **Removed all attribution to the legacy upstream prototype** from every module
  header comment and from both READMEs. The now-meaningless `*.ts` source paths,
  "ported from" provenance lines and "prototype does X, we do Y" design
  comparisons were rewritten as standalone descriptions of this plugin, keeping
  the design rationale, constants and DSH-side behaviour notes intact.
- **README "Known Limitations"** no longer attributes the `Write`-vs-`write`
  naming note to the prototype; it now just states the DSH naming mismatch and
  that it is cosmetic.
- **README rewritten for direct prose**, and its test facts corrected: five
  suites run with `node --test`, and the references to the deleted
  `tests/config-schema.mjs` were replaced with the real `Config` schema and
  `ensure-deps --check`.

### Packaging & market prep
- `package.json` now carries `license`, `author`, `homepage`, `repository`,
  `keywords` and `engines.dsh`; `market/plugin.json` holds the display metadata
  and the intended public package name, and `npm run build:market`
  (`scripts/build-market-index.mjs`) emits a format-1 DSH market index. The
  build refuses a `private` or `@local/*` package, so this dev copy keeps both
  and the release copy (public name, `private` removed) produces
  `market/index.json`.

### Verified
- Comment-stripped source of all 26 `src/` + `host/` modules is byte-identical
  to 0.3.0, confirming only comments and docs changed.
- `node --test` = 16 passing.

## 0.3.0

Memory-hygiene pass (A+B). On-disk format is unchanged; existing data reads as-is.
The `memory` tool gains one action (`audit`); nothing else in the schema changes.

### Changed
- **Write and extraction prompts reject non-memory content more strictly.** The
  host `Memory` section and the sub-agent dictionary (en + zh) now carry a
  "what does NOT earn a memory" list — one-off/ephemeral details, one-time
  facts (a date, a person, a version, a ticket), unconfirmed speculation or raw
  transcripts, credentials/tokens/cookies/passwords/customer-private data, and
  anything the repository, AGENTS.md or git already records — plus a
  minimal-scope rule: a stable every-turn rule goes to `user`/`feedback`,
  everything else stays `project`/`reference` and is read on demand. The
  extraction protocol repeats the same gate as hard rules.

### Added
- **`memory` tool `audit` action** — a read-only maintenance report over the
  project memory root: duplicate names/descriptions, dangling `MEMORY.md`
  pointers (file missing), unindexed files (present on disk but never injected),
  one-file-per-type conflicts in the always-on layer, over-budget index and
  always-on layers, and (at `slim`) oversized bodies, plus a merge list
  (`src/memory-audit.js`, wired through `host/tool.js`). It never edits, merges
  or deletes — the caller acts on the report. Matches the plugin's
  project-scoped positioning: one root, no cross-project scan.

### Docs, tests & version
- `package.json` and this changelog bumped to `0.3.0`; on-disk memory format and
  config schema are unchanged, so existing data reads as-is.
- New `tests/memory-audit.test.mjs` (pure analyser + real-`MemoryStore` tool
  integration, including a read-only check that the index is not modified);
  full suite `node --test` = 16 passing (10 existing + 6 new).
- `README.md` / `README.zh.md` updated: the `memory` tool action list goes from
  five to six, plus a description of the `audit` report and the new prompt
  filtering / minimal-scope guidance.

## 0.2.0

Robustness pass (A+B). Tool argument schema, config schema and on-disk memory
format are unchanged; existing data reads as-is.

### Fixed
- **Lost index lines under concurrency.** `MEMORY.md` is maintained by a
  read-modify-write shared by the `memory` tool, the extraction pass and the
  direct-`write`/`edit` permission hook. All three now run inside a per-memory-
  root async lock (`src/memory-fs.js`), so two writers on the same root no longer
  clobber each other's pointer lines.
- **Torn files on crash / interruption.** Memory files and `MEMORY.md` are now
  replaced atomically (same-directory temp + `rename`); a crash leaves the old
  file intact instead of a half-written one.
- **`forget` lied about missing files.** `deleteMemory` now reports
  `{ deleted: false }` for a file that did not exist instead of unconditionally
  reporting success; the tool renders `no such memory: <file>`.

### Added
- **Index self-heal.** On first use of a memory root each process, `MEMORY.md`
  is reconciled against the files on disk: a top-level memory file with no
  pointer gets one added, so a memory written outside the tool is no longer
  invisible. One-directional and idempotent.
- **Bounded `search`.** Body scanning is capped (512 KiB per file, 2 MiB total);
  name/description matches stay unlimited. Results carry `truncated` when some
  bodies were skipped.
- **`vendor/` + `scripts/ensure-deps.mjs`.** The runtime dependency tree is
  committed under `vendor/` and materialized idempotently, so a copied plugin no
  longer fails to import `@deepseek-ai/schemastery` (the "cannot resolve profile
  bundle" failure).
- **Tests.** `node --test` suite covering atomic writes, lock serialization,
  concurrent index maintenance, `forget` semantics, search caps and index
  reconciliation.

### Compatibility
- Verified against DSH 0.2.2-rc.5 (previously audited against 0.2.1-alpha.3).
- Node.js ESM; POSIX atomic-rename assumption (Linux/macOS).

### Known limitation
- The write lock is in-process. A second `dsh` process operating on the same
  memory root is not serialized; atomic rename still prevents torn files, but a
  concurrent index read-modify-write could lose a line. Considered acceptable
  versus the stale-lock risks of a cross-process lockfile.
