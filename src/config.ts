import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeChannelId,
  parseReasoningEffort,
  parseSandboxMode,
  type RuntimeReasoningEffort,
  type RuntimeSandboxMode,
} from "./runtime-options.js";

export type CodexSandboxMode = RuntimeSandboxMode;
export type CodexReasoningEffort = RuntimeReasoningEffort;
export type ChannelProvider = 'feishu' | 'weixin';
export type FeishuSite = 'feishu' | 'lark';

export interface RuntimeConfigV2 {
  provider: 'claude' | 'codex' | 'auto';
  defaultWorkspaceRoot?: string;
  defaultModel?: string;
  defaultMode: string;
  historyMessageLimit?: number;
  codexSkipGitRepoCheck?: boolean;
  codexSandboxMode?: CodexSandboxMode;
  codexReasoningEffort?: CodexReasoningEffort;
  uiAllowLan?: boolean;
  uiAccessToken?: string;
  autoApprove?: boolean;
}

export interface FeishuChannelConfig {
  appId?: string;
  appSecret?: string;
  site?: FeishuSite;
  allowedUsers?: string[];
  streamingEnabled?: boolean;
  feedbackMarkdownEnabled?: boolean;
}

export interface WeixinChannelConfig {
  accountId?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  mediaEnabled?: boolean;
  feedbackMarkdownEnabled?: boolean;
}

export interface ChannelInstance {
  id: string;
  alias: string;
  provider: ChannelProvider;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  config: FeishuChannelConfig | WeixinChannelConfig;
}

interface ConfigV2File {
  schemaVersion: 2;
  runtime: RuntimeConfigV2;
  channels: ChannelInstance[];
}

function toFeishuConfig(channel?: ChannelInstance): FeishuChannelConfig | undefined {
  return channel?.provider === 'feishu' ? channel.config as FeishuChannelConfig : undefined;
}

function toWeixinConfig(channel?: ChannelInstance): WeixinChannelConfig | undefined {
  return channel?.provider === 'weixin' ? channel.config as WeixinChannelConfig : undefined;
}

export interface Config {
  runtime: RuntimeConfigV2['provider'];
  defaultWorkspaceRoot?: string;
  defaultModel?: string;
  defaultMode: string;
  historyMessageLimit?: number;
  codexSkipGitRepoCheck?: boolean;
  codexSandboxMode?: CodexSandboxMode;
  codexReasoningEffort?: CodexReasoningEffort;
  uiAllowLan?: boolean;
  uiAccessToken?: string;
  autoApprove?: boolean;
  schemaVersion?: number;
  channels?: ChannelInstance[];
  enabledChannels: string[];
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
}

const DEFAULT_CTI_HOME = path.join(os.homedir(), ".codex-to-im");
export const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), "cx2im");

export const CTI_HOME = process.env.CTI_HOME || DEFAULT_CTI_HOME;
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");
export const CONFIG_V2_PATH = path.join(CTI_HOME, "config.v2.json");

export function expandHomePath(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

export function loadRawConfigEnv(): Map<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return new Map<string, string>();
  }
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function normalizeFeishuSite(value: string | undefined): FeishuSite {
  const normalized = (value || '').trim().replace(/\/+$/, '').toLowerCase();
  if (!normalized) return 'feishu';
  if (normalized === 'lark') return 'lark';
  if (normalized === 'feishu') return 'feishu';
  if (normalized.includes('open.larksuite.com')) return 'lark';
  return 'feishu';
}

export function feishuSiteToApiBaseUrl(site: FeishuSite | string | undefined): string {
  return normalizeFeishuSite(site) === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureConfigDir(): void {
  fs.mkdirSync(CTI_HOME, { recursive: true });
}

function readConfigV2File(): ConfigV2File | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_V2_PATH, 'utf-8')) as ConfigV2File;
    if (parsed && parsed.schemaVersion === 2 && parsed.runtime && Array.isArray(parsed.channels)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeConfigV2File(config: ConfigV2File): void {
  ensureConfigDir();
  const tmpPath = CONFIG_V2_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_V2_PATH);
}

function defaultAliasForProvider(provider: ChannelProvider): string {
  return provider === 'feishu' ? '飞书' : '微信';
}

