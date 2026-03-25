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

### Prerequisites

- Node.js 20+
- If you use the `codex` or `auto` runtime, complete Codex authentication under the same OS user account

`codex-to-im` now ships with the required `@openai/codex-sdk` / Codex CLI platform dependency, so you do not need to install a separate global Codex CLI just to run the bridge.

You still need Codex credentials to be available for the current user. Any of these is sufficient:

- a logged-in Codex Desktop App
- an existing Codex CLI login state
- `CTI_CODEX_API_KEY`, `CODEX_API_KEY`, or `OPENAI_API_KEY`

If the machine does not have any Codex login state yet, the simplest path is still to install the global CLI once and log in:

```bash
npm install -g @openai/codex
codex auth login
```

### Global install

```bash
npm install -g codex-to-im
```

### Local development

```bash
npm install
npm run build
```

Windows maintenance note:

- The repo includes [patch-codex-sdk-windows-hide.js](D:/codex/Claude-to-IM-skill/scripts/patch-codex-sdk-windows-hide.js), which applies a conservative postinstall patch to `@openai/codex-sdk`.
- This exists because on Windows the SDK may spawn the bundled Codex CLI without `windowsHide`, causing a black console window to flash for each IM-triggered run.
- When upgrading `@openai/codex-sdk`, verify that the spawn block still matches; if upstream fixes this natively, remove the patch instead of carrying it forward.

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

By default, the web workbench only accepts local access.

If you want to open it from your phone or another device on the same LAN, enable `允许局域网访问 Web 控制台` in the `配置` page. When enabled:

- the workbench shows detected LAN URLs
- the workbench displays an access token
- LAN devices see a login page before they can view or modify settings
- you can also copy a ready-to-use login link that includes `?token=...`

If you forget the current address, run:

```bash
codex-to-im url
```

Check the current local service state:

```bash
codex-to-im status
```

Stop the background UI and bridge:

```bash
codex-to-im stop
```

## Main Workflow

1. Open the workbench
2. Fill in Feishu credentials or trigger Weixin QR login
3. Save config and test connectivity
4. Start the bridge
5. Open the desktop sessions section
6. Bind a Feishu or Weixin chat to the target thread
7. Continue the same Codex thread from IM

If LAN access is enabled, the easiest path is to copy the LAN login link from the local workbench and open it on your phone or another device on the same network.

Useful commands:

- `/` / `/status` shows the current session
- `/h` / `/help` shows help
- `/t` / `/threads` lists recent desktop threads, and `/t 1` / `/thread 1` binds the first one
- `/n` / `/new` creates a new thread in the current formal session directory; these IM-created threads are only guaranteed to continue inside IM and will not automatically appear in the Codex Desktop thread list
- `/n proj1` / `/new proj1` creates a new project session under the default workspace root
- `/m` / `/mode` shows or changes the current mode; options: `code` / `plan` / `ask`
- `/r` / `/reasoning` shows or changes the current reasoning effort; options: `1|2|3|4|5`
- `/his` / `/history` shows the summarized history, and `/his raw` / `/history raw` shows raw history
- `/t 0` / `/thread 0` enters a temporary draft thread that does not pollute the main work thread
- `1 / 2 / 3` or `/perm ...` handles permission prompts
- N is configurable in the web workbench under the basic settings panel
- The workbench command guide shows both short commands and compatible original commands

If you enable Feishu streaming response cards, the Feishu app must have the required permissions published first, at minimum:

- `cardkit:card:write`
- `cardkit:card:read`
- `im:message:update`

If those permissions are missing, the bridge log will usually show `99991672` with `cardkit:card:write`, and the bridge falls back to a final-result message.

Also note that under the current `codex` runtime, the `Codex CLI / SDK` typically emits the assistant text only when the `agent_message` item is completed, not as token-level deltas. In practice that means Feishu "streaming cards" currently behave more like:

- early `Thinking / Tool Progress` updates
- final response text written into the card at completion

So character-by-character text streaming is not guaranteed in the current implementation.

If creating a new session fails with `Not inside a trusted directory`, either:

- switch to a trusted project with `/new /absolute/path` or `/new proj1`, or
- enable `Allow Codex outside trusted Git repos` in the basic settings and restart the bridge

The configuration page also includes Codex runtime controls:

- `Default workspace root`
  - parent directory used for `/new proj1`
  - falls back to `~/cx2im` when left empty, expanded for the current OS
- `Codex filesystem permission`
  - `read-only`, `workspace-write`, or `danger-full-access`
  - default: `workspace-write`
- `Codex reasoning effort`
  - global default reasoning level
  - can be overridden per IM session with `/reasoning`
  - official runtime levels are `minimal`, `low`, `medium`, `high`, `xhigh`
  - IM numeric aliases are `1=minimal`, `2=low`, `3=medium`, `4=high`, `5=xhigh`

If you are using `codex-to-im` on your own development machine for real coding work, the more aggressive recommended setup is:

- set `Codex filesystem permission` to `danger-full-access`
- set `Codex reasoning effort` to `xhigh`

This is closer to a full-power `code` workflow. It fits a controlled local project, but is not a good default for unknown repositories or higher-risk environments.

The channel pages also expose a “Use Markdown for bridge feedback” switch:
- enabled by default for Feishu
- disabled by default for WeChat
- only affects bridge-generated feedback such as `/h`, `/status`, and `/threads`
- does not affect raw Codex replies

## Update

On Windows, `npm update -g codex-to-im` can fail with `EBUSY` if the background UI or bridge is still running from the global install directory.

Recommended update flow:

```bash
codex-to-im stop
npm update -g codex-to-im
codex-to-im
```

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
