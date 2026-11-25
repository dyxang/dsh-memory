---
description: "Installable profile layer adding file-based persistent agent memory to a dsh --profile surface, for users composing or customizing a profile."
kind: "package-bundle"
---

# @local/dsh-memory

English | [中文](README.zh.md)

## Summary

Adds persistent agent memory to any profile that lists it: one Markdown file per fact, a layered prompt view injected every turn — the always-on rules as text, everything else as on-demand pointers — and automatic extraction after each turn. The layer inserts one Loader row, `dsh-memory`, whose package owns the tool, the prompt sections, the write policy and the extraction pipeline. The row's own page in the Plugins manager edits the nine live fields — including the memory width that bounds how long one memory may grow; the other ten keys stay in `cordis.patch.yml`. A profile that already lists `@deepseek-ai/dsh-base` gains the settings surface this layer needs.

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
dsh plugin --profile web remove @local/dsh-memory
```

`dsh plugin` links the checkout and appends the bundle to `dsh.profile.bundles` because the manifest declares `dsh.bundle.patch`. A package without that declaration still installs, but only as a plain dependency: `dsh plugin` prints a warning and activates no layer. To relocate the directory, remove the bundle first, move it, then add the new absolute path — the profile junction is rewritten by the add, so no profile file is ever hand-edited.

### Dependencies

The only runtime dependency is `@deepseek-ai/schemastery` (which pulls `@deepseek-ai/cosmokit` and `@standard-schema/spec`). Because the profile links this directory, the package manager does not install those for it, so they are committed under `vendor/` and materialized into `node_modules/` by `scripts/ensure-deps.mjs`. After copying the plugin to a new location, run it once:

```text
node scripts/ensure-deps.mjs
```

`postinstall`/`prepare` run it automatically for a normal (non-`link:`) install; for a `link:` install run it explicitly. Verify with `node scripts/ensure-deps.mjs --check`.

### What you get

One Loader row, `dsh-memory`, carrying the whole feature:

| Surface | Owner |
| --- | --- |
| `memory` tool (`list` / `read` / `write` / `search` / `forget` / `audit`) | `host/tool.js` |
| The `Memory` rules section and the layered `MemoryIndex` context in every prompt | `index.js` |
| Write permission inside the memory root, never widening an existing deny | `host/permission.js` |
| Automatic extraction after each turn | `host/extract.js` |
| Loopback routes `/memory/status` and `/memory/file` | `host/status.js` |
| The row's configuration page in the Plugins manager | `client.js` |

### The nine live fields

Plugins → `@local/dsh-memory` → the `dsh-memory` row → configure opens a form for the nine fields marked `.volatile()` in `index.js`: `memoryWidth`, `extractionEnabled`, `minUserChars`, `minCjkChars`, `extractionMinTurns`, `extractionMinSteps`, `includeSubagents`, `recentBodiesInPrompt` and `model`. The page owner hands the card `form.state` and `form.mutate(operations, expectedRevision)`, so the card owns nothing but its staged drafts. A save writes the profile patch, survives a restart, and takes effect on the next turn — every field is read at its point of use, because a volatile-only change is committed into the running fiber without a remount.

`memoryWidth` is the dial that keeps a long-lived project's memory from bloating: `extended` allows long bodies and lets one topic split across files, `balanced` — the default — is the behaviour this package had before the dial existed, and `slim` caps every extraction-written body at 800 characters, prefers folding a new fact into an existing file over opening a second one, and narrows the injected index budget while `indexLineLimit` / `indexCharLimit` sit on their defaults. The same dial carries the always-on layer's budget — 10 lines / 800 characters at `balanced` and `slim`, 20 / 1,600 at `extended` — which has no key of its own. The three options and the schema union are pinned together by `tests/config-schema.mjs`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`cordis.patch.yml` inserts exactly one row and states every config default, because the loader replaces a patched row's whole `config` value rather than deep-merging keys:

```yaml
- insert:
    - id: dsh-memory
      name: '@local/dsh-memory'
      config:
        enabled: true
        storageRoot: ''
        extractionEnabled: true
        agentMemoryScopes: {}