function buildDefaultChannelId(provider: ChannelProvider): string {
  return `${provider}-default`;
}

function migrateLegacyEnvToV2(env: Map<string, string>): ConfigV2File {
  const rawRuntime = env.get("CTI_RUNTIME") || "codex";
  const runtime = (["claude", "codex", "auto"].includes(rawRuntime) ? rawRuntime : "codex") as RuntimeConfigV2["provider"];
  const enabledChannels = splitCsv(env.get("CTI_ENABLED_CHANNELS")) ?? ["feishu"];
  const timestamp = nowIso();
  const channels: ChannelInstance[] = [];

  const hasFeishuConfig = Boolean(
    env.get("CTI_FEISHU_APP_ID")
    || env.get("CTI_FEISHU_APP_SECRET")
    || env.get("CTI_FEISHU_ALLOWED_USERS")
    || enabledChannels.includes('feishu')
  );
  if (hasFeishuConfig) {
    channels.push({
      id: buildDefaultChannelId('feishu'),
      alias: defaultAliasForProvider('feishu'),
      provider: 'feishu',
      enabled: enabledChannels.includes('feishu'),
      createdAt: timestamp,
      updatedAt: timestamp,
      config: {
        appId: env.get("CTI_FEISHU_APP_ID") || undefined,
        appSecret: env.get("CTI_FEISHU_APP_SECRET") || undefined,
        site: normalizeFeishuSite(env.get("CTI_FEISHU_SITE") || env.get("CTI_FEISHU_DOMAIN")),
        allowedUsers: splitCsv(env.get("CTI_FEISHU_ALLOWED_USERS")),
        streamingEnabled: env.has("CTI_FEISHU_STREAMING_ENABLED")
          ? env.get("CTI_FEISHU_STREAMING_ENABLED") === "true"
          : true,
        feedbackMarkdownEnabled: env.has("CTI_FEISHU_COMMAND_MARKDOWN_ENABLED")
          ? env.get("CTI_FEISHU_COMMAND_MARKDOWN_ENABLED") === "true"
          : true,
      },
    });
  }

  const hasWeixinConfig = Boolean(
    env.get("CTI_WEIXIN_BASE_URL")
    || env.get("CTI_WEIXIN_CDN_BASE_URL")
    || env.get("CTI_WEIXIN_MEDIA_ENABLED")
    || enabledChannels.includes('weixin')
  );
  if (hasWeixinConfig) {
    channels.push({
      id: buildDefaultChannelId('weixin'),
      alias: defaultAliasForProvider('weixin'),
      provider: 'weixin',
      enabled: enabledChannels.includes('weixin'),
      createdAt: timestamp,
      updatedAt: timestamp,
      config: {
        baseUrl: env.get("CTI_WEIXIN_BASE_URL") || undefined,
        cdnBaseUrl: env.get("CTI_WEIXIN_CDN_BASE_URL") || undefined,
        mediaEnabled: env.has("CTI_WEIXIN_MEDIA_ENABLED")
          ? env.get("CTI_WEIXIN_MEDIA_ENABLED") === "true"
          : undefined,
        feedbackMarkdownEnabled: env.has("CTI_WEIXIN_COMMAND_MARKDOWN_ENABLED")
          ? env.get("CTI_WEIXIN_COMMAND_MARKDOWN_ENABLED") === "true"
          : false,
      },
    });
  }

  return {
    schemaVersion: 2,
    runtime: {
      provider: runtime,
      defaultWorkspaceRoot: expandHomePath(env.get("CTI_DEFAULT_WORKSPACE_ROOT")) || undefined,
      defaultModel: env.get("CTI_DEFAULT_MODEL") || undefined,
      defaultMode: env.get("CTI_DEFAULT_MODE") || "code",
      historyMessageLimit: parsePositiveInt(env.get("CTI_HISTORY_MESSAGE_LIMIT")) ?? 8,
      codexSkipGitRepoCheck: env.has("CTI_CODEX_SKIP_GIT_REPO_CHECK")
        ? env.get("CTI_CODEX_SKIP_GIT_REPO_CHECK") === "true"
        : true,
      codexSandboxMode: parseSandboxMode(env.get("CTI_CODEX_SANDBOX_MODE")) ?? 'workspace-write',
      codexReasoningEffort: parseReasoningEffort(env.get("CTI_CODEX_REASONING_EFFORT")) ?? 'medium',
      uiAllowLan: env.get("CTI_UI_ALLOW_LAN") === "true",
      uiAccessToken: env.get("CTI_UI_ACCESS_TOKEN") || undefined,
      autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
    },
    channels,
  };
}

