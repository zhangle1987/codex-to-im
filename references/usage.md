# Optional Codex Integration Usage

This repository no longer uses a full bridge-management skill as its primary workflow.

The main product is the local `codex-to-im` app and web workbench.

`SKILL.md` is only an optional Codex integration entry with two actions:

- `open`
- `share-feishu`

## open

Open the local `codex-to-im` workbench.

Preferred command:

```bash
codex-to-im open
```

Fallback:

```bash
node dist/cli.mjs open
```

## share-feishu

Open the Feishu handoff flow for the current workflow.

Preferred command:

```bash
codex-to-im share-feishu
```

Fallback:

```bash
node dist/cli.mjs share-feishu
```

## Non-goals

If the user asks to configure credentials, start or stop the bridge, inspect logs, or diagnose problems, do not route them through the optional Codex integration. Open the local app instead.
