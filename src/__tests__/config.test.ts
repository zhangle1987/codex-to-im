import './test-setup.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CTI_HOME,
  CONFIG_PATH,
  CONFIG_V2_PATH,
  loadConfig,
  maskSecret,
  saveConfig,
  configToSettings,
  type Config,
} from '../config.js';

// ── maskSecret ──

describe('CTI_HOME', () => {
  it('defaults to the codex-to-im home directory when CTI_HOME is unset', () => {
    if (process.env.CTI_HOME) {
      assert.equal(CTI_HOME, process.env.CTI_HOME);
      return;
    }

    assert.equal(CTI_HOME, path.join(os.homedir(), '.codex-to-im'));
  });
});

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
    assert.equal(maskSecret(''), '****');
  });

  it('preserves last 4 chars for longer values', () => {
    assert.equal(maskSecret('12345678'), '****5678');
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });

  it('handles exactly 5 chars', () => {
    assert.equal(maskSecret('12345'), '*2345');
  });
});

// ── configToSettings ──

describe('configToSettings', () => {
  const base: Config = {
    runtime: 'claude',
    channels: [],
    enabledChannels: [],
    defaultMode: 'code',
  };

  it('always sets remote_bridge_enabled to true', () => {
    const m = configToSettings(base);
    assert.equal(m.get('remote_bridge_enabled'), 'true');
  });

  it('sets channel enabled flags based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['telegram', 'discord'] });
    assert.equal(m.get('bridge_telegram_enabled'), 'true');
    assert.equal(m.get('bridge_discord_enabled'), 'true');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
  });

  it('maps telegram config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['telegram'],
      tgBotToken: 'bot123:abc',
      tgAllowedUsers: ['user1', 'user2'],
      tgChatId: '99999',
    });
    assert.equal(m.get('telegram_bot_token'), 'bot123:abc');
    assert.equal(m.get('telegram_bridge_allowed_users'), 'user1,user2');
    assert.equal(m.get('telegram_chat_id'), '99999');
  });

  it('maps discord config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['discord'],
      discordBotToken: 'discord-token',
      discordAllowedUsers: ['u1'],
      discordAllowedChannels: ['c1', 'c2'],
      discordAllowedGuilds: ['g1'],
    });
    assert.equal(m.get('bridge_discord_bot_token'), 'discord-token');
    assert.equal(m.get('bridge_discord_allowed_users'), 'u1');
    assert.equal(m.get('bridge_discord_allowed_channels'), 'c1,c2');
    assert.equal(m.get('bridge_discord_allowed_guilds'), 'g1');
  });

  it('maps feishu config', () => {
    const m = configToSettings({
      ...base,
      channels: [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {
            appId: 'app-id',
            appSecret: 'app-secret',
            site: 'lark',
            allowedUsers: ['fu1'],
            streamingEnabled: false,
            feedbackMarkdownEnabled: true,
          },
        },
      ],
    });
    assert.equal(m.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(m.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(m.get('bridge_feishu_site'), 'lark');
    assert.equal(m.get('bridge_feishu_allowed_users'), 'fu1');
    assert.equal(m.get('bridge_feishu_streaming_enabled'), 'false');
    assert.equal(m.get('bridge_feishu_command_markdown_enabled'), 'true');
  });

  it('sets bridge_qq_enabled based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['qq'] });
    assert.equal(m.get('bridge_qq_enabled'), 'true');
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
  });

  it('defaults bridge_qq_enabled to false', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_qq_enabled'), 'false');
  });

  it('maps qq config fields', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'qq-app-id',
      qqAppSecret: 'qq-secret',
      qqAllowedUsers: ['openid1', 'openid2'],
    });
    assert.equal(m.get('bridge_qq_app_id'), 'qq-app-id');
    assert.equal(m.get('bridge_qq_app_secret'), 'qq-secret');
    assert.equal(m.get('bridge_qq_allowed_users'), 'openid1,openid2');
  });

  it('maps qq image settings', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
      qqImageEnabled: false,
      qqMaxImageSize: 10,
    });
    assert.equal(m.get('bridge_qq_image_enabled'), 'false');
    assert.equal(m.get('bridge_qq_max_image_size'), '10');
  });

  it('maps weixin settings', () => {
    const m = configToSettings({
      ...base,
      channels: [
        {
          id: 'weixin-default',
          alias: '微信',
          provider: 'weixin',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {
            baseUrl: 'https://example.weixin.test',
            cdnBaseUrl: 'https://cdn.weixin.test',
            mediaEnabled: true,
            feedbackMarkdownEnabled: false,
          },
        },
      ],
    });
    assert.equal(m.get('bridge_weixin_enabled'), 'true');
    assert.equal(m.get('bridge_weixin_base_url'), 'https://example.weixin.test');
    assert.equal(m.get('bridge_weixin_cdn_base_url'), 'https://cdn.weixin.test');
    assert.equal(m.get('bridge_weixin_media_enabled'), 'true');
    assert.equal(m.get('bridge_weixin_command_markdown_enabled'), 'false');
  });

  it('omits qq image settings when not set', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
    });
    assert.equal(m.has('bridge_qq_image_enabled'), false);
    assert.equal(m.has('bridge_qq_max_image_size'), false);
  });

  it('maps mode and omits model when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
    assert.equal(m.get('bridge_default_mode'), 'code');
    assert.equal(m.get('bridge_history_message_limit'), '8');
  });

  it('maps model when explicitly set', () => {
    const m = configToSettings({ ...base, defaultModel: 'gpt-4o' });
    assert.equal(m.get('bridge_default_model'), 'gpt-4o');
    assert.equal(m.get('default_model'), 'gpt-4o');
  });

  it('maps configured history message limit', () => {
    const m = configToSettings({ ...base, historyMessageLimit: 12 });
    assert.equal(m.get('bridge_history_message_limit'), '12');
  });

  it('maps default workspace root', () => {
    const m = configToSettings({ ...base, defaultWorkspaceRoot: '/tmp/workspace' });
    assert.equal(m.get('bridge_default_workspace_root'), '/tmp/workspace');
  });

  it('maps codex skip git repo check flag', () => {
    const m = configToSettings({ ...base, codexSkipGitRepoCheck: true });
    assert.equal(m.get('bridge_codex_skip_git_repo_check'), 'true');
  });

  it('maps codex sandbox mode and reasoning effort', () => {
    const m = configToSettings({
      ...base,
      codexSandboxMode: 'danger-full-access',
      codexReasoningEffort: 'xhigh',
    });
    assert.equal(m.get('bridge_codex_sandbox_mode'), 'danger-full-access');
    assert.equal(m.get('bridge_codex_reasoning_effort'), 'xhigh');
  });

  it('maps non-default mode', () => {
    const m = configToSettings({ ...base, defaultMode: 'plan' });
    assert.equal(m.get('bridge_default_mode'), 'plan');
  });

  it('omits optional fields when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('telegram_bot_token'), false);
    assert.equal(m.has('bridge_discord_bot_token'), false);
    assert.equal(m.has('bridge_feishu_app_id'), false);
  });
});