function getChannelByProvider(
  config: ConfigV2File,
  provider: ChannelProvider,
): ChannelInstance | undefined {
  const preferredId = buildDefaultChannelId(provider);
  return config.channels.find((channel) => channel.id === preferredId)
    || config.channels.find((channel) => channel.provider === provider);
}

function expandConfig(v2: ConfigV2File): Config {
  return {
    schemaVersion: 2,
    channels: v2.channels,
    runtime: v2.runtime.provider,
    enabledChannels: Array.from(new Set(
      v2.channels.filter((channel) => channel.enabled).map((channel) => channel.provider),
    )),
    defaultWorkspaceRoot: v2.runtime.defaultWorkspaceRoot,
    defaultModel: v2.runtime.defaultModel,
    defaultMode: v2.runtime.defaultMode || 'code',
    historyMessageLimit: v2.runtime.historyMessageLimit ?? 8,
    codexSkipGitRepoCheck: v2.runtime.codexSkipGitRepoCheck ?? true,
    codexSandboxMode: v2.runtime.codexSandboxMode ?? 'workspace-write',
    codexReasoningEffort: v2.runtime.codexReasoningEffort ?? 'medium',
    uiAllowLan: v2.runtime.uiAllowLan === true,
    uiAccessToken: v2.runtime.uiAccessToken || undefined,
    autoApprove: v2.runtime.autoApprove === true,
  };
}

function buildV2FileFromExpandedConfig(config: Config, current?: ConfigV2File | null): ConfigV2File {
  const hasExplicitChannels = Array.isArray(config.channels);
  let channels = hasExplicitChannels
    ? [...(config.channels || [])]
    : [...(current?.channels || [])];

  return {
    schemaVersion: 2,
    runtime: {
      provider: config.runtime,
      defaultWorkspaceRoot: config.defaultWorkspaceRoot,
      defaultModel: config.defaultModel,
      defaultMode: config.defaultMode,
      historyMessageLimit: config.historyMessageLimit,
      codexSkipGitRepoCheck: config.codexSkipGitRepoCheck,
      codexSandboxMode: config.codexSandboxMode,
      codexReasoningEffort: config.codexReasoningEffort,
      uiAllowLan: config.uiAllowLan,
      uiAccessToken: config.uiAccessToken,
      autoApprove: config.autoApprove,
    },
    channels: channels.map((channel) => ({
      ...channel,
      id: normalizeChannelId(channel.id),
      alias: channel.alias?.trim() || defaultAliasForProvider(channel.provider),
    })),
  };
}

