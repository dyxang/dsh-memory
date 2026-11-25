---
description: "Installable profile layer adding file-based persistent agent memory to a dsh --profile surface, for users composing or customizing a profile."
kind: "package-bundle"
---

# @dyxang/dsh-memory

English | [中文](README.zh.md)

## Summary

Adds persistent agent memory to any profile that lists it. Each fact is one Markdown file. Every turn injects a layered prompt view: always-on rules as text, the rest as on-demand pointers. After each turn, an extraction pass writes new memories. The layer inserts one Loader row, `dsh-memory`, and its package owns the tool, the prompt sections, the write policy and the extraction pipeline. The row's page in the Plugins manager edits nine live fields, including the memory width that bounds how long one memory may grow. The other ten keys stay in `cordis.patch.yml`. Profiles that list `@deepseek-ai/dsh-base` already carry the settings surface this layer needs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

```text
dsh plugin --profile web add /absolute/path/to/dsh-memory
dsh plugin --profile web remove @dyxang/dsh-memory
```

`dsh plugin` links the checkout and appends the bundle to `dsh.profile.bundles` because the manifest declares `dsh.bundle.patch`. A package without that declaration still installs, but as a plain dependency: `dsh plugin` prints a warning and activates no layer. To relocate the directory, remove the bundle, move it, then add the new absolute path. The add rewrites the profile junction, so you never hand-edit a profile file.

### Dependencies

The package has one runtime dependency: `@deepseek-ai/schemastery`, which pulls `@deepseek-ai/cosmokit` and `@standard-schema/spec`. The profile links this directory, so the package manager installs none of them. They live in `vendor/`, and `scripts/ensure-deps.mjs` copies them into `node_modules/`. After you copy the plugin to a new location, run it once:

```text
node scripts/ensure-deps.mjs
```

`postinstall` and `prepare` run it for a normal install. A `link:` install skips both, so you run it yourself. Verify with `node scripts/ensure-deps.mjs --check`.

### What you get

One Loader row, `dsh-memory`, carries the whole feature:

| Surface | Owner |
| --- | --- |
| `memory` tool (`list` / `read` / `write` / `search` / `forget` / `audit`) | `host/tool.js` |
| The `Memory` rules section and the layered `MemoryIndex` context in every prompt | `index.js` |
| Write permission inside the memory root, never widening an existing deny | `host/permission.js` |
| Automatic extraction after each turn | `host/extract.js` |
| Loopback routes `/memory/status` and `/memory/file` | `host/status.js` |
| The row's configuration page in the Plugins manager | `client.js` |

### The nine live fields

Plugins → `@dyxang/dsh-memory` → the `dsh-memory` row → configure opens a form for the nine fields marked `.volatile()` in `index.js`: `memoryWidth`, `extractionEnabled`, `minUserChars`, `minCjkChars`, `extractionMinTurns`, `extractionMinSteps`, `includeSubagents`, `recentBodiesInPrompt` and `model`. The page owner hands the card `form.state` and `form.mutate(operations, expectedRevision)`. The card owns only its staged drafts. A save writes the profile patch, survives a restart, and takes effect on the next turn. Each field is read at its point of use, so a volatile-only change reaches the running fiber without a remount.

`memoryWidth` bounds how large a long-lived project's memory grows. `extended` allows long bodies and lets one topic split across files. `balanced`, the default, reproduces the behaviour this package had before the dial existed. `slim` caps every extraction-written body at 800 characters, prefers folding a new fact into an existing file over opening a second one, and narrows the injected index budget while `indexLineLimit` / `indexCharLimit` sit on their defaults. The same dial sets the always-on layer's budget: 10 lines / 800 characters at `balanced` and `slim`, 20 / 1,600 at `extended`. That layer has no key of its own. The `Config` schema in `index.js` unions these three values.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals, click to expand</summary>

`cordis.patch.yml` inserts exactly one row and states every config default, because the loader replaces a patched row's whole `config` value rather than deep-merging keys:

```yaml
- insert:
    - id: dsh-memory
      name: '@dyxang/dsh-memory'
      config:
        enabled: true
        storageRoot: ''
        extractionEnabled: true
        agentMemoryScopes: {}
```

The row's module is the package root, so the browser half attaches to it. `dsh.client` declares `platform: web` and injects `@deepseek-ai/dsh-client-ui-settings`. A row mounted from a subpath export gets no browser half.

