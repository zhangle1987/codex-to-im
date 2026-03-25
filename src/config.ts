import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface Config {
  runtime: 'claude' | 'codex' | 'auto';
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultWorkspaceRoot?: string;
  defaultModel?: string;
  defaultMode: string;
  historyMessageLimit?: number;
  codexSkipGitRepoCheck?: boolean;
  codexSandboxMode?: CodexSandboxMode;
  codexReasoningEffort?: CodexReasoningEffort;
  uiAllowLan?: boolean;
  uiAccessToken?: string;
  // Telegram
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  // Feishu
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  feishuStreamingEnabled?: boolean;
  feishuCommandMarkdownEnabled?: boolean;
  // Discord
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  // QQ
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
  // WeChat
  weixinBaseUrl?: string;
  weixinCdnBaseUrl?: string;
  weixinMediaEnabled?: boolean;
  weixinCommandMarkdownEnabled?: boolean;
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
}

const LEGACY_CTI_HOME = path.join(os.homedir(), ".claude-to-im");
const DEFAULT_CTI_HOME = path.join(os.homedir(), ".codex-to-im");
export const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), "cx2im");

function resolveDefaultCtiHome(): string {
  if (fs.existsSync(DEFAULT_CTI_HOME)) return DEFAULT_CTI_HOME;
  if (fs.existsSync(LEGACY_CTI_HOME)) return LEGACY_CTI_HOME;
  return DEFAULT_CTI_HOME;
}

export const CTI_HOME = process.env.CTI_HOME || resolveDefaultCtiHome();
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");

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
    // Strip surrounding quotes
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

function parseSandboxMode(value: string | undefined): CodexSandboxMode | undefined {
  if (
    value === 'read-only'
    || value === 'workspace-write'
    || value === 'danger-full-access'
  ) {
    return value;
  }
  return undefined;
}

function parseReasoningEffort(value: string | undefined): CodexReasoningEffort | undefined {
  if (
    value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
  ) {
    return value;
  }
  return undefined;
}

