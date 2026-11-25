/**
 * The two prompt layers the memory system injects today.
 *
 * Each layer is one function:
 *  - {@link buildMemoryContent}    — the shared data-model spec (layer 1)
 *  - {@link buildExtractionPrompt} — the task protocol (layer 2)
 *
 * Layer 2 uses the structured single-call extraction of design decision D1:
 * instead of a tool-using loop it asks for one JSON operation plan that the
 * host validates and applies.
 *
 * The prompt text is English-only (decided 2026-10-29): an earlier version
 * appended a `## 中文要点 / CJK essentials` restatement to both layers and
 * that mirror was dropped — it doubled the always-on bytes to restate rules
 * already stated. Language selection stays where it is gated properly, in the
 * sub-agent dictionary (`agent-memory-prompt.js`) and the client locale.
 *
 * Both layers take a width (`extended` / `balanced` / `slim`, see
 * `src/memory-width.js`). `balanced` — the default — adds nothing: the text is
 * exactly what this module shipped before the dial existed, so an existing
 * deployment sees no prompt change until it picks a width.
 *
 * @module dsh-memory/prompt
 */

import { memoryWidthPreset, resolveMemoryWidth } from './memory-width.js'
import { ALWAYS_ON_FILE } from './memory-layers.js'

/** Order of the Memory rules section, before every tool section. */
export const MEMORY_SECTION_ORDER = 450

/** Order of the MemoryIndex context, right after the rules. */
export const MEMORY_INDEX_ORDER = 460

/**
 * The four memory types, defined by *when they apply* rather than by what they
 * look like. The first two are injected as text on every turn; the last two are
 * injected as pointers and read on demand (see `src/memory-layers.js`), so the
 * definitions have to say which is which or the model will keep filing
 * always-on material where nobody reads it in time.
 */
const MEMORY_TYPES = [
  ['user', 'who the user is: role, expertise, goals, standing preferences.'],
  ['feedback', 'a standing requirement on how you work: a correction the user made, or a request they repeated.'],
  ['project', 'a fact, state, constraint or environment trap of this project that the code and git do not record.'],
  ['reference', 'an external address — a URL, a dashboard, a ticket id. The address only, never the content.'],
]

/**
 * The always-on / on-file split. Kept next to the types because it is the
 * other half of their definition. English-only: the prompt text carries no
 * language mirror (the sub-agent dictionary in `agent-memory-prompt.js` is
 * the language-gated one).
 */
const LAYERS = [
    '## Two layers',
    '',
    'The type decides how a memory reaches you. Text that the host injects on every turn costs more attention than text that you read on demand:',
    '',
    '- **Always on** (`user`, `feedback`). The host injects this text into every turn. The host strips any `**Why:**` / `**How to apply:**` line from it. Each rule must stand alone on one line.',
    '  - Keep this layer to ONE file per type. Put every `feedback` rule in `how_to_work.md`.',
    '  - Stay inside the injected budget. When the prompt reports an over-budget layer, merge files or delete rules before you add more.',
    '- **On file** (`project`, `reference`). The host injects only the one-line pointer. When the topic comes up, read the body with the `memory` tool. Do not read it "just in case". Do not treat the hook as the fact.',
    '',
    '## What earns a memory',
    '',
    'Before writing, answer three questions. If you cannot answer all three, do not write:',
    '',
    '1. Which concrete decision in a FUTURE conversation would this change?',
    '2. Does the repository, AGENTS.md or git already record it? Then it belongs there, not here.',
    '3. Is it a repeated requirement, or something the user corrected? Only then does it earn an always-on line. A one-off remark never does.',
    '',
    'An always-on line is the most expensive text you can write. The model reads it again on every turn. Fold a new rule into the existing file. Do not open a second file. Drop rules that stopped being true.',
    '',
    '## What does NOT earn a memory',
    '',
    'Reject these even when the user asks to save — ask what was surprising or non-obvious and keep only that part:',
    '',
    '- One-off or ephemeral details: a single task\'s requirements, temporary state, this conversation only.',
    '- One-time facts: a date, a person, a version, a ticket — unless it changes a future decision.',
    '- Unconfirmed guesses, speculation, or raw chat transcripts. Save only confirmed conclusions.',
    '- Credentials, tokens, cookies, passwords, or customer-private data — never.',
    '- Anything the repository, AGENTS.md, or git already records.',
    '',
    'Scope is minimal. Put each fact in the smallest layer that still reaches the right turns: a stable, project-wide rule that must hold on every turn is `user` / `feedback`; everything else is `project` / `reference` and is read only when its topic comes up. Do not promote a topic-specific fact into the always-on layer — that makes every unrelated turn pay for it.',
]

