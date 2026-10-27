# dsh-command-guard

DeepSeek Harness (dsh) plugin: **it reviews shell commands issued by the agent and, for risky ones, shows this plugin's own "command review" approval card** (styled like the sandbox-block warning). The command only runs when the user allows it; a rejection is reported back to the agent. It neither silently allows unconfirmed risky commands nor hard-blocks them by default.

The review **mode** is switchable from the UI:

| Mode | Decision source | Asks for confirmation |
|---|---|---|
| `rules` (default) | Built-in / configured **hard-rule engine** | rule hits at or above `askMinLevel` (default `high`) |
| `agent-very-loose` | **Agent self-review** (the LLM evaluates the command) | only when the agent says `critical` |
| `agent-loose` | same | `high` and above |
| `agent-standard` | same | `medium` and above |
| `agent-strict` | same | `low` and above (any doubt asks) |

The card itself (styling, buttons, input box, `guard-review` takeover) is **implemented entirely inside this plugin's client bundle** (`GuardApprovalCard`). The host pushes the question through the harness `userQuestions` seam, so no dsh source change is needed:

- Warning style matches the sandbox block; `reason` / `detail` contain the **command preview** and the **decision explanation** (agent modes also include the model's **purpose** and **possible impact**).
- One click on the bottom-right button decides; an **input box** sits to its left: when empty the button says **Reject**; once you type something it turns into **Submit** — clicking rejects *and* feeds your text back to the agent as `用户希望：…` (`the user wants: …`) so it can adjust the command.
- When the custom card cannot be shown (no UI provider, non-live-root agent / subagent, cancellation, exceptions) it **falls back to the harness approval seam** (native approval box or the approval policy). Unconfirmed risky commands are never let through.

> History note: early versions wrote the session mode into the harness session log via
> `agent.session.append("command-guard/mode", …)`. Custom event types are not in the harness's
> frozen event vocabulary, which made the whole session log fail to reload (`SessionFormatUnsupportedError`)
> or be refused by migration (**dsh v0.1.5+ rejects unknown historical events even with
> `ignorable: true`**). Affected session logs must be cleaned with
> `tools/repair-session-logs.mjs` (see "dsh v0.1.5 session format migration and history repair").
> The current mode is kept in the plugin's own storage and the card goes through `userQuestions`
> (question interactions do not write session events), so the harness session log is never touched.

## Behavior overview

- **Extremely dangerous rule hits** (root deletion, disk formatting, disabling security): ask by default; `directDeny` turns this into a hard reject (no card) for unattended setups.
- **High-risk rule hits** (`rules` mode: ordinary deletion, destructive git, `Invoke-Expression`, …): ask.
- **Whitelisted / no rule hit**: allowed (the whitelist can never override a rule decision).
- **Agent modes**: rules still apply first for two cases — whitelist allow, and extremely dangerous hits (subject to `directDeny`); everything else goes to agent self-review.
- Every question **blocks the tool call** until decided: allow → run; reject → the agent gets the reason (plus `用户希望：…` when text was entered).
- When the card is unavailable (subagent, no UI, aborted call) the approval seam handles it; risky commands are never silently allowed.

## Install and UI entry points

1. Install (example: the `web` profile):

   ```sh
   dsh plugin --profile web add link:G:\dsh-dev\plugins\dsh-command-guard
   ```

   If pnpm is not on PATH, use corepack:

   ```sh
   cd ~/.dsh/profiles/web
   corepack pnpm add link:G:\dsh-dev\plugins\dsh-command-guard
   ```

2. Add the entry to `~/.dsh/profiles/web/cordis.patch.yml` (the profile user patch layer):

   ```yaml
   - insert:
       - id: command-guard
         name: 'dsh-command-guard'
   ```

   Since 1.2.2 the plugin declares a bundle (`dsh.bundle.patch`), so installing it as a profile
   bundle from the plugin tab adds this row automatically — the manual insert is only needed for
   older profiles or manual installs.

3. Restart the profile (both host logic and client UI must be reloaded):

   ```sh
   dsh web
   ```

UI entry points (the client bundle ships with the package):

- **Toolbar button**: a persistent shield "command review" button next to the permission selector (icon only, no extra width). Clicking expands the five modes upward; picking one switches the current session's mode. The icon's **color and glyph** encode the mode (`rules` = blue letter R; agent modes get progressively deeper points 1–4), and hovering shows the full name. Opening the menu does **not** write anything to the session.
- **Slash command `/guard`**: select `/guard` from the `/` menu or type it and press Enter; with an argument, `/guard agent-standard` switches directly.
- **Default mode (new sessions)**: registered on the host through the settings namespace `commandGuard` (see `src/index.ts`), readable/editable from dsh settings; falls back to `config.mode` in `cordis.patch.yml` when settings are unavailable. The toolbar button only **reads** it to display the default.

## dsh client compatibility (v0.1.2 / v0.1.5 / 0.2.0 / 0.2.1)

dsh v0.1.2 introduced `dsh-client-modules` (boot graph + module table); v0.1.5, 0.2.0 and 0.2.1 use the same mechanism.

- **Platform seed**: v0.1.2 exposes `react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`; v0.1.5+ adds `react-dom/client` and `@deepseek-ai/dsh-client-ui-dockkit` (a backward-compatible superset). Third-party client bundles may only require seed words; requiring the removed `@deepseek-ai/dsh-client-runtime/client` breaks client loading ("missed the module table … build-time externals drift").
- **Bundle protocol**: `window.__ModuleLoader__.load({ id, factory })` is identical across versions; this plugin's `client/client.js` works everywhere (it only requires `react`).
- **Client contracts**:

  | Contract | v0.1.2 | v0.1.5 | v0.2.0 / 0.2.1 |
  |---|---|---|---|
  | `commandUi` (`decorate` + `kind: "popupSelect"`) | ✓ | ✓ | ✓ |
  | `conversation.composer` (chain, first non-null by ascending priority) | ✓ | ✓ | ✓ |
  | `conversation.input.left` (`inject: (sessionId) => …`) | ✓ | ✓ | ✓ |
  | `sessions.binding(id)?.session` / `session.command()` | ✓ | ✓ | ✓ |
  | Settings read `settingsScope.describe()` | ✓ | ✓ | **`configForms.describe()`** (same shape; old name kept as fallback) |

- **Approval card**: takes over `intent.kind === "guard-review"` pending questions through the `conversation.composer` slot (duck-typed, no official implementation import). Both 0.1.x and 0.2.x keep the one-click allow/reject and the "submit with text" behavior. 0.2.0 elects by ascending priority and this plugin uses `priority: -20`, so **no composer-yield patch is needed on 0.2.x**; on 0.1.x run `tools/patch-dsh-composer-guard-review.mjs`.
- **Host contracts**:

  | Contract | v0.1.2 | v0.1.5 | v0.2.0 / 0.2.1 |
  |---|---|---|---|
  | `tools/pre-execute` waterfall (`exec = {name, arguments, agent?}`) | ✓ | ✓ | ✓ |
  | `ctx.userQuestions.ask` (`intent.kind` has no whitelist; `approve`/`detail` validated) | ✓ | ✓ | ✓ |
  | `commands.register({name, description, input:{hint}, handler})` | ✓ | ✓ | ✓ |
  | `settings.register(ns, schema, {base})` | ✓ | ✓ | **removed** (`SettingsForms`; forms derive from the plugin `Config`) |

- **peerDependencies check**: dsh validates every `@deepseek-ai/dsh*` peer with
  `semver.satisfies(runtime, range, {includePrerelease:true})`. The caret bound of `^0.1.1-rc.1`
  is `<0.2.0-0`, which does **not** cover `0.2.0-rc.2`, so this plugin uses
  `"^0.1.1-rc.1 || ^0.2.0-rc.1"` (matches 0.1.2 / 0.1.5 / 0.2.0 / 0.2.1).
- **Build**: `client/client.js` is generated from `src/client/client.tsx` by `tsc` +
  `build/bundle-client.mjs`; do not edit the artifacts by hand.

## "Help me approve" preset (guarded)

Codex-style **"help me approve (only prompt for detected risky operations)"**: dsh has no built-in
"full file access + ask only for risky commands" preset — `danger-full-access` bundles
`approval: never`, and `workspace-write` bundles `approval: ask` with limited file access. The fix
is a **custom permission preset** in `cordis.patch.yml`:

```yaml
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
        name: 只读
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: 工作区写
      guarded:
        sandbox: danger-full-access
        approval: ask
        name: 帮我审核
        description: Full access + automatic command review; only detected risky commands ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: 完整权限
```

Since 1.2.2 this override ships **inside the plugin bundle patch**, so installing the plugin adds
the `guarded` preset automatically (the override replaces the whole preset table, hence all four
entries are restated).

## Configuration

Override through the `config` of the plugin entry in `cordis.patch.yml`:

```yaml
- insert:
    - id: command-guard
      name: 'dsh-command-guard'
      config:
        enabled: true
        tools: [ pwsh, bash ]
        mode: agent-standard
        directDeny: false
        denyMinLevel: critical
        askMinLevel: high
        agentFallback: rules
        logDecisions: true
        maxCommandPreviewBytes: 300
        allowCommands: [ '^npm\s+run\b' ]
        disabledRuleIds: [ rmdir-empty ]
        rules:
          - id: my-danger
            level: high
            pattern: '\bRemove-SomethingDangerous\b'
            description: custom dangerous command
            hint: custom hint
        llm:
          enabled: false
          timeoutMs: 15000
          allowOnFailure: true
```

| Key | Meaning |
|---|---|
| `enabled` | Master switch |
| `tools` | Which tools are reviewed |
| `mode` | Default mode for new sessions |
| `directDeny` / `denyMinLevel` | Hard reject instead of asking, at or above the level |
| `askMinLevel` | Lowest risk that triggers the card in `rules` mode |
| `agentFallback` | Behavior when agent self-review is unavailable |
| `logDecisions` / `maxCommandPreviewBytes` | Decision logging |
| `allowCommands` | Extra whitelist regexes (cannot override rules) |
| `disabledRuleIds` / `rules` | Disable or extend rules |
| `llm` | Legacy LLM fallback for `rules` mode only |

## Session mode persistence and branch inheritance

- The mode is stored **outside** the harness session log:
  `~/.dsh/command-guard/session-modes.json` (`$DSH_HOME/command-guard/session-modes.json`),
  written atomically (tmp + rename), pruned by TTL (90 days) and a 2000-entry cap.
- Resolution order: **this session's record → parent session (`session.header.parentSession`,
  for forked branches) → default mode**.
