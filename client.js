/**
 * dsh-memory — Client half.
 *
 * One surface, drawn here with the host's `--dsw-alias-*` theme tokens; no
 * Harness Client package is imported. The `dsh-memory` row's own page in the
 * Plugins manager is a single `plugins.row.config` entry keyed
 * `@local/dsh-memory#dsh-memory`, carrying two parts:
 *
 *  1. The nine-field form editing the user-facing extraction fields of the
 *     `dsh-memory` Host entry. The page owner supplies `form.state` and
 *     `form.mutate(operations, expectedRevision)` as props, so the card owns
 *     nothing but its staged drafts.
 *  2. The resolved memory roots per session and the memory files themselves,
 *     read-only, below the form.
 *
 * The Plugins page reserves `plugins.item` for its own companion packages
 * (`@deepseek-ai/dsh-client-ui-plugin-manager`'s
 * `lib/types/client/slot-contract.d.ts:134-147` marks it OCCUPIED and names
 * `plugins.bundle.config` / `plugins.row.config` as a bundle's seats), so a
 * third-party bundle registers there and nowhere else. The same contract file
 * adds `plugins.detail.actions`, `plugins.detail.badge` and
 * `plugins.detail.section` (lines 175-199) for a detail page's head, title
 * tags and trailing sections; this card uses none of them and keeps its one
 * surface on the row's page. An earlier build put the status page in
 * `settings.section` and the form in `plugins.item`, which split one subject
 * across two navigations; both now live on the row's page.
 *
 * @module dsh-memory/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    const STATUS_PATH = '/memory/status';
    const FILE_PATH = '/memory/file';

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-memory';

    /**
     * Host plugin entry id this card edits — the `dsh-memory` row of
     * `cordis.patch.yml`, which is also the settings namespace the Host
     * serves (`ctx.configForms.get(entryId)`).
     */
    const CONFIG_NS = 'dsh-memory';

    /**
     * This bundle's package name, as the profile's dependencies declare it.
     * `plugins.row.config` is keyed `<package name>#<row id>`, so the key is
     * this joined with {@link CONFIG_NS}.
     */
    const BUNDLE_NAME = '@local/dsh-memory';

    /**
     * The nine editable fields, in render order. `kind` selects the control
     * and the save semantics:
     * - `boolean` stages an explicit `set` (true/false);
     * - `number` stages `set(Number)`; an empty draft stages `unset`;
     * - `text` stages `set(trimmed)`; an empty draft stages `unset`;
     * - `choice` stages `set(value)` from its `options` — a closed set, so
     *   there is no free text to validate and nothing to unset.
     *
     * `memoryWidth` leads: it is the one field that shapes every memory the
     * plugin writes, not just when extraction runs.
     */
    const CONFIG_FIELDS = [
      {
        field: 'memoryWidth',
        kind: 'choice',
        label: 'labelMemoryWidth',
        hint: 'memoryWidthHint',
        options: [
          { value: 'extended', label: 'widthExtended' },
          { value: 'balanced', label: 'widthBalanced' },
          { value: 'slim', label: 'widthSlim' },
        ],
      },
      { field: 'extractionEnabled', kind: 'boolean', label: 'labelExtractionEnabled' },
      { field: 'minUserChars', kind: 'number', label: 'labelMinUserChars', hint: 'minUserCharsHint' },
      { field: 'minCjkChars', kind: 'number', label: 'labelMinCjkChars', hint: 'minCjkCharsHint' },
      { field: 'extractionMinTurns', kind: 'number', label: 'labelExtractionMinTurns', hint: 'extractionMinTurnsHint' },
      { field: 'extractionMinSteps', kind: 'number', label: 'labelExtractionMinSteps', hint: 'extractionMinStepsHint' },
      { field: 'includeSubagents', kind: 'boolean', label: 'labelIncludeSubagents' },
      { field: 'recentBodiesInPrompt', kind: 'number', label: 'labelRecentBodiesInPrompt', hint: 'recentBodiesHint' },
      { field: 'model', kind: 'text', label: 'labelModel', hint: 'modelHint' },
    ];

    /**
     * Page copy. Registered on the shared locale service so the settings nav
     * label and every string below follow the active language; `{name}`
     * placeholders are filled by `t(key, params)`.
     */
    const DICTIONARIES = {
      en: {
        title: 'Memory',
        renderFailed: 'Memory settings failed to render.',
        loading: 'Loading memory status…',
        statusReadFailed: 'Could not read memory status: {error}',
        enabled: 'Enabled',
        statusTitle: 'Memory status',
        storageRoot: 'Storage root',
        tuningHint: 'The remaining keys — index limits, storage root, sub-agent scopes — are edited in the plugin configuration file.',
        noSessions: 'No session has a memory root yet. Ask the agent to remember something, or run a turn.',
        sessionMemory: 'Session memory',
        memoryRoot: 'Memory root',
        memoryFiles: 'Memory files',
        indexLines: 'Index lines',
        lastWrite: 'Last write',
        noFiles: 'No memory files yet.',
        showFiles: 'Show {count} memory file(s)',
        updated: 'updated {time}',
        openFailed: 'failed: {error}',
        unavailable: '(unavailable)',
        yes: 'yes',
        no: 'no',
        configSummary: 'Memory width, extraction trigger thresholds, scope and model.',
        labelMemoryWidth: 'Memory width',
        widthExtended: 'Extended',
        widthBalanced: 'Balanced',
        widthSlim: 'Slim',
        memoryWidthHint: 'How long and how detailed each memory may be. Slim caps every body at 800 characters and folds new facts into existing files; extended allows long bodies and splitting a topic across files.',
        labelExtractionEnabled: 'Auto extraction',
        labelMinUserChars: 'Trigger threshold · English',
        labelMinCjkChars: 'Trigger threshold · Chinese',
        labelExtractionMinTurns: 'Extraction start · turns',
        labelExtractionMinSteps: 'Extraction start · steps',
        labelIncludeSubagents: 'Extract sub-agent sessions',
        labelRecentBodiesInPrompt: 'Recent memory entries',
        labelModel: 'Extraction model',
        minUserCharsHint: 'Minimum English characters in one user turn before extraction runs.',
        minCjkCharsHint: 'Minimum CJK characters in one user turn before extraction runs.',
        extractionMinTurnsHint: 'Minimum closed turns a session needs before extraction starts — the turn count on the session-statistics panel. 0 disables this half of the gate.',
        extractionMinStepsHint: 'Minimum closed steps a session needs before extraction starts — the step count on the session-statistics panel. 0 disables this half of the gate.',
        recentBodiesHint: 'How many recent memory bodies the extraction prompt sees. Each one is a whole body, so this is the main driver of an extraction call\'s size — lower it if extraction feels expensive.',
        modelHint: 'Leave empty to follow the session model.',
        modelEmpty: 'follow session',
        unsaved: 'unsaved edit',
        formLoading: 'Loading plugin configuration…',
        formUnavailable: 'Plugin configuration is not available in this session.',
        formReadOnly: 'This browser keeps settings in memory only, so editing is disabled.',
        invalidNumber: 'Enter a number, or leave the field empty to inherit the default.',
        save: 'Save',
        discard: 'Discard',
        saving: 'Saving…',
        saveFailed: 'The save was refused. Your edits are kept — try again.',
        effectiveNote: 'Every field is read per operation, so a saved value takes effect on the next turn.',
      },
      zh: {
        title: '记忆',
        renderFailed: '记忆设置页渲染失败。',
        loading: '正在加载记忆状态…',
        statusReadFailed: '无法读取记忆状态：{error}',
        enabled: '已启用',
        statusTitle: '记忆状态',
        storageRoot: '存储根目录',
        tuningHint: '其余配置项（索引上限、存储根目录、子代理作用域等）请在插件配置文件中调整。',
        noSessions: '还没有任何会话拥有记忆目录。让助手记住点什么，或者先跑一轮对话。',
        sessionMemory: '会话记忆',
        memoryRoot: '记忆目录',
        memoryFiles: '记忆文件',
        indexLines: '索引行数',
        lastWrite: '最近写入',
        noFiles: '还没有记忆文件。',
        showFiles: '展开 {count} 个记忆文件',
        updated: '更新于 {time}',
        openFailed: '失败：{error}',
        unavailable: '（不可用）',
        yes: '是',
        no: '否',
        configSummary: '记忆宽度、抽取触发阈值、范围与模型。',
        labelMemoryWidth: '记忆宽度',
        widthExtended: '扩展型',
        widthBalanced: '均衡型',
        widthSlim: '简洁型',
        memoryWidthHint: '决定每条记忆能写多长、多细。简洁型把每条正文限制在 800 字符以内，并优先把新事实并入已有记忆；扩展型允许长正文，也允许把主题拆成多个文件。',
        labelExtractionEnabled: '自动抽取',
        labelMinUserChars: '触发阈值·英文',
        labelMinCjkChars: '触发阈值·中文',
        labelExtractionMinTurns: '抽取起点·轮数',
        labelExtractionMinSteps: '抽取起点·步数',
        labelIncludeSubagents: '抽取子代理会话',
        labelRecentBodiesInPrompt: '近期记忆条数',
        labelModel: '抽取所用模型',
        minUserCharsHint: '一轮用户消息中的英文字符数达到该值才触发抽取。',
        minCjkCharsHint: '一轮用户消息中的中文字符数达到该值才触发抽取。',
        extractionMinTurnsHint: '会话累计到这么多"轮"（与"会话统计"面板一致）之后才开始抽取；填 0 关闭这一半限制。',
        extractionMinStepsHint: '会话累计到这么多"步"（与"会话统计"面板一致）之后才开始抽取；填 0 关闭这一半限制。',
        recentBodiesHint: '抽取提示词可见的近期记忆条数。每条都是完整正文，是抽取调用体积的主要来源——觉得抽取贵就调小。',
        modelHint: '留空 = 跟随会话模型。',
        modelEmpty: '跟随会话',
        unsaved: '有未保存修改',
        formLoading: '正在加载插件配置…',
        formUnavailable: '当前会话不提供插件配置。',
        formReadOnly: '当前浏览器仅在内存中保留设置，无法编辑。',
        invalidNumber: '请输入数字，或留空继承默认值。',
        save: '保存',
        discard: '放弃',
        saving: '保存中…',
        saveFailed: '保存被拒绝。已保留你的修改——请重试。',
        effectiveNote: '所有字段均在每次操作时读取，保存后下一轮即生效。',
      },
    };

    /**
     * Resolved translator. Rebound when the plugin applies, and the slot
     * re-registers on a locale change, so components read the active language
     * at render time.
     * @type {(key: string, params?: Record<string, string | number>) => string}
     */
    let translate = (key) => key;

    const cardStyle = {
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 8,
      padding: 16,
      marginBottom: 12,
    };
    const titleStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 15,
      fontWeight: 600,
      margin: '0 0 8px',
    };
    const labelStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 };
    const valueStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: 13 };
    const monoStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      wordBreak: 'break-all',
    };
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid transparent',
      cursor: 'pointer',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      textAlign: 'left',
      width: '100%',
    };
    const preStyle = {
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 6,
      padding: 12,
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 320,
      overflow: 'auto',
      margin: '8px 0 0',
    };

    /** Config-card controls: inputs, switch, and buttons — all token-styled. */
    const inputStyle = {
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 6,
      padding: '6px 8px',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      width: '100%',
      boxSizing: 'border-box',
    };
    const disabledInputStyle = {
      background: 'var(--dsw-alias-bg-layer-3)',
      color: 'var(--dsw-alias-label-tertiary)',
      cursor: 'default',
    };
    const switchTrackStyle = {
      position: 'relative',
      width: 36,
      height: 20,
      borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-l2)',
      padding: 0,
      flexShrink: 0,
      transition: 'background 120ms ease, border-color 120ms ease',
    };
    const switchKnobStyle = {
      position: 'absolute',
      top: 2,
      left: 2,
      width: 14,
      height: 14,
      borderRadius: 7,
      transition: 'transform 120ms ease',
    };
    const buttonStyle = {
      borderRadius: 6,
      padding: '6px 14px',
      fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)',
      cursor: 'pointer',
    };
    const primaryButtonStyle = {
      background: 'var(--dsw-alias-state-business-primary)',
      color: 'var(--dsw-alias-label-primary-foreground)',
      borderColor: 'var(--dsw-alias-state-business-primary)',
    };
    const ghostButtonStyle = {
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
    };
    const disabledButtonStyle = {
      background: 'var(--dsw-alias-bg-layer-3)',
      color: 'var(--dsw-alias-label-tertiary)',
      borderColor: 'var(--dsw-alias-border-l1)',
      cursor: 'default',
    };

    /** Contains a render failure so one broken view never blanks the slot. */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { style: { ...cardStyle, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } },
            translate('renderFailed'));
        }
        return this.props.children;
      }
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
      try {
        return new Date(ms).toLocaleString();
      } catch {
        return '—';
      }
    }

    /** A stored value as the control's text; the empty string when absent. */
    function formatFieldValue(value, kind) {
      if (kind === 'boolean') return value === true;
      if (kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
      // A choice with no stored value shows the schema default, so the control
      // always reflects the width actually in force rather than an empty
      // selection that looks like "off".
      if (kind === 'choice') return typeof value === 'string' && value.length > 0 ? value : 'balanced';
      return typeof value === 'string' ? value : '';
    }

    function MemorySettingsPage() {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      const [open, setOpen] = useState(null);

      const load = useCallback(async () => {
        try {
          const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`status ${response.status}`);
          const body = await response.json();
          setStatus(body);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const openFile = useCallback(async (sessionId, file) => {
        try {
          const response = await fetch(`${FILE_PATH}?session=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(file)}`);
          const body = await response.json();
          setOpen({ sessionId, file, content: body.content ?? body.message ?? translate('unavailable'), updatedAt: body.updatedAt });
        } catch (cause) {
          setOpen({ sessionId, file, content: translate('openFailed', { error: cause instanceof Error ? cause.message : String(cause) }) });
        }
      }, []);

      if (error !== null) {
        return h('div', { style: cardStyle },
          h('div', { style: titleStyle }, translate('title')),
          h('div', { style: { ...valueStyle, color: 'var(--dsw-alias-state-error-primary)' } },
            translate('statusReadFailed', { error })));
      }
      if (status === null) {
        return h('div', { style: cardStyle }, h('div', { style: labelStyle }, translate('loading')));
      }

      const agents = status.agents ?? [];
      return h('div', null,
        // Only what the form above cannot already tell you. Auto-extraction
        // and the session count were dropped: the switch above shows the
        // first and the cards below are the second. `enabled` stays because
        // it reports the plugin's own master switch — one of the ten keys
        // with no control anywhere in the GUI, so this line is the only
        // place its state is visible.
        h('div', { style: cardStyle },
          h('div', { style: titleStyle }, translate('statusTitle')),
          h('div', { style: labelStyle }, translate('enabled')),
          h('div', { style: valueStyle }, status.enabled ? translate('yes') : translate('no')),
          h('div', { style: { ...labelStyle, marginTop: 8 } }, translate('storageRoot')),
          h('div', { style: monoStyle }, status.storageRoot),
          h('div', { style: { ...labelStyle, marginTop: 8 } },
            translate('tuningHint'))));

        agents.length === 0
          ? h('div', { style: { ...cardStyle, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
              translate('noSessions'))
          : agents.map((agent) => h('div', { key: agent.sessionId, style: cardStyle },
              h('div', { style: titleStyle }, translate('sessionMemory')),
              h('div', { style: labelStyle }, translate('memoryRoot')),
              h('div', { style: monoStyle }, agent.rootDir),
              h('div', { style: { display: 'flex', gap: 16, margin: '8px 0' } },
                h('div', null,
                  h('div', { style: labelStyle }, translate('memoryFiles')),
                  h('div', { style: valueStyle }, String(agent.files))),
                h('div', null,
                  h('div', { style: labelStyle }, translate('indexLines')),
                  h('div', { style: valueStyle }, String(agent.indexLines))),
                h('div', null,
                  h('div', { style: labelStyle }, translate('lastWrite')),
                  h('div', { style: valueStyle }, formatTime(agent.lastWriteAt)))),
              h(MemoryFileList, { sessionId: agent.sessionId, files: agent.files ?? [], onOpen: openFile })),

        open !== null
          ? h('div', { style: cardStyle },
              h('div', { style: titleStyle }, open.file),
              h('div', { style: labelStyle }, translate('updated', { time: formatTime(open.updatedAt) })),
              h('pre', { style: preStyle }, open.content))
          : null);
    }

    function MemoryFileList({ sessionId, files, onOpen }) {
      const [expanded, setExpanded] = useState(false);
      if (files.length === 0) {
        return h('div', { style: labelStyle }, translate('noFiles'));
      }
      if (!expanded) {
        return h('button', {
          type: 'button',
          style: { ...rowStyle, borderColor: 'var(--dsw-alias-border-l1)' },
          onClick: () => setExpanded(true),
          'aria-label': translate('showFiles', { count: files.length }),
        }, translate('showFiles', { count: files.length }));
      }
      return h('div', { style: { display: 'grid', gap: 2 } },
        files.map((file) => h('button', {
          key: file,
          style: rowStyle,
          onClick: () => onOpen(sessionId, file),
        }, file)));
    }

    /** A hand-drawn switch: `role="switch"` with `aria-checked`, token colors. */
    function SwitchControl({ checked, disabled, label, onToggle }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: onToggle,
        style: {
          ...switchTrackStyle,
          background: checked ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-3)',
          borderColor: checked ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        },
      }, h('span', {
        style: {
          ...switchKnobStyle,
          background: 'var(--dsw-alias-label-primary-foreground)',
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
        },
      }));
    }

    /** One field row: label, control, hint, and an unsaved-edit marker. */
    function ConfigFieldRow({ spec, drafts, values, tr, disabled, onEdit }) {
      const draft = drafts[spec.field];
      const value = values[spec.field];
      const shown = draft !== undefined
        ? (spec.kind === 'boolean' ? draft.value === true : spec.kind === 'choice' ? draft.value : draft.text)
        : formatFieldValue(value, spec.kind);
      // A number field holding text that is not a number: the card already
      // refuses the save, and without this line the control just greys out
      // with no explanation.
      const badNumber = spec.kind === 'number' && typeof shown === 'string'
        && shown.trim() !== '' && !Number.isFinite(Number(shown));
      return h('div', { style: { display: 'grid', gap: 4 } },
        h('div', { style: labelStyle }, tr(spec.label)),
        spec.kind === 'boolean'
          ? h(SwitchControl, {
              checked: shown === true,
              disabled,
              label: tr(spec.label),
              onToggle: () => onEdit(spec.field, { value: shown !== true }),
            })
          : spec.kind === 'choice'
            ? h('div', { style: { display: 'flex', gap: 6 } },
                spec.options.map((option) => h('button', {
                  key: option.value,
                  type: 'button',
                  disabled,
                  'aria-pressed': shown === option.value ? 'true' : 'false',
                  onClick: () => onEdit(spec.field, { value: option.value }),
                  style: {
                    ...buttonStyle,
                    flex: 1,
                    ...(shown === option.value ? primaryButtonStyle : ghostButtonStyle),
                    ...(disabled ? disabledButtonStyle : null),
                  },
                }, tr(option.label))))
          : h('input', {
              type: spec.kind === 'number' ? 'number' : 'text',
              value: shown,
              disabled,
              placeholder: spec.kind === 'text' ? tr('modelEmpty') : '',
              onChange: (event) => onEdit(spec.field, { text: event.target.value }),
              style: { ...inputStyle, ...(disabled ? disabledInputStyle : null) },
              'aria-label': tr(spec.label),
            }),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          spec.hint !== undefined ? h('div', { style: labelStyle }, tr(spec.hint)) : null,
          draft !== undefined
            ? h('div', { style: { ...labelStyle, color: 'var(--dsw-alias-state-warn-primary)' } }, tr('unsaved'))
            : null),
        badNumber
          ? h('div', { style: { ...labelStyle, color: 'var(--dsw-alias-state-error-primary)' } }, tr('invalidNumber'))
          : null);
    }

    /**
     * The row's configuration card. The Plugins page owner hands it
     * `form.state` (accepted values, revision, writability) and
     * `form.mutate(operations, expectedRevision)` as props — the card owns
     * nothing but its staged drafts, so there is no second subscription to
     * the settings namespace and no reimplementation of the revision fence
     * (cookbook: live configuration forms, §3).
     *
     * `view: 'summary'` is the one-liner the row falls back to when it has
     * no display description; `view: 'page'` is the form with its save
     * control. Every degraded state renders a disabled explanation instead of
     * throwing.
     */
    function MemoryConfigCard(props) {
      const tr = typeof props.t === 'function' ? props.t : translate;
      const form = props.form;
      const snapshot = form === undefined || form === null ? undefined : form.state;
      const [drafts, setDrafts] = useState({});
      const [saving, setSaving] = useState(false);
      const [failed, setFailed] = useState(false);
      /** Revision read when the first draft was staged; the save fence. */
      const editRevision = useRef(undefined);

      if (props.view === 'summary') return tr('configSummary');
      if (form === undefined || form === null || snapshot === undefined) {
        return h('div', { style: cardStyle }, h('div', { style: labelStyle }, tr('formUnavailable')));
      }
      if (snapshot.status === 'loading') {
        return h('div', { style: cardStyle }, h('div', { style: labelStyle }, tr('formLoading')));
      }

      const readOnly = snapshot.status === 'unavailable' || snapshot.writable !== true;
      const section = snapshot.value;
      const values = {};
      if (section !== undefined && section !== null && typeof section === 'object') {
        for (const spec of CONFIG_FIELDS) values[spec.field] = section[spec.field];
      }
      const dirty = Object.keys(drafts).length > 0;
      const invalid = Object.entries(drafts).some(([field, draft]) => CONFIG_FIELDS.some((spec) => spec.field === field && spec.kind === 'number')
        && typeof draft.text === 'string' && draft.text.trim() !== '' && !Number.isFinite(Number(draft.text)));
      const canSave = !readOnly && dirty && !invalid && !saving && snapshot.revision !== undefined;

      const edit = (field, draft) => {
        if (editRevision.current === undefined) editRevision.current = snapshot.revision;
        setDrafts((current) => ({ ...current, [field]: draft }));
        setFailed(false);
      };

      const discard = () => {
        editRevision.current = undefined;
        setDrafts({});
        setFailed(false);
      };

      const save = async () => {
        if (saving) return;
        const ops = [];
        for (const spec of CONFIG_FIELDS) {
          const draft = drafts[spec.field];
          if (draft === undefined) continue;
          if (spec.kind === 'boolean') {
            ops.push({ op: 'set', path: [spec.field], value: draft.value === true });
          } else if (spec.kind === 'choice') {
            // A closed set: the staged value is already one of the options, so
            // there is nothing to trim and no empty state to unset.
            ops.push({ op: 'set', path: [spec.field], value: draft.value });
          } else if (typeof draft.text === 'string' && draft.text.trim() === '') {
            ops.push({ op: 'unset', path: [spec.field] });
          } else if (spec.kind === 'number') {
            ops.push({ op: 'set', path: [spec.field], value: Number(draft.text.trim()) });
          } else {
            ops.push({ op: 'set', path: [spec.field], value: draft.text.trim() });
          }
        }
        if (ops.length === 0) return;
        setSaving(true);
        setFailed(false);
        let accepted = false;
        try {
          accepted = await form.mutate(ops, editRevision.current) === true;
        } catch (error) {
          accepted = false;
        }
        setSaving(false);
        if (accepted) {
          editRevision.current = undefined;
          setDrafts({});
        } else {
          setFailed(true);
        }
      };

      return h('div', null,
        h('div', { style: cardStyle },
          readOnly
            ? h('div', { style: { ...labelStyle, marginBottom: 8 } },
                tr(snapshot.status === 'unavailable' ? 'formUnavailable' : 'formReadOnly'))
            : null,
          h('div', { style: { display: 'grid', gap: 12 } },
            CONFIG_FIELDS.map((spec) => h(ConfigFieldRow, {
              key: spec.field,
              spec,
              drafts,
              values,
              tr,
              disabled: readOnly || saving,
              onEdit: edit,
            }))),
          failed
            ? h('div', { style: { ...labelStyle, color: 'var(--dsw-alias-state-error-primary)', marginTop: 8 } },
                tr('saveFailed'))
            : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' } },
            h('button', {
              type: 'button',
              disabled: !canSave,
              onClick: () => { if (canSave) void save(); },
              style: { ...buttonStyle, ...(canSave ? primaryButtonStyle : disabledButtonStyle) },
            }, saving ? tr('saving') : tr('save')),
            h('button', {
              type: 'button',
              disabled: !dirty || saving,
              onClick: discard,
              style: { ...buttonStyle, ...(dirty && !saving ? ghostButtonStyle : disabledButtonStyle) },
            }, tr('discard'))),
          h('div', { style: { ...labelStyle, marginTop: 8 } }, tr('effectiveNote'))),

        // The memory status and file browser, in the same page rather than a
        // plugins.detail.section contribution: that slot exists for a plugin
        // with something to say about a page it does not own, and this page is
        // this plugin's own.
        h(MemorySettingsPage, null));
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        translate = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-memory: dictionaries');

        // The row's configuration cell. It exists only while the Host serves
        // the namespace (whileServed), so a deployment without the entry shows
        // no trace of it. What the card renders is the owner's: `form.state`
        // and `form.mutate` arrive as props, so this registration passes no
        // inject face of its own.
        ctx.effect(() => ctx.configForms.whileServed([CONFIG_NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: `${BUNDLE_NAME}#${CONFIG_NS}`,
        }, (props) => h(ErrorBoundary, null, h(MemoryConfigCard, props))))), 'dsh-memory: row configuration');
      },
    };
  },
});
