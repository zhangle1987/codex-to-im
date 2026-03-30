# Troubleshooting

## Bridge won't start

**Symptoms**: Starting the bridge from the local workbench fails, or the daemon exits immediately.

**Steps**:

1. Run the local doctor script or inspect the workbench logs to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that Claude Code CLI is available: `claude --version`
4. Verify config exists: `ls -la ~/.codex-to-im/config.env`
5. Check logs for startup errors in `~/.codex-to-im/logs/`

**Common causes**:
- Missing or invalid config.env -- open the local workbench and save a valid configuration
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another bridge instance is already running

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the bot token is valid with the local workbench test tools or doctor script
2. Check allowed user IDs in config -- if set, only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited to the server with message read permissions
5. For Feishu: confirm the app has been approved and event subscriptions are configured
6. Check recent logs for incoming message events under `~/.codex-to-im/logs/`

## Feishu streaming cards not working

**Symptoms**: Feishu responds only with a final message, or the streaming card never appears even though `Enable Feishu streaming response cards` is checked.

**Steps**:

1. Check `~/.codex-to-im/logs/bridge.log`
2. Look for Feishu error `99991672`
3. If the error mentions `cardkit:card:write`, add and publish the missing Feishu permissions:
   - `cardkit:card:write`
   - `cardkit:card:read`
   - `im:message:update`
4. Restart the bridge after the Feishu app version is approved

**Important behavior note**:

- If card creation is denied, the bridge falls back to a normal final-result message
- Even after the Feishu permissions are fixed, the current `codex` runtime usually delivers assistant text when the turn completes, not token-by-token
- That means Feishu streaming cards currently work best for `Thinking` / tool-progress updates, while the final response text may still appear all at once

## Permission timeout

**Symptoms**: Claude Code session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs Claude Code in non-interactive mode; ensure your Claude Code configuration allows the necessary tools
2. Consider using `--allowedTools` in your configuration to pre-approve common tools
3. Check network connectivity if the timeout occurs during API calls

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current bridge status from the local workbench
2. Restart the daemon to reset memory:
   ```
   Stop the bridge, then start it again from the local workbench
   ```
3. If the issue persists, check how many concurrent sessions are active -- each Claude Code session consumes memory
4. Review logs for error loops that may cause memory leaks

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Stop the bridge from the local workbench — this should clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.codex-to-im/runtime/bridge.pid
   ```
3. Start the bridge again from the local workbench
