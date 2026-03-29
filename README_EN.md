# Codex-to-IM

[中文版](README.md)

`codex-to-im` is a local bridge app that connects Codex desktop sessions to IM channels such as Feishu/Lark and Weixin.

The product is no longer centered around a Codex skill. The main path is:

1. Install `codex-to-im`
2. Open the local web workbench
3. Create one or more channel instances in the workbench
4. Start the bridge in the background
5. Bind real desktop Codex threads to Feishu or Weixin chats

Optional: if you want Codex to know it can send local files or images back to IM without relying on bridge-injected prompt text, install the bundled `codex-to-im` skill from the workbench.

## Project Origin

The current codebase is a consolidated continuation of two earlier repositories:

- `Claude-to-IM`
- `Claude-to-IM-skill`

`codex-to-im` is based on those two projects and has been reworked toward a single-package local app and shared-thread workflow.

Windows host installation guide: [docs/install-windows.md](docs/install-windows.md)

## What It Includes

- Local background bridge service
- Local web workbench for configuration, testing, logs, and bindings
- Multi-instance Feishu bot setup and connectivity testing
- Multi-instance Weixin login flow
- Desktop session discovery from `~/.codex/sessions`
- Web-side binding updates for IM chats

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

- The repo includes [patch-codex-sdk-windows-hide.js](scripts/patch-codex-sdk-windows-hide.js), which applies a conservative postinstall patch to `@openai/codex-sdk`.
- This exists because on Windows the SDK may spawn the bundled Codex CLI without `windowsHide`, causing a black console window to flash for each IM-triggered run.
- When upgrading `@openai/codex-sdk`, verify that the spawn block still matches; if upstream fixes this natively, remove the patch instead of carrying it forward.

## Run

Start the local app:

```bash
codex-to-im
```

This launches the local workbench and opens it in your browser.

If you only want the background bridge without opening the UI:

```bash
codex-to-im start
```

### Boot Autostart on Windows

The bridge can be registered as a Windows boot task. The Web UI remains on-demand and is still opened manually with `codex-to-im`.

```powershell
codex-to-im autostart status
codex-to-im autostart install
codex-to-im autostart uninstall
```

Notes:

- `codex-to-im autostart install` prompts for the current Windows account password so the startup task can be created.
- Autostart only launches the bridge; it does not open the Web UI.
- Running `codex-to-im` manually later only starts the UI if needed and will not duplicate the bridge.
- The current implementation uses Windows Task Scheduler and does not require WinSW, NSSM, or PM2.

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
2. Create a Feishu or Weixin channel instance in the workbench
3. Give the instance an alias such as `Feishu Main` or `Weixin Work`
4. Save config and test connectivity
5. Start the bridge
6. Open the desktop sessions section
7. Bind a Feishu or Weixin chat to the target thread
8. Continue the same Codex thread from IM

If LAN access is enabled, the easiest path is to copy the LAN login link from the local workbench and open it on your phone or another device on the same network.

Useful commands:

- `/` / `/status` shows the current session
- `/h` / `/help` shows help
- `/t` / `/threads` lists the most recent 10 desktop threads, `/t all` / `/threads all` lists up to 200 of them, `/t n 100` / `/threads n 100` lists the most recent 100 desktop threads (also capped at 200), and `/t 1` / `/thread 1` binds the first one
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

The primary persisted configuration now lives in:

- `~/.codex-to-im/config.v2.json`

The legacy `config.env` file is still written as a compatibility snapshot, but it no longer fully represents multi-instance channel setup.

If you are using `codex-to-im` on your own development machine for real coding work, the more aggressive recommended setup is:

- set `Codex filesystem permission` to `danger-full-access`
- set `Codex reasoning effort` to `xhigh`

This is closer to a full-power `code` workflow. It fits a controlled local project, but is not a good default for unknown repositories or higher-risk environments.

The channel pages also expose a “Use Markdown for bridge feedback” switch:
- enabled by default for Feishu
- disabled by default for WeChat
- affects text sent through the bridge, including normal replies, shared-thread mirror messages, and system feedback such as `/h`, `/status`, and `/threads`

Each channel instance can have its own alias. The alias only identifies which IM entry point handled the chat; it does not change Codex session semantics or model behavior.

## Update

On Windows, `npm update -g codex-to-im` can fail with `EBUSY` if the background UI or bridge is still running from the global install directory.

Recommended update flow:

```bash
codex-to-im stop
npm update -g codex-to-im
codex-to-im
```

## Repo Layout

- `src/ui-server.ts` — local workbench UI and HTTP API
- `src/service-manager.ts` — bridge and UI lifecycle management
- `src/desktop-sessions.ts` — desktop thread discovery from Codex session files
- `src/session-bindings.ts` — binding summaries and web-side binding updates
- `src/lib/bridge/` — bridge runtime and IM channel routing
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