- A fork created from a session inherits that session's mode at creation time.
- The file is plugin-owned: it never writes harness session events, so it cannot reproduce the
  "custom event breaks the session log" incident.

## How the client reads the real mode (zero polling, zero session events)

| Channel | Path | Purpose |
|---|---|---|
| Query | `GET /api/command-guard/session-mode?sessionId=…` | read once on entering a session; returns the resolved `this session → parent → default` mode |
| Push | `GET /api/command-guard/events` (**SSE**) | after `/guard <mode>` the host pushes `{sessionId, mode}` immediately, so the icon updates in real time |

- The localStorage cache (per session, 12 h TTL) is only for first paint; **the host is authoritative**.
- Switching from the icon menu updates locally and writes the cache; no query is issued.
- Neither channel writes session events.

## Why not polling / typert / connection RPC (measured on dsh 0.2.0-rc.2)

- `connection.register(...)` **does not exist**; the correct entry `connection.rpc.handle(...)`
  internally registers a route through `owner.webServer` and throws
  `cannot get property "webServer" without inject` (no official plugin uses that API);
  `connection.rpc.intercept` only accepts `/api`, which `api-gateway` already owns.
- The `/plugins/*` prefix is occupied by `dsh-client-modules` (GET/HEAD only; other methods get 405).
- **typert**: the host `./typert` manifest passes `typert-loader` validation, but a third-party
  `remote.<namespace>` is never created on the client — `dsh-api-remotes`' `TYPERT_REMOTE` is a
  **build-time static table** of official plugins.