| Path | Role |
| --- | --- |
| `index.js` | `apply`, `Config`, `CONFIG_DEFAULTS`, the prompt fibers |
| `host/context.js` | Per-session memory root and index cache |
| `host/extract.js` | Debounce, scheduler, one model call, plan validation |
| `host/permission.js` | `tools/pre-execute`, `tools.guard`, `tools/post-execute` |
| `host/tool.js` | The `memory` tool definition and argument validation |
| `host/status.js` | The two loopback routes |
| `host/agent-memory.js` | Sub-agent identity resolution and the agent section |
| `src/` | Pure logic: format, index, layers, manifest, path safety, plan validation, width |
| `client.js` | The Plugins-page card and the status browser |
| `tests/` | Five suites, run with `node --test` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- The Harness cookbook this package follows: `docs/cookbook/adding-a-settings-card.md` for the live configuration form, and `docs/cookbook/adding-a-package.md` section 5 for the display metadata.
- `docs/user/develop/basic/publish.md` for the install path and layer order quoted above.
- `@deepseek-ai/dsh-client-ui-plugin-manager`'s `lib/types/client/slot-contract.d.ts` for the `plugins.row.config` seat this bundle registers into.

-----

<a id="model-experience"></a>
## Model Experience

### Memory rules in the system prompt

#### What the model sees

One `ctx.systemPrompt.section` named `Memory` runs for every agent while `injectRules` is not false. It names the resolved memory root and states that the directory already exists. Then it defines the file contract: one Markdown file per fact, YAML frontmatter with `name`, `description` and `metadata.type`, a fenced example of that frontmatter, and the `[[name]]` cross-reference syntax. An unmatched link marks something worth writing later; it is not an error. It defines the four types by when they apply: `user` and `feedback` inject as text on every turn, while `project` and `reference` inject as pointers and read on demand. It then states the write gate: three questions that must all be answerable before anything is written (which concrete decision in a future conversation would this change; does the repository, AGENTS.md or git already record it; is it a repeated requirement or a one-off remark). The gate also requires one file per always-on type, with `feedback` in `how_to_work.md`, and keeps that layer inside its injected budget. A "what does NOT earn a memory" list (one-off details, one-time facts, unconfirmed speculation, credentials and PII, anything the repo, AGENTS.md or git already records) and a minimal-scope rule (every-turn stable rules go to `user`/`feedback`, everything else to `project`/`reference`) sit alongside the gate. Next it states the `MEMORY.md` contract: the host maintains the index, one line per memory, never memory content, and the model never edits it. It adds the staleness rule: verify a remembered path or flag before recommending from it. The prompt text is English-only, with no language mirror. At `extended` and `slim`, the section also carries a writing-width block that adds the body budget and, at `slim`, the fold-into-an-existing-file rule. `balanced` adds nothing. The resolved root path is the only data-dependent part.

#### Token effect

Fixed: one section per agent. It appears while `injectRules` is not false and disappears otherwise.

#### KV Cache effect

Append-only. The text changes only when `injectRules` or the resolved root changes, so an already-reusable prefix survives across turns.

### The layered memory view in the request context

#### What the model sees

One `ctx.systemPrompt.context` named `MemoryIndex` runs while `injectIndex` is not false and renders two layers. The always-on layer (`user` and `feedback`) injects the rules themselves, each body minus its `**Why:**` / `**How to apply:**` lines, under a hard budget of 10 lines / 800 characters (20 / 1,600 at `extended`). Over budget, the block truncates and carries a notice that names the overflow and the file to merge into. A type that has grown a second file also gets a consolidation notice naming the file it belongs in. The on-demand layer is one Markdown pointer per remaining memory, with its title and hook, newest first, trimmed by `indexLineLimit` / `indexCharLimit`. A warning line appears when either budget truncates it. A memory whose `MEMORY.md` pointer is missing is not injected, so the index file stays authoritative for what the model sees.

#### Token effect

Capped in both layers: `indexCharLimit` / `indexLineLimit` bound the on-demand pointers, and the always-on budget bounds the text the model cannot avoid. Neither a large memory tree nor a growing rule set expands the prompt without bound.

#### KV Cache effect

Replacing. Either layer changes whenever a memory is written or deleted, so the prefix after it is not reusable across those turns.

### The memory tool schema

#### What the model sees

One tool, `memory`, exposes six actions (`list`, `read`, `write`, `search`, `forget`, `audit`) and a JSON output schema. A missing or mistyped argument returns `{ ok: false, action, error }`, which names the parameter and what it expects instead of throwing. An unexpected failure takes the same channel and is logged. `audit` is a read-only maintenance report: duplicate names and descriptions, dangling `MEMORY.md` pointers, unindexed files that never inject, one-file-per-type conflicts in the always-on layer, over-budget index and always-on layers, and (at `slim`) oversized bodies. It also returns a merge list. It never edits, merges or deletes; the caller acts on the report.

#### Token effect

Fixed: one schema per session, unchanged at runtime.

#### KV Cache effect

Append-only. The schema never changes while the plugin is loaded.

### The extraction request

#### What the model sees