/**
 * The width guidance for layer 1. `balanced` has no entry: it is the
 * pre-dial text, and adding a paragraph for it would change every existing
 * deployment's prompt for no gain.
 *
 * @type {Readonly<Record<'extended'|'slim', string[]>>}
 */
const WIDTH_GUIDANCE = {
  extended: [
    '## Writing width — extended',
    '',
    'Write as much as the fact needs. A body may carry its context, its examples, and the full `**Why:**` / `**How to apply:**` lines.',
    '',
    'Split a large topic across several files when each part stands alone. One fact per file still holds. The index hook stays one line.',
  ],
  slim: [
    '## Writing width — slim',
    '',
    'Keep every memory small. One file holds one fact. Keep the body under 800 characters (about 12 lines).',
    '',
    'Lead with the fact. Add at most one `**Why:**` line. Drop examples, restatements, and the history of how you got there.',
    '',
    'When an existing file already covers the topic, update that file. Do not open a second file. Condense a topic that keeps growing in one direction. Do not append to it.',
  ],
}

/**
 * Layer 1 — the shared data-model spec injected as a system-prompt section.
 * @param {string} memoryRoot absolute path of the memory directory.
 * @param {string} [width] one of {@link MEMORY_WIDTHS}; unknown values fall
 *   back to `balanced`, which adds no guidance.
 * @returns {string}
 */
export function buildMemoryContent(memoryRoot, width) {
  const types = MEMORY_TYPES
    .map(([name, description]) => `- \`${name}\` — ${description}`)
    .join('\n')
  const guidance = WIDTH_GUIDANCE[resolveMemoryWidth(width)]
  const widthBlock = guidance === undefined
    ? []
    : [...guidance, '']
  return [
    '# Memory',
    '',
    `You have a persistent file-based memory at \`${memoryRoot}/\`. This directory already exists. Write files into it directly with the Write tool. Do not run mkdir. Do not check whether the directory exists.`,
    'Each memory is one file holding one fact, with frontmatter:',
    '',
    '```markdown',
    '---',
    'name: <short-kebab-case-slug>',
    'description: <one-line summary — used to decide relevance during recall>',
    'metadata:',
    '  type: user | feedback | project | reference',
    '---',
    '',
    '<the fact. For feedback or project, follow it with **Why:** and **How to apply:** lines.',
    'Link related memories with [[their-name]].>',
    '```',
    '',
    'Link related memories in the body with `[[name]]`. `name` is the other memory\'s `name:` slug. Link often. An unmatched link is not an error. It marks a memory that you can write later.',
    '',
    '## The four types',
    '',
    types,
    '',
    ...LAYERS,
    '',
    ...widthBlock,
    'After you write the file, the host maintains its one-line pointer in `MEMORY.md` automatically. `MEMORY.md` is the index. The host loads it into context each session. One line per memory. It has no frontmatter. Never put memory content there. Never edit it yourself.',
    '',
    'Before you save, check for an existing file that already covers the topic. Update that file. Do not create a duplicate. Delete memories that turned out to be wrong. Convert relative dates to absolute dates.',
    '',
    'Do not save information that only this conversation needs. If the user asks you to remember something that the repository already records, ask what was non-obvious about it. Save that instead.',
    '',
    'Memory records go stale. Before you recommend from a memory, check it. If it names a file path, check that the file exists. If it names a function or flag, grep for it.',
    '',
    '"The memory says X exists" is not the same as "X exists now."',
    '',
    'Use a plan to align on an approach. Use tasks to track progress in the current conversation. Use memory only for information that will still be useful in a future conversation.',
  ].join('\n')
}

/**
 * The width rules for layer 2. Built per call because the slim budget is
 * quoted from the preset, so the prompt can never disagree with the clamp
 * that enforces it. `balanced` adds nothing.
 * @param {ReturnType<typeof memoryWidthPreset>} preset
 * @returns {string[]}
 */
function widthRules(preset) {
  if (preset.width === 'slim') {
    return [
      `- Width is \`slim\`: every body stays under ${preset.bodyCharLimit} characters. An \`edit\` re-supplies the COMPLETE body. Condense rather than accumulate. Drop stale detail instead of appending to it.`,
      '- Prefer `edit` over `write`. If an existing file already covers the topic, fold the new fact into it. Open a new file only when no existing file covers the fact. If one topic now spans several files, merge them into one. Delete the rest.',
    ]
  }
  if (preset.width === 'extended') {
    return [
      '- Width is `extended`: a body may be as long as the fact needs. Split a topic across several files when each fact stands alone.',
    ]
  }
  return []
}