// ── Config file parsing (loadConfig/saveConfig round-trip) ──

describe('loadConfig/saveConfig round-trip', () => {
  let tmpDir: string;
  let origHome: string;
  let configBackup: string | null;
  let configV2Backup: string | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-config-test-'));
    origHome = process.env.HOME || '';
    configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null;
    configV2Backup = fs.existsSync(CONFIG_V2_PATH) ? fs.readFileSync(CONFIG_V2_PATH, 'utf-8') : null;
    fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(CONFIG_V2_PATH, { force: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(CONFIG_V2_PATH, { force: true });
    if (configBackup !== null) {
      fs.writeFileSync(CONFIG_PATH, configBackup);
    }
    if (configV2Backup !== null) {
      fs.writeFileSync(CONFIG_V2_PATH, configV2Backup);
    }
  });

  it('configToSettings returns correct defaults', () => {
    const m = configToSettings({
      runtime: 'claude',
      channels: [],
      enabledChannels: [],
      defaultMode: 'code',
    });
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
    assert.equal(m.get('bridge_discord_enabled'), 'false');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
    assert.equal(m.get('bridge_qq_enabled'), 'false');
    assert.equal(m.get('bridge_weixin_enabled'), 'false');
  });

  it('migrates legacy env config into config.v2.json default channel instances', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      [
        'CTI_RUNTIME=codex',
        'CTI_ENABLED_CHANNELS=feishu,weixin',
        'CTI_FEISHU_APP_ID=app-id',
        'CTI_FEISHU_APP_SECRET=app-secret',
        'CTI_FEISHU_DOMAIN=lark',
        'CTI_FEISHU_ALLOWED_USERS=u1,u2',
        'CTI_WEIXIN_BASE_URL=https://wx.example.test',
        'CTI_WEIXIN_CDN_BASE_URL=https://cdn.example.test',
        'CTI_WEIXIN_MEDIA_ENABLED=true',
      ].join('\n'),
    );

    const loaded = loadConfig();
    assert.equal(loaded.schemaVersion, 2);
    assert.ok(fs.existsSync(CONFIG_V2_PATH));
    assert.deepEqual(
      loaded.channels?.map((channel) => ({
        id: channel.id,
        alias: channel.alias,
        provider: channel.provider,
        enabled: channel.enabled,
        config: channel.provider === 'feishu' ? (channel.config as any).site : undefined,
      })),
      [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          config: 'lark',
        },
        {
          id: 'weixin-default',
          alias: '微信',
          provider: 'weixin',
          enabled: true,
          config: undefined,
        },
      ],
    );
  });

  it('preserves custom v2 channel instances when saving runtime settings', () => {
    fs.mkdirSync(path.dirname(CONFIG_V2_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_V2_PATH,
      JSON.stringify({
        schemaVersion: 2,
        runtime: {
          provider: 'codex',
          defaultMode: 'code',
          historyMessageLimit: 8,
        },
        channels: [
          {
            id: 'feishu-rd',
            alias: '研发飞书',
            provider: 'feishu',
            enabled: true,
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
            config: {
              appId: 'rd-app',
              appSecret: 'rd-secret',
              feedbackMarkdownEnabled: true,
            },
          },
          {
            id: 'feishu-cs',
            alias: '客服飞书',
            provider: 'feishu',
            enabled: true,
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
            config: {
              appId: 'cs-app',
              appSecret: 'cs-secret',
              feedbackMarkdownEnabled: false,
            },
          },
        ],
      }, null, 2),
    );

    const loaded = loadConfig();
    saveConfig({
      ...loaded,
      defaultMode: 'plan',
      historyMessageLimit: 12,
    });

    const reloaded = loadConfig();
    assert.deepEqual(
      reloaded.channels?.map((channel) => ({
        id: channel.id,
        alias: channel.alias,
        provider: channel.provider,
        appId: (channel.config as { appId?: string }).appId,
      })),
      [
        {
          id: 'feishu-rd',
          alias: '研发飞书',
          provider: 'feishu',
          appId: 'rd-app',
        },
        {
          id: 'feishu-cs',
          alias: '客服飞书',
          provider: 'feishu',
          appId: 'cs-app',
        },
      ],
    );
    assert.equal(reloaded.defaultMode, 'plan');
    assert.equal(reloaded.historyMessageLimit, 12);
  });
});