Extraction adds nothing to the agent's own context. It is a separate `ctx.llm.stream()` call that renders the recent transcript, the memory manifest and the recent bodies into one prompt and asks for a single JSON operation plan. Each body arrives with its frontmatter stripped, so the model cannot be taught to paste a header back into a body and is not charged for lines it must not touch. The prompt states that the model has no tools, fixes the output format with a fenced example, and lists the hard rules: `file` is a bare `.md` name with no directories or `..`; `MEMORY.md` is never a target; `type` is exactly one of the four values; `hook` is at most 150 characters and is an index line rather than content; an `edit` body must be complete and never carries frontmatter; the always-on layer stays at one file per type, with every `feedback` rule in `how_to_work.md` and a new `user` fact extending the existing user file; `{"operations":[]}` is the answer when nothing is worth saving. At `slim`, the hard rules add the body budget and a preference for `edit` over `write`. At `extended`, they allow a topic to split across files. At `balanced`, neither appears. The prompt is English-only.

#### Token effect

Conditional. It runs after a turn whose user text clears `minUserChars` or `minCjkChars`, debounced by `extractionDebounceMs`. Its rendered transcript caps at 120,000 characters, and its event window at 500 events. A second gate holds it back until the session has closed at least `extractionMinTurns` turns and `extractionMinSteps` steps, the same `sessionStats` counts the session-statistics panel shows. While that gate holds, nothing is scheduled and the cursor stays put, so the first eligible pass still reads the session instead of skipping its start. A profile that does not mount `sessionStats` passes the gate, so a missing projection never disables extraction. `recentBodiesInPrompt` whole bodies dominate the request size, so that field is the lever on an extraction call's cost. An `edit` is scoped to the bodies the request carries, so lowering the field can never turn a consolidation into a rewrite of a body the model cannot see.

#### KV Cache effect

Independent. The call carries no session id, so it shares no prefix with the agent's requests and cannot invalidate their reuse.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits describe what happens when a deployment pushes past the defaults. They are current package constraints, not a memory-tool comparison or a task backlog.

- **The ten non-volatile keys have no control in the GUI.** `storageRoot`, `indexLineLimit`, `indexCharLimit`, `extractionDebounceMs`, `drainTimeoutMs`, `injectRules`, `injectIndex`, `allowMemoryWrites`, `enabled` and `agentMemoryScopes` are edited in `cordis.patch.yml` only. The package reads them once at install, so a card for them would either lie or need a reload. `storageRoot` in particular moves the whole tree; editing it from a card would make existing memories appear to vanish.
- **The index budgets follow the width only while untouched.** An `indexLineLimit` / `indexCharLimit` still on its schema default follows the width preset: 100 lines / 12,000 characters at `slim`, 400 / 50,000 at `extended`. Any patched value wins at every width. The always-on budget has no key at all: it follows the width preset unconditionally, the write path reports it back to the model on every write into that layer, and the layer enforces it as a truncation plus a notice rather than a refused write. The `slim` body cap applies to extraction writes only; a direct write through the `memory` tool or the `Write` tool follows the prompt guidance, not the clamp.
- **The warm-up gate counts, it does not skip.** `extractionMinTurns` / `extractionMinSteps` decide when extraction starts. While they hold, the cursor does not move: the first eligible pass reads the session from its beginning (up to the 500-event window) instead of jumping past the early turns. Setting both keys to 0 disables the gate.
- **A parse failure advances the cursor.** A model reply that is not a JSON plan counts as a no-op: extraction moves on instead of re-asking the same 120,000-character request every turn. A truncated reply is skipped, not recovered.
- **The sub-agent memory rules are English-only.** The locale service runs on the Client, so the sub-agent prompt cannot read the active interface language.
- **The sub-agent memory prompt templates refer to a `Write` tool, but DSH registers the lower-case `write`.** The mismatch is cosmetic.
- **Extraction costs one model call per qualifying turn.** It batches nothing across turns and runs no local pre-filter, so a chatty session pays for each turn that clears the trigger thresholds.
- **Sub-agent memory is off until configured.** `agentMemoryScopes` defaults to `{}`, so a sub-agent gets no persistent memory until an identity maps to `user`, `project` or `local`. An identity key is the sub-agent's `agentPreset`, its Agent Teams teammate name, or the delegation label, in that order.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This bundle installs through the profile's `link:` dependency, which installs none of a linked package's own dependencies. The package therefore vendors `@deepseek-ai/schemastery` into `node_modules/` (git-ignored) instead of declaring it at runtime. `node scripts/ensure-deps.mjs --check` confirms the vendored copy is present, and `index.js` marks the nine volatile fields with `.volatile()`.

The Host does not hot-rebuild paths under `node_modules/`, and a `link:` target resolves there, so a live reload does not pick up an in-place edit. The changed module is replaced at the next profile recomposition (saving the profile patch or acting in the Plugins page); a full Harness restart is normally not required. `plugin_manager install_bundle` on an already-installed bundle fails with `ambiguous-install`: `pnpm add` reports "Already up to date" and no dependency changed.

</details>
