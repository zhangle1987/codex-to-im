# Security

## Credential Storage

Credentials are stored in `~/.codex-to-im/config.env` and the local runtime data under `~/.codex-to-im/`.

The app still falls back to `~/.claude-to-im/` on machines that already have legacy data, but new installs should treat `~/.codex-to-im/` as the primary home.

This repository never stores secrets in source control.

## Log Redaction

Tokens and secrets should be masked in logs and workbench output. Only short tail fragments of secrets should ever be shown for confirmation or diagnosis.

## Operational Model

`codex-to-im` is a local single-user bridge:

- The bridge runs on the user's machine
- The web workbench is local-only
- IM authentication is delegated to each IM platform
- Access control is enforced through configured allowlists and channel bindings

## Rotation Guidance

If a token is rotated or suspected to be exposed:

1. Revoke the old credential on the IM platform
2. Update the value in the local `codex-to-im` workbench
3. Restart the bridge from the workbench
4. Review recent logs under `~/.codex-to-im/logs/`

## Legacy Data

If you upgraded from an older `claude-to-im` install, check both of these locations during diagnosis:

- `~/.codex-to-im/`
- `~/.claude-to-im/`