export function loadConfig(): Config {
  const env = loadRawConfigEnv();

  const rawRuntime = env.get("CTI_RUNTIME") || "codex";
  const runtime = (["claude", "codex", "auto"].includes(rawRuntime) ? rawRuntime : "codex") as Config["runtime"];

  return {
    runtime,
    enabledChannels: splitCsv(env.get("CTI_ENABLED_CHANNELS")) ?? ["feishu"],
    defaultWorkDir: expandHomePath(env.get("CTI_DEFAULT_WORKDIR")) || process.cwd(),
    defaultWorkspaceRoot: expandHomePath(env.get("CTI_DEFAULT_WORKSPACE_ROOT")) || DEFAULT_WORKSPACE_ROOT,
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
    tgBotToken: env.get("CTI_TG_BOT_TOKEN") || undefined,
    tgChatId: env.get("CTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(env.get("CTI_TG_ALLOWED_USERS")),
    feishuAppId: env.get("CTI_FEISHU_APP_ID") || undefined,
    feishuAppSecret: env.get("CTI_FEISHU_APP_SECRET") || undefined,
    feishuDomain: env.get("CTI_FEISHU_DOMAIN") || undefined,
    feishuAllowedUsers: splitCsv(env.get("CTI_FEISHU_ALLOWED_USERS")),
    feishuStreamingEnabled: env.has("CTI_FEISHU_STREAMING_ENABLED")
      ? env.get("CTI_FEISHU_STREAMING_ENABLED") === "true"
      : true,
    feishuCommandMarkdownEnabled: env.has("CTI_FEISHU_COMMAND_MARKDOWN_ENABLED")
      ? env.get("CTI_FEISHU_COMMAND_MARKDOWN_ENABLED") === "true"
      : true,
    discordBotToken: env.get("CTI_DISCORD_BOT_TOKEN") || undefined,
    discordAllowedUsers: splitCsv(env.get("CTI_DISCORD_ALLOWED_USERS")),
    discordAllowedChannels: splitCsv(
      env.get("CTI_DISCORD_ALLOWED_CHANNELS")
    ),
    discordAllowedGuilds: splitCsv(env.get("CTI_DISCORD_ALLOWED_GUILDS")),
    qqAppId: env.get("CTI_QQ_APP_ID") || undefined,
    qqAppSecret: env.get("CTI_QQ_APP_SECRET") || undefined,
    qqAllowedUsers: splitCsv(env.get("CTI_QQ_ALLOWED_USERS")),
    qqImageEnabled: env.has("CTI_QQ_IMAGE_ENABLED")
      ? env.get("CTI_QQ_IMAGE_ENABLED") === "true"
      : undefined,
    qqMaxImageSize: env.get("CTI_QQ_MAX_IMAGE_SIZE")
      ? Number(env.get("CTI_QQ_MAX_IMAGE_SIZE"))
      : undefined,
    weixinBaseUrl: env.get("CTI_WEIXIN_BASE_URL") || undefined,
    weixinCdnBaseUrl: env.get("CTI_WEIXIN_CDN_BASE_URL") || undefined,
    weixinMediaEnabled: env.has("CTI_WEIXIN_MEDIA_ENABLED")
      ? env.get("CTI_WEIXIN_MEDIA_ENABLED") === "true"
      : undefined,
    weixinCommandMarkdownEnabled: env.has("CTI_WEIXIN_COMMAND_MARKDOWN_ENABLED")
      ? env.get("CTI_WEIXIN_COMMAND_MARKDOWN_ENABLED") === "true"
      : false,
    autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = "";
  out += formatEnvLine("CTI_RUNTIME", config.runtime);
  out += formatEnvLine(
    "CTI_ENABLED_CHANNELS",
    config.enabledChannels.join(",")
  );
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  out += formatEnvLine("CTI_DEFAULT_WORKSPACE_ROOT", config.defaultWorkspaceRoot);
  if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  if (config.historyMessageLimit !== undefined)
    out += formatEnvLine("CTI_HISTORY_MESSAGE_LIMIT", String(config.historyMessageLimit));
  if (config.codexSkipGitRepoCheck !== undefined)
    out += formatEnvLine("CTI_CODEX_SKIP_GIT_REPO_CHECK", String(config.codexSkipGitRepoCheck));
  out += formatEnvLine("CTI_CODEX_SANDBOX_MODE", config.codexSandboxMode);
  out += formatEnvLine("CTI_CODEX_REASONING_EFFORT", config.codexReasoningEffort);
  out += formatEnvLine("CTI_UI_ALLOW_LAN", String(config.uiAllowLan === true));
  out += formatEnvLine("CTI_UI_ACCESS_TOKEN", config.uiAccessToken);
  out += formatEnvLine("CTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("CTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine(
    "CTI_TG_ALLOWED_USERS",
    config.tgAllowedUsers?.join(",")
  );
  out += formatEnvLine("CTI_FEISHU_APP_ID", config.feishuAppId);
  out += formatEnvLine("CTI_FEISHU_APP_SECRET", config.feishuAppSecret);
  out += formatEnvLine("CTI_FEISHU_DOMAIN", config.feishuDomain);
  out += formatEnvLine(
    "CTI_FEISHU_ALLOWED_USERS",
    config.feishuAllowedUsers?.join(",")
  );
  if (config.feishuStreamingEnabled !== undefined)
    out += formatEnvLine(
      "CTI_FEISHU_STREAMING_ENABLED",
      String(config.feishuStreamingEnabled)
    );
  if (config.feishuCommandMarkdownEnabled !== undefined)
    out += formatEnvLine(
      "CTI_FEISHU_COMMAND_MARKDOWN_ENABLED",
      String(config.feishuCommandMarkdownEnabled)
    );
  out += formatEnvLine("CTI_DISCORD_BOT_TOKEN", config.discordBotToken);
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_USERS",
    config.discordAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_CHANNELS",
    config.discordAllowedChannels?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_GUILDS",
    config.discordAllowedGuilds?.join(",")
  );
  out += formatEnvLine("CTI_QQ_APP_ID", config.qqAppId);
  out += formatEnvLine("CTI_QQ_APP_SECRET", config.qqAppSecret);
  out += formatEnvLine(
    "CTI_QQ_ALLOWED_USERS",
    config.qqAllowedUsers?.join(",")
  );
  if (config.qqImageEnabled !== undefined)
    out += formatEnvLine("CTI_QQ_IMAGE_ENABLED", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    out += formatEnvLine("CTI_QQ_MAX_IMAGE_SIZE", String(config.qqMaxImageSize));
  out += formatEnvLine("CTI_WEIXIN_BASE_URL", config.weixinBaseUrl);
  out += formatEnvLine("CTI_WEIXIN_CDN_BASE_URL", config.weixinCdnBaseUrl);
  if (config.weixinMediaEnabled !== undefined)
    out += formatEnvLine("CTI_WEIXIN_MEDIA_ENABLED", String(config.weixinMediaEnabled));
  if (config.weixinCommandMarkdownEnabled !== undefined)
    out += formatEnvLine(
      "CTI_WEIXIN_COMMAND_MARKDOWN_ENABLED",
      String(config.weixinCommandMarkdownEnabled)
    );
  out += formatEnvLine("CTI_AUTO_APPROVE", String(config.autoApprove === true));

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set("remote_bridge_enabled", "true");

  // ── Telegram ──
  // Upstream keys: telegram_bot_token, bridge_telegram_enabled,
  //   telegram_bridge_allowed_users, telegram_chat_id
  m.set(
    "bridge_telegram_enabled",
    config.enabledChannels.includes("telegram") ? "true" : "false"
  );
  if (config.tgBotToken) m.set("telegram_bot_token", config.tgBotToken);
  if (config.tgAllowedUsers)
    m.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
  if (config.tgChatId) m.set("telegram_chat_id", config.tgChatId);

  // ── Discord ──
  // Upstream keys: bridge_discord_bot_token, bridge_discord_enabled,
  //   bridge_discord_allowed_users, bridge_discord_allowed_channels,
  //   bridge_discord_allowed_guilds
  m.set(
    "bridge_discord_enabled",
    config.enabledChannels.includes("discord") ? "true" : "false"
  );
  if (config.discordBotToken)
    m.set("bridge_discord_bot_token", config.discordBotToken);
  if (config.discordAllowedUsers)
    m.set("bridge_discord_allowed_users", config.discordAllowedUsers.join(","));
  if (config.discordAllowedChannels)
    m.set(
      "bridge_discord_allowed_channels",
      config.discordAllowedChannels.join(",")
    );
  if (config.discordAllowedGuilds)
    m.set(
      "bridge_discord_allowed_guilds",
      config.discordAllowedGuilds.join(",")
    );

  // ── Feishu ──
  // Upstream keys: bridge_feishu_app_id, bridge_feishu_app_secret,
  //   bridge_feishu_domain, bridge_feishu_enabled, bridge_feishu_allowed_users
  m.set(
    "bridge_feishu_enabled",
    config.enabledChannels.includes("feishu") ? "true" : "false"
  );
  if (config.feishuAppId) m.set("bridge_feishu_app_id", config.feishuAppId);
  if (config.feishuAppSecret)
    m.set("bridge_feishu_app_secret", config.feishuAppSecret);
  if (config.feishuDomain) m.set("bridge_feishu_domain", config.feishuDomain);
  if (config.feishuAllowedUsers)
    m.set("bridge_feishu_allowed_users", config.feishuAllowedUsers.join(","));
  m.set(
    "bridge_feishu_streaming_enabled",
    config.feishuStreamingEnabled === false ? "false" : "true"
  );
  m.set(
    "bridge_feishu_command_markdown_enabled",
    config.feishuCommandMarkdownEnabled === false ? "false" : "true"
  );

  // ── QQ ──
  // Upstream keys: bridge_qq_enabled, bridge_qq_app_id, bridge_qq_app_secret,
  //   bridge_qq_allowed_users, bridge_qq_image_enabled, bridge_qq_max_image_size
  m.set(
    "bridge_qq_enabled",
    config.enabledChannels.includes("qq") ? "true" : "false"
  );
  if (config.qqAppId) m.set("bridge_qq_app_id", config.qqAppId);
  if (config.qqAppSecret) m.set("bridge_qq_app_secret", config.qqAppSecret);
  if (config.qqAllowedUsers)
    m.set("bridge_qq_allowed_users", config.qqAllowedUsers.join(","));
  if (config.qqImageEnabled !== undefined)
    m.set("bridge_qq_image_enabled", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    m.set("bridge_qq_max_image_size", String(config.qqMaxImageSize));

  // ── WeChat ──
  // Upstream keys: bridge_weixin_enabled, bridge_weixin_media_enabled,
  //   bridge_weixin_base_url, bridge_weixin_cdn_base_url
  m.set(
    "bridge_weixin_enabled",
    config.enabledChannels.includes("weixin") ? "true" : "false"
  );
  if (config.weixinMediaEnabled !== undefined)
    m.set("bridge_weixin_media_enabled", String(config.weixinMediaEnabled));
  m.set(
    "bridge_weixin_command_markdown_enabled",
    config.weixinCommandMarkdownEnabled === true ? "true" : "false"
  );
  if (config.weixinBaseUrl)
    m.set("bridge_weixin_base_url", config.weixinBaseUrl);
  if (config.weixinCdnBaseUrl)
    m.set("bridge_weixin_cdn_base_url", config.weixinCdnBaseUrl);

  // ── Defaults ──
  // Upstream keys: bridge_default_work_dir, bridge_default_workspace_root,
  // bridge_default_model, default_model, bridge_codex_sandbox_mode,
  // bridge_codex_reasoning_effort
  m.set("bridge_default_work_dir", config.defaultWorkDir);
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
    String(config.historyMessageLimit && config.historyMessageLimit > 0 ? config.historyMessageLimit : 8)
  );
  m.set(
    "bridge_codex_skip_git_repo_check",
    config.codexSkipGitRepoCheck === true ? "true" : "false"
  );
  m.set(
    "bridge_codex_sandbox_mode",
    config.codexSandboxMode || 'workspace-write',
  );
  m.set(
    "bridge_codex_reasoning_effort",
    config.codexReasoningEffort || 'medium',
  );

  return m;
}
