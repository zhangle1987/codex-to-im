import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CachedCodexModel {
  slug: string;
  displayName: string;
  visibility: string;
  supportedInApi: boolean;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: Array<{
    effort: string;
    description: string;
  }>;
}

export const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

interface RawModelsCache {
  models?: Array<{
    slug?: unknown;
    display_name?: unknown;
    visibility?: unknown;
    supported_in_api?: unknown;
    default_reasoning_level?: unknown;
    supported_reasoning_levels?: unknown;
  }>;
}

export const DEFAULT_CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');

const REASONING_LEVEL_DESCRIPTIONS: Record<string, string> = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for very hard problems',
  ultra: 'Ultra reasoning depth for the hardest problems',
};

function buildReasoningLevels(efforts: string[]): CachedCodexModel['supportedReasoningLevels'] {
  return efforts.map((effort) => ({
    effort,
    description: REASONING_LEVEL_DESCRIPTIONS[effort] || '',
  }));
}

function cloneCodexModel(model: CachedCodexModel): CachedCodexModel {
  return {
    ...model,
    supportedReasoningLevels: model.supportedReasoningLevels.map((level) => ({ ...level })),
  };
}

export const KNOWN_CODEX_MODEL_FALLBACKS: CachedCodexModel[] = [
  {
    slug: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    visibility: 'list',
    supportedInApi: true,
    defaultReasoningLevel: 'low',
    supportedReasoningLevels: buildReasoningLevels(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  },
  {
    slug: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    visibility: 'list',
    supportedInApi: true,
    defaultReasoningLevel: 'medium',
    supportedReasoningLevels: buildReasoningLevels(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  },
  {
    slug: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    visibility: 'list',
    supportedInApi: true,
    defaultReasoningLevel: 'medium',
    supportedReasoningLevels: buildReasoningLevels(['low', 'medium', 'high', 'xhigh', 'max']),
  },
];

export function readConfiguredCodexModel(configPath = DEFAULT_CODEX_CONFIG_PATH): string | null {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    let inSection = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSection = true;
        continue;
      }
      if (inSection) continue;
      const match = trimmed.match(/^model\s*=\s*["']([^"']+)["']/);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

function parseReasoningLevel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseSupportedReasoningLevels(value: unknown): CachedCodexModel['supportedReasoningLevels'] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const levels: CachedCodexModel['supportedReasoningLevels'] = [];
  for (const level of value) {
    if (!level || typeof level !== 'object') continue;
    const raw = level as { effort?: unknown; description?: unknown };
    const effort = parseReasoningLevel(raw.effort);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    levels.push({
      effort,
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
    });
  }
  return levels;
}

export function listCachedCodexModels(cachePath = DEFAULT_CODEX_MODELS_CACHE_PATH): CachedCodexModel[] {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as RawModelsCache;
    if (!Array.isArray(parsed.models)) return [];

    const seen = new Set<string>();
    const models: CachedCodexModel[] = [];
    for (const model of parsed.models) {
      if (typeof model?.slug !== 'string' || !model.slug.trim()) continue;
      const slug = model.slug.trim();
      if (seen.has(slug)) continue;
      seen.add(slug);
      const defaultReasoningLevel = parseReasoningLevel(model.default_reasoning_level);
      models.push({
        slug,
        displayName: typeof model.display_name === 'string' && model.display_name.trim()
          ? model.display_name.trim()
          : slug,
        visibility: typeof model.visibility === 'string' && model.visibility.trim()
          ? model.visibility.trim()
          : 'list',
        supportedInApi: model.supported_in_api === true,
        supportedReasoningLevels: parseSupportedReasoningLevels(model.supported_reasoning_levels),
        ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
      });
    }
    return models;
  } catch {
    return [];
  }
}

export function listSelectableCodexModels(cachePath = DEFAULT_CODEX_MODELS_CACHE_PATH): CachedCodexModel[] {
  return listCachedCodexModels(cachePath).filter((model) => model.visibility !== 'hide');
}

function buildSyntheticCodexModel(slug: string): CachedCodexModel | null {
  const normalized = slug.trim();
  if (!normalized) return null;
  return {
    slug: normalized,
    displayName: normalized,
    visibility: 'list',
    supportedInApi: true,
    supportedReasoningLevels: [],
  };
}

export function listAvailableCodexModels(
  cachePath = DEFAULT_CODEX_MODELS_CACHE_PATH,
  additionalModelSlugs: string[] = [],
): CachedCodexModel[] {
  const cachedModels = listCachedCodexModels(cachePath);
  const hiddenCachedSlugs = new Set(
    cachedModels
      .filter((model) => model.visibility === 'hide')
      .map((model) => model.slug),
  );
  const merged: CachedCodexModel[] = [];
  const seen = new Set<string>();

  const addModel = (model: CachedCodexModel, force = false) => {
    if (!force && hiddenCachedSlugs.has(model.slug)) return;
    if (seen.has(model.slug)) return;
    seen.add(model.slug);
    merged.push(cloneCodexModel(model));
  };

  for (const model of cachedModels) {
    if (model.visibility !== 'hide') {
      addModel(model, true);
    }
  }
  for (const model of KNOWN_CODEX_MODEL_FALLBACKS) {
    addModel(model);
  }
  for (const slug of additionalModelSlugs) {
    const syntheticModel = buildSyntheticCodexModel(slug);
    if (syntheticModel) {
      addModel(syntheticModel, true);
    }
  }

  return merged;
}

export function findSelectableCodexModel(
  slug: string,
  cachePath = DEFAULT_CODEX_MODELS_CACHE_PATH,
): CachedCodexModel | null {
  const normalized = slug.trim();
  if (!normalized) return null;
  return listSelectableCodexModels(cachePath).find((model) => model.slug === normalized) || null;
}

export function findAvailableCodexModel(
  slug: string,
  cachePath = DEFAULT_CODEX_MODELS_CACHE_PATH,
  additionalModelSlugs: string[] = [],
): CachedCodexModel | null {
  const normalized = slug.trim();
  if (!normalized) return null;
  return listAvailableCodexModels(cachePath, additionalModelSlugs).find((model) => model.slug === normalized) || null;
}

export function isCliOnlyCodexModel(model: Pick<CachedCodexModel, 'supportedInApi'> | null | undefined): boolean {
  return !!model && model.supportedInApi === false;
}
