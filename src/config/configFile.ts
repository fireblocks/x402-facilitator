/**
 * ConfigFile — loads, validates, and atomically writes facilitator.json.
 *
 * - Load-once semantics: the file is parsed at boot and cached.
 *   Call reload() after a write to pick up changes.
 * - Writes are atomic: serialize to a tempfile and rename into place
 *   so concurrent readers never see a partial file.
 *
 * Helpers update a single configuration within the list by id, which
 * is what every CLI command needs.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  AssetShape,
  ConfigFileShape,
  ConfigurationShape,
  configFileSchema,
} from './configSchema';

export class ConfigFile {
  private cache: ConfigFileShape | null = null;

  constructor(public readonly filePath: string) {}

  get(): ConfigFileShape {
    if (!this.cache) this.cache = this.load();
    return this.cache;
  }

  reload(): ConfigFileShape {
    this.cache = this.load();
    return this.cache;
  }

  write(next: ConfigFileShape): void {
    const validated = configFileSchema.parse(next);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.facilitator.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(validated, null, 2) + os.EOL, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    this.cache = validated;
  }

  update(mutator: (current: ConfigFileShape) => ConfigFileShape): ConfigFileShape {
    const next = mutator(this.get());
    this.write(next);
    return next;
  }

  /** Convenience: read one configuration by id. Throws on miss. */
  getConfiguration(configurationId: string): ConfigurationShape {
    const c = this.get().configurations.find((x) => x.configuration_id === configurationId);
    if (!c) {
      throw new Error(`No configuration with configuration_id='${configurationId}'`);
    }
    return c;
  }

  findConfiguration(configurationId: string): ConfigurationShape | undefined {
    return this.get().configurations.find((x) => x.configuration_id === configurationId);
  }

  defaultConfigurationId(): string {
    return this.get().default_configuration_id;
  }

  /**
   * Convenience: apply a mutator to a single configuration (by id) and
   * persist. Throws if the configuration doesn't exist.
   */
  updateConfiguration(
    configurationId: string,
    mutator: (current: ConfigurationShape) => ConfigurationShape,
  ): ConfigurationShape {
    let next: ConfigurationShape | null = null;
    this.update((cur) => {
      const idx = cur.configurations.findIndex((x) => x.configuration_id === configurationId);
      if (idx < 0) {
        throw new Error(`No configuration with configuration_id='${configurationId}'`);
      }
      next = mutator(cur.configurations[idx]);
      const copy = [...cur.configurations];
      copy[idx] = next;
      return { ...cur, configurations: copy };
    });
    return next!;
  }

  findAsset(assetId: string): AssetShape | undefined {
    return this.get().assets.find((a) => a.asset_id === assetId);
  }

  /**
   * Upsert an asset in the top-level catalog.
   * `replaceExisting: false` → throw if an asset with the same id exists.
   */
  upsertAsset(entry: AssetShape, opts: { replaceExisting?: boolean } = {}): void {
    const { replaceExisting = true } = opts;
    this.update((cur) => {
      const existing = cur.assets.findIndex((a) => a.asset_id === entry.asset_id);
      if (existing >= 0 && !replaceExisting) {
        throw new Error(`Asset ${entry.asset_id} already exists`);
      }
      const next = [...cur.assets];
      if (existing >= 0) next[existing] = entry;
      else next.push(entry);
      return { ...cur, assets: next };
    });
  }

  removeAsset(assetId: string): boolean {
    let removed = false;
    this.update((cur) => {
      const next = cur.assets.filter((a) => {
        if (a.asset_id === assetId) {
          removed = true;
          return false;
        }
        return true;
      });
      return { ...cur, assets: next };
    });
    return removed;
  }

  private load(): ConfigFileShape {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(
        `Config file not found: ${this.filePath}\n` +
          `Run 'x402 init' to scaffold a starter config.`,
      );
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in ${this.filePath}: ${(err as Error).message}`);
    }
    const result = configFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid config in ${this.filePath}:\n${issues}`);
    }
    return result.data;
  }
}

export function resolveConfigPath(): string {
  if (process.env.CONFIG_PATH) return path.resolve(process.env.CONFIG_PATH);
  return path.resolve(process.cwd(), 'config', 'facilitator.json');
}

let globalConfigFile: ConfigFile | null = null;

export function getConfigFile(): ConfigFile {
  if (!globalConfigFile) globalConfigFile = new ConfigFile(resolveConfigPath());
  return globalConfigFile;
}

export function setConfigFile(file: ConfigFile): void {
  globalConfigFile = file;
}