export function loadConfig(): Config {
  const current = readConfigV2File();
  if (current) return expandConfig(current);

  const legacyEnv = loadRawConfigEnv();
  if (legacyEnv.size > 0) {
    const migrated = migrateLegacyEnvToV2(legacyEnv);
    writeConfigV2File(migrated);
    return expandConfig(migrated);
  }

  const empty: ConfigV2File = {
    schemaVersion: 2,
    runtime: {
      provider: 'codex',
      defaultWorkspaceRoot: DEFAULT_WORKSPACE_ROOT,
      defaultMode: 'code',
      historyMessageLimit: 8,
      codexSkipGitRepoCheck: true,
      codexSandboxMode: 'workspace-write',
      codexReasoningEffort: 'medium',
      uiAllowLan: false,
      autoApprove: false,
    },
    channels: [],
  };
  return expandConfig(empty);
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  const current = readConfigV2File();
  const next = buildV2FileFromExpandedConfig(config, current);
  writeConfigV2File(next);

  // Keep a lightweight env snapshot for operational visibility and shell tooling.
  let out = "";
  out += formatEnvLine("CTI_RUNTIME", next.runtime.provider);
  out += formatEnvLine(
    "CTI_ENABLED_CHANNELS",
    Array.from(new Set(next.channels.filter((channel) => channel.enabled).map((channel) => channel.provider))).join(","),
  );
  out += formatEnvLine("CTI_DEFAULT_WORKSPACE_ROOT", next.runtime.defaultWorkspaceRoot);
  out += formatEnvLine("CTI_DEFAULT_MODEL", next.runtime.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", next.runtime.defaultMode);
  if (next.runtime.historyMessageLimit !== undefined) {
    out += formatEnvLine("CTI_HISTORY_MESSAGE_LIMIT", String(next.runtime.historyMessageLimit));
  }
  if (next.runtime.codexSkipGitRepoCheck !== undefined) {
    out += formatEnvLine("CTI_CODEX_SKIP_GIT_REPO_CHECK", String(next.runtime.codexSkipGitRepoCheck));
  }
  out += formatEnvLine("CTI_CODEX_SANDBOX_MODE", next.runtime.codexSandboxMode);
  out += formatEnvLine("CTI_CODEX_REASONING_EFFORT", next.runtime.codexReasoningEffort);
  out += formatEnvLine("CTI_UI_ALLOW_LAN", String(next.runtime.uiAllowLan === true));
  out += formatEnvLine("CTI_UI_ACCESS_TOKEN", next.runtime.uiAccessToken);

  const feishu = getChannelByProvider(next, 'feishu');
  const feishuConfig = toFeishuConfig(feishu);
  if (feishuConfig) {
    out += formatEnvLine("CTI_FEISHU_APP_ID", feishuConfig.appId);
    out += formatEnvLine("CTI_FEISHU_APP_SECRET", feishuConfig.appSecret);
    out += formatEnvLine("CTI_FEISHU_SITE", feishuConfig.site);
    out += formatEnvLine("CTI_FEISHU_ALLOWED_USERS", feishuConfig.allowedUsers?.join(","));
    if (feishuConfig.streamingEnabled !== undefined) {
      out += formatEnvLine("CTI_FEISHU_STREAMING_ENABLED", String(feishuConfig.streamingEnabled));
    }
    if (feishuConfig.feedbackMarkdownEnabled !== undefined) {
      out += formatEnvLine("CTI_FEISHU_COMMAND_MARKDOWN_ENABLED", String(feishuConfig.feedbackMarkdownEnabled));
    }
  }

  const weixin = getChannelByProvider(next, 'weixin');
  const weixinConfig = toWeixinConfig(weixin);
  if (weixinConfig) {
    out += formatEnvLine("CTI_WEIXIN_BASE_URL", weixinConfig.baseUrl);
    out += formatEnvLine("CTI_WEIXIN_CDN_BASE_URL", weixinConfig.cdnBaseUrl);
    if (weixinConfig.mediaEnabled !== undefined) {
      out += formatEnvLine("CTI_WEIXIN_MEDIA_ENABLED", String(weixinConfig.mediaEnabled));
    }
    if (weixinConfig.feedbackMarkdownEnabled !== undefined) {
      out += formatEnvLine("CTI_WEIXIN_COMMAND_MARKDOWN_ENABLED", String(weixinConfig.feedbackMarkdownEnabled));
    }
  }

  out += formatEnvLine("CTI_AUTO_APPROVE", String(next.runtime.autoApprove === true));
  ensureConfigDir();
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function listChannelInstances(config?: Config): ChannelInstance[] {
  return [...(config?.channels || loadConfig().channels || [])];
}

export function findChannelInstance(channelId: string, config?: Config): ChannelInstance | undefined {
  return listChannelInstances(config).find((channel) => channel.id === channelId);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  const current: ConfigV2File = {
    schemaVersion: 2,
    runtime: {
      provider: config.runtime,
      defaultMode: config.defaultMode,
    },
    channels: config.channels || [],
  };
  const feishu = getChannelByProvider(current, 'feishu');
  const weixin = getChannelByProvider(current, 'weixin');
  const feishuConfig = toFeishuConfig(feishu);
  const weixinConfig = toWeixinConfig(weixin);
  m.set("remote_bridge_enabled", "true");
  if (config.defaultWorkspaceRoot) {
    m.set("bridge_default_workspace_root", config.defaultWorkspaceRoot);
  }
  if (config.defaultModel) {
    m.set("bridge_default_model", config.defaultModel);
    m.set("default_model", config.defaultModel);
  }
  m.set("bridge_default_mode", config.defaultMode);
  m.set(
    "bridge_history_message_limit",
    String(config.historyMessageLimit && config.historyMessageLimit > 0 ? config.historyMessageLimit : 8),
  );
  m.set(
    "bridge_codex_skip_git_repo_check",
    config.codexSkipGitRepoCheck === true ? "true" : "false",
  );
  m.set(
    "bridge_codex_sandbox_mode",
    config.codexSandboxMode || 'workspace-write',
  );
  m.set(
    "bridge_codex_reasoning_effort",
    config.codexReasoningEffort || 'medium',
  );
  m.set(
    "bridge_channel_instances_json",
    JSON.stringify(config.channels || []),
  );

  // Export flat settings for the remaining single-instance bridge consumers.
  m.set(
    "bridge_telegram_enabled",
    config.enabledChannels.includes("telegram") ? "true" : "false",
  );
  if (config.tgBotToken) m.set("telegram_bot_token", config.tgBotToken);
  if (config.tgAllowedUsers) m.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
  if (config.tgChatId) m.set("telegram_chat_id", config.tgChatId);

  m.set(
    "bridge_discord_enabled",
    config.enabledChannels.includes("discord") ? "true" : "false",
  );
  if (config.discordBotToken) m.set("bridge_discord_bot_token", config.discordBotToken);
  if (config.discordAllowedUsers) m.set("bridge_discord_allowed_users", config.discordAllowedUsers.join(","));
  if (config.discordAllowedChannels) m.set("bridge_discord_allowed_channels", config.discordAllowedChannels.join(","));
  if (config.discordAllowedGuilds) m.set("bridge_discord_allowed_guilds", config.discordAllowedGuilds.join(","));

  m.set(
    "bridge_feishu_enabled",
    feishu?.enabled === true ? "true" : "false",
  );
  if (feishuConfig?.appId) m.set("bridge_feishu_app_id", feishuConfig.appId);
  if (feishuConfig?.appSecret) m.set("bridge_feishu_app_secret", feishuConfig.appSecret);
  if (feishuConfig?.site) m.set("bridge_feishu_site", feishuConfig.site);
  if (feishuConfig?.allowedUsers) m.set("bridge_feishu_allowed_users", feishuConfig.allowedUsers.join(","));
  m.set(
    "bridge_feishu_streaming_enabled",
    feishuConfig?.streamingEnabled === false ? "false" : "true",
  );
  m.set(
    "bridge_feishu_command_markdown_enabled",
    feishuConfig?.feedbackMarkdownEnabled === false ? "false" : "true",
  );

  m.set(
    "bridge_qq_enabled",
    config.enabledChannels.includes("qq") ? "true" : "false",
  );
  if (config.qqAppId) m.set("bridge_qq_app_id", config.qqAppId);
  if (config.qqAppSecret) m.set("bridge_qq_app_secret", config.qqAppSecret);
  if (config.qqAllowedUsers) m.set("bridge_qq_allowed_users", config.qqAllowedUsers.join(","));
  if (config.qqImageEnabled !== undefined) {
    m.set("bridge_qq_image_enabled", String(config.qqImageEnabled));
  }
  if (config.qqMaxImageSize !== undefined) {
    m.set("bridge_qq_max_image_size", String(config.qqMaxImageSize));
  }

  m.set(
    "bridge_weixin_enabled",
    weixin?.enabled === true ? "true" : "false",
  );
  if (weixinConfig?.mediaEnabled !== undefined) {
    m.set("bridge_weixin_media_enabled", String(weixinConfig.mediaEnabled));
  }
  m.set(
    "bridge_weixin_command_markdown_enabled",
    weixinConfig?.feedbackMarkdownEnabled === true ? "true" : "false",
  );
  if (weixinConfig?.baseUrl) m.set("bridge_weixin_base_url", weixinConfig.baseUrl);
  if (weixinConfig?.cdnBaseUrl) m.set("bridge_weixin_cdn_base_url", weixinConfig.cdnBaseUrl);

  return m;
}
