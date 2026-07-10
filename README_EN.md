# Codex-to-IM

[中文版](README.md)

`codex-to-im` is a local bridge app that connects Codex to IM channels such as Feishu/Lark and Weixin.

Its main path is not to modify Codex itself, but to:

1. start a local web workbench and bridge on your machine
2. create and configure one or more channel instances in the workbench
3. bind desktop Codex sessions to IM chats
4. continue the same conversation, switch threads, and inspect status from IM

## Project Origin

The current codebase is a consolidated continuation of two earlier projects:

- `Claude-to-IM`
- `Claude-to-IM-skill`

`codex-to-im` continues from those two repositories and has been reworked into a single local package with a unified workbench, bridge, shared-thread workflow, and optional skill integration model.

## Core Capabilities

- Shared desktop threads: bind a thread currently used in Codex Desktop to IM and continue the same conversation there.
- IM remote control: inspect current status, switch threads, create threads, change mode, change reasoning effort, switch model, stop the current task, and inspect history from IM.
- Local web workbench: central place for configuration, channel login, logs, session management, and binding management.
- Feishu streaming cards: Feishu can show streaming shared-thread responses and tool progress updates.
- Attachment send-back: send local images or files back to Feishu; if you want Codex to actively use that capability, install the bundled `codex-to-im` skill.
- Local-first: services, config, logs, and the bridge all run on the local machine; LAN access to the web console is optional.

## Supported Channels

- Feishu: supports multiple bot instances, connectivity testing, shared threads, streaming cards, image sending, and file sending.
- Weixin: supports multiple instances, QR login, shared threads, and text feedback.

Each channel instance can have its own alias, for example:

- `Feishu Main`
- `Feishu Backup`
- `Weixin Work`

These aliases only distinguish different chat entry points. They do not change Codex session semantics.

## Quick Start

### Prerequisites

- Node.js 20+
- Codex login state or API credentials available under the current OS user

Any of the following is sufficient:

- a logged-in Codex Desktop App
- a logged-in Codex CLI
- `CTI_CODEX_API_KEY`, `CODEX_API_KEY`, or `OPENAI_API_KEY`

### Install

```bash
npm install -g codex-to-im
```

### Start

```bash
codex-to-im
```

If you only want the background bridge without opening the UI:

```bash
codex-to-im start
```

### Boot Autostart on Windows

The current implementation can register the **bridge** as a Windows boot task. The UI is still opened on demand with `codex-to-im`.

```powershell
codex-to-im autostart status
codex-to-im autostart install
codex-to-im autostart uninstall
```

Notes:

- `codex-to-im autostart install` and `codex-to-im autostart uninstall` must be run from an **elevated Administrator PowerShell / terminal**.
- Installation prompts for the current Windows account password so the boot task can be created.
- Autostart only launches the bridge; it does not open the Web UI.
- Running `codex-to-im` manually later only starts the UI if needed and does not duplicate the bridge.
- The current implementation uses the built-in Windows Task Scheduler and does not depend on WinSW or NSSM.
- The web workbench only shows autostart status; enable or disable it from the administrator commands above.

By default the local workbench opens at:

```text
http://127.0.0.1:4781
```

If you want to inspect the current address or service state:

```bash
codex-to-im url
codex-to-im status
```

If you want to stop the local UI and bridge:

```bash
codex-to-im stop
```

### Uninstall

```bash
codex-to-im uninstall
```

Notes:

- This command stops the local UI, stops the bridge, and attempts to remove the installed bridge boot task if present.
- After the command exits, a background helper attempts to run `npm uninstall -g codex-to-im`; this step is not immediate.
- Check the log path printed by the command to confirm the uninstall result. If `codex-to-im` is still available a few seconds later, run `npm uninstall -g codex-to-im` manually.
- This command does not delete local config, logs, or session data under `~/.codex-to-im`.
- This command also does not delete `~/.codex/skills/codex-to-im`; remove those directories manually if you want a full local cleanup.

## Typical Workflows

### 1. Take over a desktop thread

After creating a Feishu or Weixin channel instance in the web workbench, start the bridge.
Then send:

```text
/t
```

to list the latest 10 desktop threads. Send:

```text
/t all
```

to list up to 200 desktop threads. Then use:

```text
/t 1
```

to switch to the selected thread.

### 2. Continue from IM

Once the binding is established, send normal messages to continue the current thread.
If the same shared thread is also used on desktop, its output is mirrored back to IM.

### 3. Create a new IM thread

```text
/new
```

This creates a new thread under the working directory of the current formal session.
If there is no formal session yet, or the current session is temporary, the command fails.

You can also specify a directory explicitly:

```text
/new my-project
/new D:\work\my-project
```

## Common Commands

- `/` or `/status`: inspect the current session, thread, model, mode, reasoning effort, and shared-mirror status.
- `/t`: list the latest 10 desktop threads.
- `/t all`: list up to 200 desktop threads.
- `/t n 100`: list the latest 100 desktop threads, capped at 200.
- `/t 1`: switch to desktop thread 1.
- `/t 0`: switch to the temporary thread for the current chat.
- `/new`: create a new thread under the current formal session directory.
- `/new <path or project name>`: create a new thread under the specified directory.
- `/mode <ask|code|plan>`: change the runtime mode.
- `/reasoning <low|medium|high|xhigh|max|ultra>`: change the reasoning effort; numeric `1-5` aliases remain compatible, while `6=max` and `7=ultra` only apply to models that support them.
- `/model`: inspect the current model and available models.
- `/model <model name>`: change the model for the current IM session.
- `/history`: inspect the current thread history summary.
- `/stop`: stop the current task.
- `/unbind`: remove the binding between the current chat and the session.

## Key Settings

Common settings in the workbench include:

- Default workspace root: used for relative paths such as `/new my-project`.
- Codex filesystem permission: for example `workspace-write` or `danger-full-access`.
- Codex reasoning effort: shown from the selected model's Codex catalog, for example `low`, `medium`, `high`, `xhigh`; some newer models also support `max` and `ultra`.
- Default model: chosen from the models available on the local machine.
- Use Markdown for feedback: controls whether bridge text feedback is sent through markdown rendering.
- Allow LAN access to the Web console: useful when opening the workbench from a phone or another device on the same LAN.
- Channel instances: you can create multiple Feishu or Weixin bot/account entry points and assign an alias to each instance.

The primary config file is:

- `~/.codex-to-im/config.v2.json`

The compatibility `config.env` file is still kept as a snapshot and fallback for older tooling, but it no longer fully represents multi-instance channel configuration.

## Current Boundaries

- Threads created with `/new` are only guaranteed to continue inside IM; they are not guaranteed to automatically appear in the Codex Desktop thread list.
- One session can only be bound to one chat at a time, and that exclusivity also applies across Feishu and Weixin.
- Feishu attachments currently support images and files; videos are currently sent as files and are not guaranteed to render with native preview.
- `/t` shows only the latest 10 desktop threads by default; `/t all` is capped at 200, and `/t n 100` is also capped at 200.

## More Docs

- Windows installation guide: [docs/install-windows.md](docs/install-windows.md)
- Chinese version: [README.md](README.md)
