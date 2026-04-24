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
    runtime: 'codex',
    channels: [],
    enabledChannels: [],
    defaultMode: 'code',
  };

  it('always sets remote_bridge_enabled to true', () => {
    const m = configToSettings(base);
    assert.equal(m.get('remote_bridge_enabled'), 'true');
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

  it('maps mode and omits model when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
    assert.equal(m.get('bridge_default_mode'), 'code');
    assert.equal(m.get('bridge_history_message_limit'), '8');
    assert.equal(m.get('bridge_stream_status_idle_start_seconds'), '180');
    assert.equal(m.get('bridge_stream_status_check_interval_seconds'), '10');
  });

  it('maps configured stream status timing settings', () => {
    const m = configToSettings({
      ...base,
      streamStatusIdleStartSeconds: 240,
      streamStatusCheckIntervalSeconds: 15,
    });
    assert.equal(m.get('bridge_stream_status_idle_start_seconds'), '240');
    assert.equal(m.get('bridge_stream_status_check_interval_seconds'), '15');
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
    assert.equal(m.has('bridge_feishu_app_id'), false);
  });

  it('omits unsupported channel providers from runtime settings', () => {
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
          config: {},
        },
        {
          id: 'telegram-old',
          alias: 'Telegram',
          provider: 'telegram',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {},
        } as never,
      ],
    });

    const channels = JSON.parse(m.get('bridge_channel_instances_json') || '[]') as Array<{ provider: string }>;
    assert.deepEqual(channels.map((channel) => channel.provider), ['feishu']);
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
      runtime: 'codex',
      channels: [],
      enabledChannels: [],
      defaultMode: 'code',
    });
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
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

  it('filters unsupported providers from config.v2.json on load', () => {
    fs.mkdirSync(path.dirname(CONFIG_V2_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_V2_PATH,
      JSON.stringify({
        schemaVersion: 2,
        runtime: {
          provider: 'codex',
          defaultMode: 'code',
        },
        channels: [
          {
            id: 'feishu-default',
            alias: '飞书',
            provider: 'feishu',
            enabled: true,
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
            config: {},
          },
          {
            id: 'telegram-old',
            alias: 'Telegram',
            provider: 'telegram',
            enabled: true,
            createdAt: '2026-03-28T00:00:00.000Z',
            updatedAt: '2026-03-28T00:00:00.000Z',
            config: {},
          },
        ],
      }, null, 2),
    );

    const loaded = loadConfig();
    assert.deepEqual(loaded.channels?.map((channel) => channel.provider), ['feishu']);
    assert.deepEqual(loaded.enabledChannels, ['feishu']);
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
          streamStatusIdleStartSeconds: 180,
          streamStatusCheckIntervalSeconds: 10,
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
      streamStatusIdleStartSeconds: 240,
      streamStatusCheckIntervalSeconds: 15,
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
    assert.equal(reloaded.streamStatusIdleStartSeconds, 240);
    assert.equal(reloaded.streamStatusCheckIntervalSeconds, 15);
  });
});