- The forwarded-event allowlist (`API_REMOTE_FORWARDED_EVENTS`) is fixed and contains **no command
  events**; `api-session/activity` only fires for user messages.
- Custom session events are **unavailable to third-party plugins** (they make the format migration
  refuse historical sessions).
- **The workable path**: register routes with `webServer.register` under
  **`/api/command-guard/…`** (GET and POST both work — the same pattern as
  `@linxin666/dsh-client-ui-task-board`'s `/api/task-board` and `dsh1024`'s `/dsh1024`), and use SSE
  for push.

## dsh v0.1.5 session format migration and history repair

- v0.1.5+ refuses unknown historical event types during migration, even with `ignorable: true`;
  sessions previously polluted by the old `command-guard/mode` event cannot be opened.
- `node tools/repair-session-logs.mjs` (read-only by default) reports affected sessions;
  `--apply` physically removes the unknown events and renumbers all sequence references.
  Backups are kept as `.pre-repair.bak`; `--undo` restores them.

## Patch scripts (optional)

| Script | Purpose |
|---|---|
| `tools/patch-dsh-permission-glyph.mjs` | adds the shield glyph for the `guarded` preset (dsh versions where glyphs live in `dsh-client-ui-permission-presets`) |
| `tools/patch-dsh-composer-guard-review.mjs` | composer-yield patch, only needed on dsh 0.1.x |
| `tools/patch-dsh-question-intent.mjs` | `question intent` patch, v0.1.1 only |
| `tools/repair-session-logs.mjs` | clean polluted session logs |

