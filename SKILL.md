---
name: codex-to-im
description: |
  Optional Codex integration for the codex-to-im local app. Use only when the
  user wants to open codex-to-im from Codex or enter the Feishu session-sharing
  flow. Do not use this skill as the main setup, config, logs, or daemon
  management path.
argument-hint: "open | share-feishu"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Codex-to-IM Optional Integration

`codex-to-im` is a standalone local app with a background bridge and web workbench.

This optional integration is intentionally thin. It exists only for two actions:

- `open`
- `share-feishu`

If the user asks to configure channels, start or stop the bridge, inspect logs, or diagnose issues, do not treat this integration as the main workflow. Open the local app instead.

## Resolve the repo / install root

Prefer these locations:

- `~/.codex/skills/codex-to-im`
- `~/.claude/skills/codex-to-im`

If neither exists, fall back to globbing `**/skills/**/codex-to-im/SKILL.md` and derive the root from that match.

## Command mapping

Map user intent to one of these two actions:

| User says | Action |
|---|---|
| `open codex-to-im`, `打开 codex-to-im`, `open bridge workbench`, `打开工作台` | `open` |
| `share current session to feishu`, `共享当前会话到飞书`, `把当前会话发到飞书`, `open feishu handoff` | `share-feishu` |

## Execution

### `open`

Prefer:

```bash
codex-to-im open
```

If the `codex-to-im` command is unavailable, fall back to:

```bash
node dist/cli.mjs open
```

Run from the repo / install root.

### `share-feishu`

Prefer:

```bash
codex-to-im share-feishu
```

If the `codex-to-im` command is unavailable, fall back to:

```bash
node dist/cli.mjs share-feishu
```

Run from the repo / install root.

After opening the workbench, tell the user to use the desktop sessions panel or the IM binding panel to finish binding the target thread to Feishu.
