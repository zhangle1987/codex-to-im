# Platform Setup Guides

Detailed step-by-step guides for each IM platform. Referenced by the `setup` and `reconfigure` subcommands.

---

## Feishu / Lark

### App ID and App Secret

**How to create a Feishu/Lark app and get credentials:**
1. Go to Feishu: https://open.feishu.cn/app or Lark: https://open.larksuite.com/app
2. Click **"Create Custom App"**
3. Fill in the app name and description → click **"Create"**
4. On the app's **"Credentials & Basic Info"** page, find:
   - **App ID** (like `cli_xxxxxxxxxx`)
   - **App Secret** (click to reveal, like `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

### Phase 1: Permissions + Bot capability

> Complete Phase 1 and publish before moving to Phase 2. Feishu requires a published version for permissions to take effect, and the bridge service needs active permissions to establish its WebSocket connection.

**Step A — Batch-add required permissions**

1. On the app page, go to **"Permissions & Scopes"**
2. Use **batch configuration** (click **"Batch switch to configure by dependency"** or find the JSON editor)
3. Paste the following JSON (required for streaming cards and interactive buttons):

```json
{
  "scopes": {
    "tenant": [
      "im:message:send_as_bot",
      "im:message:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:update",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:chat:read",
      "im:resource",
      "cardkit:card:write",
      "cardkit:card:read"
    ],
    "user": []
  }
}
```

4. Click **"Save"** to apply all permissions

If the batch import UI is not available, add each scope manually via the search box.

> **Important:** If `cardkit:card:write` is missing, enabling Feishu streaming in the local workbench will not work. The bridge will log Feishu error `99991672` and fall back to a normal final-result message.

**Step B — Enable the bot**

1. Go to **"Add Features"** → enable **"Bot"**
2. Set the bot name and description

**Step C — First publish (makes permissions + bot effective)**

1. Go to **"Version Management & Release"** → click **"Create Version"**
2. Fill in version `1.0.0` and a description → click **"Save"** → **"Submit for Review"**
3. Admin approves in **Feishu Admin Console** → **App Review** (self-approve if you are the admin)

**The bot will NOT work until this version is approved.**

### Phase 2: Event subscription (requires running bridge)

> The bridge service must be running before configuring events. Feishu validates the WebSocket connection when saving event subscription — if the bridge is not running, you'll get "未检测到应用连接信息" (connection not detected) error.

**Step D — Start the bridge service**

Start the bridge from the local `codex-to-im` workbench. This establishes the WebSocket long connection that Feishu needs to detect.

**Step E — Configure Events & Callbacks (long connection)**

1. Go to **"Events & Callbacks"** in the left sidebar
2. Under **"Event Dispatch Method"**, select **"Long Connection"** (长连接 / WebSocket mode)
3. Click **"Add Event"** and add:
   - `im.message.receive_v1` — Receive messages
4. Click **"Add Callback"** and add:
   - `card.action.trigger` — Card interaction callback (for permission approval buttons)
5. Click **"Save"**

**Step F — Second publish (makes event subscription effective)**

1. Go to **"Version Management & Release"** → click **"Create Version"**
2. Fill in version `1.1.0` → **"Save"** → **"Submit for Review"** → Admin approves
3. After approval, the bot can receive and respond to messages

> **Ongoing rule:** Any change to permissions, events, or capabilities requires a new version publish + admin approval.

### Upgrading from a previous version

If you already have a Feishu app configured, you need to:

1. **Add new permissions**: Go to Permissions & Scopes, add these scopes:
   - `cardkit:card:write`, `cardkit:card:read` — Streaming cards
   - `im:message:update` — Real-time card content updates
   - `im:message.reactions:read`, `im:message.reactions:write_only` — Typing indicator
2. **Publish a new version** — Permission changes only take effect after a new version is approved
3. **Start (or restart) the bridge** — Start it from the local `codex-to-im` workbench so the WebSocket connection is active
4. **Add callback**: Go to Events & Callbacks, add `card.action.trigger` callback (card interaction for permission buttons). This step requires the bridge to be running — Feishu validates the WebSocket connection when saving.
5. **Publish again** — The new callback requires another version publish + admin approval
6. **Restart the bridge** — Stop and start it again from the local `codex-to-im` workbench to pick up the new capabilities

### Current Feishu streaming behavior with Codex runtime

Even after the Feishu permissions are correct, the current `codex` runtime does **not** guarantee token-by-token text streaming into the Feishu card.

As of **2026-03-24**, the `Codex CLI / SDK` event stream typically emits assistant text when the `agent_message` item completes, rather than as token deltas. In practice, Feishu streaming cards are best understood as:

- early `Thinking` / tool progress updates
- final response text written into the card at completion

So if you see the final answer appear all at once after the card was created successfully, that is currently expected behavior with `codex`.

### Domain (optional)

Default: `https://open.feishu.cn`
Use `https://open.larksuite.com` for Lark (international version).
Leave empty to use the default Feishu domain.

### Allowed User IDs (optional)

Feishu user IDs (open_id format like `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).
You can find them in the Feishu Admin Console under user profiles.
Leave empty to allow all users who can message the bot.

---

## Weixin / 微信

> Risk note: this integration follows the same OpenClaw-style WeChat plugin protocol used by CodePilot. Because it connects a non-OpenClaw product to WeChat, there may be account risk. Use with caution.

### QR login flow

Weixin does **not** use a static bot token in `config.env`.

Instead, run the local QR helper from the local app directory:

- Repo checkout or app install:

```bash
cd /path/to/codex-to-im
npm run weixin:login
```

If you are running from a checked-out repo, use that repo's `codex-to-im` directory.

What happens next:

1. The helper requests a fresh WeChat QR code
2. It writes a local HTML file to:
  `~/.codex-to-im/runtime/weixin-login.html`
3. It tries to open that HTML file in your default browser automatically
4. You scan the QR code with the WeChat app and confirm on your phone
5. On success, the helper stores the linked account in:
  `~/.codex-to-im/data/weixin-accounts.json`

The filename stays plural for backward compatibility. Multiple linked Weixin accounts can coexist in the same store.

If the browser does not open automatically, open the HTML file manually.

### Replacing the linked Weixin account

Run the helper again:

```bash
cd <skill-dir>
npm run weixin:login
```

Each successful scan replaces the previously linked Weixin account. Only the most recent account is kept locally and used by the bridge.

### Optional config

Most users should leave these unset:

- `CTI_WEIXIN_BASE_URL`
- `CTI_WEIXIN_CDN_BASE_URL`
- `CTI_WEIXIN_MEDIA_ENABLED`

Defaults:

- Base URL: `https://ilinkai.weixin.qq.com`
- CDN Base URL: `https://novac2c.cdn.weixin.qq.com/c2c`
- Media: disabled by default in CLI setups; when enabled, inbound images/files/videos are downloaded and forwarded as attachments

### Voice message behavior

Weixin voice messages are handled differently from image/file/video media:

- If WeChat includes built-in speech-to-text text in `voice_item.text`, the bridge forwards that text as the user message.
- If WeChat does **not** include a transcript, the bridge returns a user-visible error asking the sender to enable WeChat voice transcription and resend.
- The bridge does **not** download, decrypt, or transcribe raw voice audio on its own.

This rule applies to the Codex runtime.
