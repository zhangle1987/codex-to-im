# Troubleshooting

## Bridge won't start

**Symptoms**: Starting the bridge from the local workbench fails, or the daemon exits immediately.

**Steps**:

1. Run the local doctor script or inspect the workbench logs to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that Codex CLI is available: `codex --version`
4. Verify config exists: `ls -la ~/.codex-to-im/config.env`
5. Check logs for startup errors in `~/.codex-to-im/logs/`

**Common causes**:
- Missing or invalid config.env -- open the local workbench and save a valid configuration
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another bridge instance is already running

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the channel credentials with the local workbench test tools or doctor script
2. Check allowed user IDs in config -- if set, only listed users can interact
3. For Feishu: confirm the app has been approved and event subscriptions are configured
4. For Weixin: confirm the linked account is logged in and assigned to the channel instance
5. Check recent logs for incoming message events under `~/.codex-to-im/logs/`

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

**Symptoms**: Codex session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs Codex through the SDK/CLI; ensure the configured sandbox and approval policy match the requested task
2. Use the IM permission prompt to approve the requested tool, or adjust Codex approval settings if you expect unattended execution
3. Check network connectivity if the timeout occurs during API calls

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current bridge status from the local workbench
2. Restart the daemon to reset memory:
   ```
   Stop the bridge, then start it again from the local workbench
   ```
3. If the issue persists, check how many concurrent sessions are active -- each Codex session consumes memory
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