```

The row's module is the package root, so the browser half attaches to it: `dsh.client` declares `platform: web` and injects `@deepseek-ai/dsh-client-ui-settings`. A row mounted from a subpath export would never carry a half.

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
| `tests/` | Nine suites, run with `node tests/<suite>.mjs` |

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

One `ctx.systemPrompt.section` named `Memory`, injected for every agent while `injectRules` is not false. It names the resolved memory root and states that the directory already exists, then defines the file contract: one Markdown file per fact, YAML frontmatter with `name`, `description` and `metadata.type`, a fenced example of that frontmatter, and the `[[name]]` cross-reference syntax with the rule that an unmatched link marks something worth writing later rather than an error. It defines the four types by *when they apply* — `user` and `feedback` are injected as text on every turn, `project` and `reference` are injected as pointers and read on demand — then the write gate: three questions (which concrete decision in a future conversation would this change; does the repository, AGENTS.md or git already record it; is it a repeated requirement or a one-off remark) that must all be answerable before anything is written, with the rule that the always-on layer stays at one file per type — `feedback` in `how_to_work.md` — and inside its injected budget. A "what does NOT earn a memory" list (one-off details, one-time facts, unconfirmed speculation, credentials/PII, anything the repo/AGENTS.md/git already records) and a minimal-scope rule (every-turn stable rules to `user`/`feedback`, everything else to `project`/`reference`) sit alongside the write gate. It then states the `MEMORY.md` contract (the host maintains the index, one line per memory, never memory content, the model never edits it), the staleness rule — verify a remembered path or flag before recommending from it. The prompt text is English-only: no language mirror is appended. At the `extended` and `slim` widths the section also carries a writing-width block — the body budget and, at `slim`, the fold-into-an-existing-file rule; `balanced` adds nothing. The resolved root path is the only data-dependent part.

#### Token effect

Fixed: one section per agent, present while `injectRules` is not false and absent otherwise.

#### KV Cache effect

Append-only. The section text changes only when `injectRules` or the resolved root changes, so an already-reusable prefix survives across turns.

### The layered memory view in the request context

#### What the model sees

One `ctx.systemPrompt.context` named `MemoryIndex`, injected while `injectIndex` is not false, rendering two layers. The always-on layer (`user` and `feedback`) injects the rules themselves — each body minus its `**Why:**` / `**How to apply:**` lines — under a hard budget of 10 lines / 800 characters (20 / 1,600 at `extended`); over budget the block is truncated and carries a notice naming the overflow and the file to merge into, and a type that has grown a second file gets a consolidation notice naming the file it belongs in. The on-demand layer is one Markdown pointer per remaining memory, with its title and hook, newest first, trimmed by `indexLineLimit` / `indexCharLimit` with a warning line when either budget truncates it. A memory whose `MEMORY.md` pointer is missing is not injected at all, so the index file stays authoritative for what the model sees.

#### Token effect

Capped in both layers: `indexCharLimit` / `indexLineLimit` bound the on-demand pointers, and the always-on budget bounds the text the model cannot avoid — so neither a large memory tree nor a growing rule set expands the prompt without bound.

#### KV Cache effect

Replacing. Either layer changes whenever a memory is written or deleted, so the prefix after it is not reusable across those turns.

### The memory tool schema

#### What the model sees

One tool, `memory`, with six actions (`list`, `read`, `write`, `search`, `forget`, `audit`) and a JSON output schema. A missing or mistyped argument returns `{ ok: false, action, error }` naming the parameter and what it expects instead of throwing; an unexpected failure takes the same channel and is logged. `audit` is a read-only maintenance report — duplicate names/descriptions, dangling `MEMORY.md` pointers, unindexed files (never injected), one-file-per-type conflicts in the always-on layer, over-budget index/always-on layers and (at `slim`) oversized bodies, plus a merge list. It never edits, merges or deletes; the caller acts on the report.

#### Token effect

Fixed: one schema per session, unchanged at runtime.

#### KV Cache effect

Append-only. The schema never changes while the plugin is loaded.

### The extraction request

#### What the model sees

Nothing in the agent's own context. Extraction is a separate `ctx.llm.stream()` call that renders the recent transcript, the memory manifest and the recent bodies — each with its frontmatter stripped, so the model can neither be taught to paste a header back into a body nor be charged for lines it must not touch — into one prompt and asks for a single JSON operation plan. Its prompt states that the model has no tools, fixes the output format with a fenced example, and lists the hard rules: `file` is a bare `.md` name with no directories or `..`, `MEMORY.md` is never a target, `type` is exactly one of the four values, `hook` is at most 150 characters and is an index line rather than content, an `edit` body must be complete and never carries frontmatter, the always-on layer stays at one file per type (every `feedback` rule in `how_to_work.md`, a new `user` fact extending the existing user file), and `{"operations":[]}` is the answer when nothing is worth saving. At the `slim` width the hard rules add the body budget and the preference for `edit` over `write`; at `extended` they allow a topic to split across files; at `balanced` neither appears. The prompt is English-only, with no Chinese restatement appended.

#### Token effect

Conditional: it runs after a turn whose user text clears `minUserChars` or `minCjkChars`, debounced by `extractionDebounceMs`, with its rendered transcript capped at 120,000 characters and its event window at 500 events. A second gate holds it back until the session has closed at least `extractionMinTurns` turns and `extractionMinSteps` steps — the same `sessionStats` counts the session-statistics panel shows; while it holds, nothing is scheduled and the cursor stays put, so the first eligible pass still reads the session instead of skipping its start. A profile that does not mount `sessionStats` passes that gate, so a missing projection can never switch extraction off silently. The request's size is dominated by `recentBodiesInPrompt` whole bodies rather than by the transcript, so that one field is the lever on an extraction call's cost — and an `edit` is scoped to the bodies the request actually carries, so lowering it can never turn a consolidation into a rewrite of a body the model cannot see.

#### KV Cache effect

Independent. The call carries no session id, so it shares no prefix with the agent's requests and cannot invalidate their reuse.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits tell you what to expect when a deployment pushes past the defaults. They are current package constraints, not a general memory-tool comparison or a task backlog.

- **The ten non-volatile keys have no control in the GUI.** `storageRoot`, `indexLineLimit`, `indexCharLimit`, `extractionDebounceMs`, `drainTimeoutMs`, `injectRules`, `injectIndex`, `allowMemoryWrites`, `enabled` and `agentMemoryScopes` are edited in `cordis.patch.yml` only. They are read once at install, so a card for them would either lie or need a reload; `storageRoot` in particular moves the whole tree, and editing it from a card would make existing memories appear to vanish.
- **The index budgets follow the width only while untouched.** An `indexLineLimit` / `indexCharLimit` still sitting on its schema default is replaced by the width preset — 100 lines / 12,000 characters at `slim`, 400 / 50,000 at `extended` — while any patched value wins at every width. The always-on budget has no key at all: it follows the width preset unconditionally, is reported back to the model on every write into that layer, and is enforced as a truncation plus a notice rather than as a refused write. The `slim` body cap is likewise enforced on extraction writes only: a direct write through the `memory` tool or the `Write` tool follows the prompt guidance, not the clamp.
- **The warm-up gate counts, it does not skip.** `extractionMinTurns` / `extractionMinSteps` decide when extraction *starts*, and while they hold the cursor does not move: the first eligible pass reads the session from its beginning (up to the 500-event window) rather than jumping past the early turns. Both keys set to 0 disables the gate.
- **A parse failure advances the cursor.** When the model returns something that is not a JSON plan, extraction treats it as a no-op and moves on rather than re-asking the same 120,000-character request every turn. A truncated reply is therefore skipped, not recovered.
- **The sub-agent memory rules are English-only.** The locale service is Client-side, so the sub-agent prompt cannot read the active interface language.
- **The sub-agent memory prompt templates refer to a `Write` tool** where DSH registers the lower-case `write`; the mismatch is cosmetic.
- **Extraction costs one model call per qualifying turn.** There is no batching across turns and no local pre-filter, so a chatty session pays for each turn that clears the trigger thresholds.
- **Sub-agent memory is off until configured.** `agentMemoryScopes` defaults to `{}`, so a sub-agent gets no persistent memory until an identity is mapped to `user`, `project` or `local`. An identity key is the sub-agent's `agentPreset`, its Agent Teams teammate name, or the delegation label, consulted in that order.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This bundle is installed through the profile's `link:` dependency, which installs none of a linked package's own dependencies — so `@deepseek-ai/schemastery` is vendored into `node_modules/` (git-ignored) rather than declared at runtime. `node tests/config-schema.mjs` is the check that the vendored copy is still present and that the schema still carries the nine volatile fields.

The Host does not hot-rebuild paths under `node_modules/`, and a `link:` target resolves there, so an in-place edit is not picked up by a live reload; the changed module is replaced at the next profile recomposition (saving the profile patch or acting in the Plugins page), and a full Harness restart is normally not required. `plugin_manager install_bundle` on an already-installed bundle fails with `ambiguous-install`: `pnpm add` reports "Already up to date" and no dependency changed.

</details>
