# Codex-to-IM

`codex-to-im` is a local bridge app that connects Codex desktop sessions to IM channels such as Feishu/Lark and Weixin.

The product is no longer centered around a Codex skill. The main path is:

1. Install `codex-to-im`
2. Open the local web workbench
3. Configure IM channels
4. Start the bridge in the background
5. Bind real desktop Codex threads to Feishu or Weixin chats

`SKILL.md` is still kept in the repo, but only as an optional Codex integration entry.

## Project Origin

The current codebase is a consolidated continuation of two earlier repositories:

- `Claude-to-IM`
- `Claude-to-IM-skill`

`codex-to-im` is based on those two projects and has been reworked toward a single-package local app, shared-thread workflow, and optional Codex integration model.

Windows host installation guide: [docs/install-windows.md](D:/codex/Claude-to-IM-skill/docs/install-windows.md)

## What It Includes

- Local background bridge service
- Local web workbench for configuration, testing, logs, and bindings
- Feishu credential setup and connectivity testing
- Weixin QR login flow
- Desktop session discovery from `~/.codex/sessions`
- Web-side binding updates for IM chats
- Optional Codex integration for opening `codex-to-im` or entering the Feishu handoff flow

## Install

### Global install

```bash
npm install -g codex-to-im
```

### Local development

```bash
npm install
npm run build
```

## Run

Start the local app:

```bash
codex-to-im
```

This launches the local workbench and opens it in your browser.

By default the workbench runs at:

```text
http://127.0.0.1:4781
```

If that port is already occupied, the app automatically finds an available local port and prints the actual address to the terminal when starting.

If you forget the current address, run:

```bash
codex-to-im url
```

## Main Workflow

1. Open the workbench
2. Fill in Feishu credentials or trigger Weixin QR login
3. Save config and test connectivity
4. Start the bridge
5. Open the desktop sessions section
6. Bind a Feishu or Weixin chat to the target thread
7. Continue the same Codex thread from IM

## Optional Codex Integration

The repo still includes a lightweight optional integration under `SKILL.md`.

It is not required for the product to work.

If installed into `~/.codex/skills/codex-to-im`, it should only be used for two actions:

- Open `codex-to-im`
- Open the Feishu session-sharing entry for the current workflow

You can install that optional integration from the web UI, or with:

```bash
bash scripts/install-codex.sh --link
```

## Repo Layout

- `src/ui-server.ts` — local workbench UI and HTTP API
- `src/service-manager.ts` — bridge and UI lifecycle management
- `src/desktop-sessions.ts` — desktop thread discovery from Codex session files
- `src/session-bindings.ts` — binding summaries and web-side binding updates
- `src/lib/bridge/` — bridge runtime and IM channel routing
- `SKILL.md` — optional Codex integration only
- `docs/` — PRD and shared-thread design docs

## Development

```bash
npm run typecheck
npm run build
```

## Status

Current product direction:

- Standalone local app first
- Web workbench first
- Shared Codex thread model first
- Codex integration is optional, not the primary installation path

[中文文档](README_CN.md)