Re-run the glyph patch after a dsh upgrade and restart + hard-refresh the browser.

## Upgrade checklist

1. `npm run build` (host + client bundles).
2. dsh upgraded? re-run the glyph patch and check the composer patch (0.1.x only).
3. Restart dsh, hard-refresh the browser.
4. Verify: card opens, `/guard` works, mode icon follows, no new `guard` lines in the session.

## FAQ

- **The card does not appear / the native approval box shows instead?** Check that the client
  bundle is loaded and that the question is a `guard-review`; subagents and non-UI contexts fall
  back to the approval seam by design.
- **The mode icon does not follow after `/guard`?** The SSE channel must be open
  (`GET /api/command-guard/events`); check the browser network panel, then restart dsh and
  hard-refresh.
- **"Help me approve" has no icon?** Re-run `tools/patch-dsh-permission-glyph.mjs` after a dsh upgrade.
- **A whitelisted command is still asked?** Rule decisions outrank the whitelist; adjust
  `askMinLevel` / `denyMinLevel` / `directDeny` or the rule itself.
- **Why did the mode reset after restart?** It should not since 1.2.2 (persisted per session);
  older versions kept it in process memory only.
- **Session history unreadable after an upgrade?** Run `node tools/repair-session-logs.mjs`.

## Changelog

### 1.2.2

- **Session mode persistence and branch inheritance**: the mode is stored in the plugin's own JSON
  (`~/.dsh/command-guard/session-modes.json`) and never touches harness session events; forks
  inherit the parent session's mode.
- **Real-time icon sync (zero polling, zero session events)**: `GET /api/command-guard/session-mode`
  on entering a session; after `/guard <mode>` the host pushes through SSE
  `GET /api/command-guard/events` so the icon updates immediately.
- **Bundle support**: added `dsh.bundle.patch` and packaged `cordis.patch.yml` so the plugin can be
  installed from the plugin tab; default config and the `guarded` permission preset ship with it.
- Client query chain is now typert → `/api` route fallback (typert is not usable for third-party
  plugins, see above).
- Added the English `README.md`.

### 1.2.1

- Adapted to dsh 0.2.0: settings read moved from `settingsScope` to `configForms`;
  `permissionGlyphs` moved to `@deepseek-ai/dsh-client-ui-permission-presets`.
- The approval card renders command details as Markdown.
- New patch scripts: permission glyph, composer review yield.

### 1.1.0

- Self-drawn command review card (takes over the composer `guard-review` slot).
- Shield mode menu in the input area and the `/guard` command decoration.
- Multiple modes (`rules` / `agent-*`) plus `directDeny` hard blocking.

### 1.0.0

- First release: hard-rule command review with an approval card for risky commands.