/**
 * Layer 2 — the extraction task protocol for one structured call. It uses the
 * JSON operation plan of design decision D1 instead of a tool-using loop.
 * @param {{manifest: readonly Array<{filename: string, description?: string, type?: string, mtimeMs: number}>, messageCount: number, bodies?: readonly Array<{filename: string, body: string}>, width?: string}} input
 * @returns {string}
 */
export function buildExtractionPrompt(input) {
  const existingMemories = input.manifest.length > 0
    ? `\n\n## Existing memory files\n\n${input.manifest.map((entry) => {
        const parts = [`[${entry.type ?? 'memory'}]`, entry.filename]
        if (typeof entry.description === 'string' && entry.description.length > 0) parts.push(`: ${entry.description}`)
        return `- ${parts.join(' ')}`
      }).join('\n')}\n\nCheck this list before you write. Update an existing file. Do not create a duplicate. An \`edit\` is only safe for a file whose body appears under Recent memory bodies. For any other file on this list, leave the fact for a later pass. Do not reconstruct a body that you cannot see.`
    : '\n\nNo memory files exist yet.'

  const bodies = input.bodies && input.bodies.length > 0
    ? `\n\n## Recent memory bodies\n\n${input.bodies.map((entry) => `### ${entry.filename}\n\n${entry.body}`).join('\n\n')}\n\nWhen you return an \`edit\` operation, supply the COMPLETE new body. Start from these fragments. Each fragment above is a BODY ONLY. The frontmatter is not part of a body. Never repeat it inside a body.`
    : ''

  const width = widthRules(memoryWidthPreset(input.width))

  return [
    `You are the memory extraction pass. Analyze the most recent ~${input.messageCount} messages above. Update the persistent memory files from them.`,
    '',
    'You have no tools. Decide everything from the messages above and the memory listing below. Reply with ONE JSON object and nothing else. Do not add a markdown fence. Do not add prose.',
    '',
    '## Output format',
    '',
    '```json',
    '{',
    '  "operations": [',
    '    { "op": "write", "file": "user_role.md", "title": "User role", "hook": "one-line hook",',
    '      "frontmatter": { "name": "user-role", "description": "one-line summary", "type": "user" },',
    '      "body": "full markdown body" },',
    '    { "op": "edit", "file": "project_foo.md", "title": "Project Foo", "hook": "one-line hook",',
    '      "frontmatter": { "name": "project-foo", "description": "one-line summary", "type": "project" },',
    '      "body": "the COMPLETE new body, not a diff" },',
    '    { "op": "delete", "file": "stale_thing.md" }',
    '  ]',
    '}',
    '```',
    '',
    'Hard rules:',
    '- `file` is a bare file name. It cannot contain a directory, `..`, or an absolute path. It must end in `.md`. `MEMORY.md` is never a target.',
    `- Keep the always-on layer to one file per type. Every \`feedback\` rule belongs in \`${ALWAYS_ON_FILE}\`. Fold it into that file's complete body. Do not open a second file. A new \`user\` fact extends the existing user file. Do not create another user file.`,
    '- Save only long-term, reusable facts. Reject one-off task details, one-time dates/people/versions, unconfirmed speculation, and anything git or AGENTS.md already records. Never save credentials, tokens, cookies, passwords, or customer-private data.',
    '- Keep scope minimal: a stable every-turn rule belongs in `user`/`feedback` (feedback in how_to_work.md); everything else is `project`/`reference`. Do not promote a topic-specific fact into the always-on layer.',
    '- `type` is exactly one of `user`, `feedback`, `project`, `reference`.',
    '- `hook` is at most 150 characters. It is an index line, not memory content.',
    '- The host maintains `MEMORY.md` itself. Do not emit index operations.',
    '- An `edit` replaces the whole file. Its `body` must be complete. A `body` never contains frontmatter. The host writes `name`, `description`, and `metadata` itself.',
    '- An `edit` is only allowed for a file whose body appears under Recent memory bodies. Do not rewrite a file that appears only in the manifest. Leave that fact for a later pass.',
    ...width,
    '- If nothing is worth saving, reply with `{"operations":[]}` and nothing else.',
    '',
    'Only use content from the messages above. Do not ask for more context. Do not assume anything you were not told.',
    'If the user explicitly asked you to remember something, save it immediately. Use whichever type fits best. If the user asked you to forget something, emit a `delete` for it.',
    'Apply the memory types, the what-not-to-save criteria, and the frontmatter format from the Memory section of your system prompt. That section is already in your context.',
    existingMemories,
    ...(bodies === '' ? [] : [bodies]),
  ].join('\n')
}
