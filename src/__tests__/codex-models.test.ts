import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findSelectableCodexModel,
  isCliOnlyCodexModel,
  listCachedCodexModels,
  listSelectableCodexModels,
  readConfiguredCodexModel,
} from '../codex-models.js';

describe('listCachedCodexModels', () => {
  it('returns an empty list when the cache file is missing', () => {
    const missing = path.join(os.tmpdir(), `codex-models-missing-${Date.now()}.json`);
    assert.deepEqual(listCachedCodexModels(missing), []);
  });

  it('parses and deduplicates cached models', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-test-'));
    const cachePath = path.join(tmpDir, 'models_cache.json');
    try {
      fs.writeFileSync(cachePath, JSON.stringify({
        models: [
          { slug: 'gpt-5.4', display_name: 'gpt-5.4', visibility: 'list', supported_in_api: true },
          { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', supported_in_api: true },
          { slug: 'gpt-5.4', display_name: 'duplicate', visibility: 'hide', supported_in_api: false },
          { slug: '', display_name: 'invalid', visibility: 'list', supported_in_api: true },
        ],
      }), 'utf-8');

      assert.deepEqual(listCachedCodexModels(cachePath), [
        {
          slug: 'gpt-5.4',
          displayName: 'gpt-5.4',
          visibility: 'list',
          supportedInApi: true,
          supportedReasoningLevels: [],
        },
        {
          slug: 'gpt-5.4-mini',
          displayName: 'GPT-5.4-Mini',
          visibility: 'list',
          supportedInApi: true,
          supportedReasoningLevels: [],
        },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads the top-level default model from Codex config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-test-'));
    const configPath = path.join(tmpDir, 'config.toml');
    try {
      fs.writeFileSync(configPath, [
        'model = "gpt-5.4"',
        'model_reasoning_effort = "xhigh"',
        '',
        '[windows]',
        'sandbox = "elevated"',
        '',
        '[profiles.fast]',
        'model = "gpt-5.4-mini"',
      ].join('\n'), 'utf-8');

      assert.equal(readConfiguredCodexModel(configPath), 'gpt-5.4');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('filters hidden models but keeps CLI-only models selectable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-test-'));
    const cachePath = path.join(tmpDir, 'models_cache.json');
    try {
      fs.writeFileSync(cachePath, JSON.stringify({
        models: [
          { slug: 'gpt-5.4', display_name: 'gpt-5.4', visibility: 'list', supported_in_api: true },
          { slug: 'gpt-5.3-codex-spark', display_name: 'gpt-5.3-codex-spark', visibility: 'list', supported_in_api: false },
          { slug: 'gpt-5-hidden', display_name: 'gpt-5-hidden', visibility: 'hide', supported_in_api: true },
        ],
      }), 'utf-8');

      assert.deepEqual(listSelectableCodexModels(cachePath), [
        {
          slug: 'gpt-5.4',
          displayName: 'gpt-5.4',
          visibility: 'list',
          supportedInApi: true,
          supportedReasoningLevels: [],
        },
        {
          slug: 'gpt-5.3-codex-spark',
          displayName: 'gpt-5.3-codex-spark',
          visibility: 'list',
          supportedInApi: false,
          supportedReasoningLevels: [],
        },
      ]);
      assert.deepEqual(findSelectableCodexModel('gpt-5-hidden', cachePath), null);
      assert.equal(isCliOnlyCodexModel(findSelectableCodexModel('gpt-5.3-codex-spark', cachePath)), true);
      assert.equal(isCliOnlyCodexModel(findSelectableCodexModel('gpt-5.4', cachePath)), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parses model-specific reasoning levels from the Codex model catalog', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-test-'));
    const cachePath = path.join(tmpDir, 'models_cache.json');
    try {
      fs.writeFileSync(cachePath, JSON.stringify({
        models: [
          {
            slug: 'gpt-5.6-sol',
            display_name: 'GPT-5.6-Sol',
            visibility: 'list',
            supported_in_api: true,
            default_reasoning_level: 'low',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Fast responses with lighter reasoning' },
              { effort: 'medium', description: 'Balances speed and reasoning depth' },
              { effort: 'max', description: 'Maximum reasoning depth' },
              { effort: 'max', description: 'Duplicate' },
              { effort: '', description: 'Invalid' },
            ],
          },
        ],
      }), 'utf-8');

      assert.deepEqual(listCachedCodexModels(cachePath), [
        {
          slug: 'gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          visibility: 'list',
          supportedInApi: true,
          defaultReasoningLevel: 'low',
          supportedReasoningLevels: [
            { effort: 'low', description: 'Fast responses with lighter reasoning' },
            { effort: 'medium', description: 'Balances speed and reasoning depth' },
            { effort: 'max', description: 'Maximum reasoning depth' },
          ],
        },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
