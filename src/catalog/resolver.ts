import type { Catalog, CircuitState, Queue, Rung } from '../types';

const bgCatalog = require('./background.json') as Catalog;
const fgCatalog = require('./foreground.json') as Catalog;

const CATALOGS: Record<Queue, Catalog> = {
  background: bgCatalog,
  foreground: fgCatalog,
};

export class CatalogResolver {
  private readonly catalog: Catalog;

  constructor(queue: Queue) {
    this.catalog = CATALOGS[queue];
  }

  static forQueue(queue: Queue): CatalogResolver {
    return new CatalogResolver(queue);
  }

  getCatalog(): Catalog {
    return this.catalog;
  }

  /**
   * Resolve the provider ladder for a given asset request.
   * Key format: "{assetType}.{tier}.{operation}" — falls back to "{assetType}" for
   * flat keys like "sfx" or "llm".
   */
  getLadder(assetType: string, tier?: string, operation?: string): Rung[] {
    const keys: string[] = [];

    if (tier && operation) {
      keys.push(`${assetType}.${tier}.${operation}`);
    }
    if (tier) {
      keys.push(`${assetType}.${tier}`);
    }
    keys.push(assetType);

    for (const key of keys) {
      const entry = this.catalog.ladders[key];
      if (!entry) continue;

      if ('aliasOf' in entry) {
        return this.resolveAlias(entry.aliasOf);
      }
      return entry as Rung[];
    }

    return [];
  }

  /**
   * Follow one level of aliasOf indirection.
   */
  resolveAlias(aliasKey: string): Rung[] {
    const entry = this.catalog.ladders[aliasKey];
    if (!entry) return [];
    if ('aliasOf' in entry) {
      // Only one level of aliasing is supported
      return this.resolveAlias(entry.aliasOf);
    }
    return entry as Rung[];
  }

  /**
   * Filter out rungs whose circuit is OPEN, so the executor skips dead endpoints.
   * circuitState is a map of "{provider}:{endpoint|model}" -> CircuitState.
   */
  healthyRungs(ladder: Rung[], circuitState: Record<string, CircuitState>): Rung[] {
    return ladder.filter(rung => {
      const key = `${rung.provider}:${rung.endpoint ?? rung.model}`;
      return circuitState[key] !== 'OPEN';
    });
  }

  /**
   * Look up the provider config (limits, floors, secretEnv).
   */
  getProviderConfig(provider: string) {
    return this.catalog.providers[provider];
  }

  getCircuitConfig() {
    return this.catalog.circuit;
  }

  getVersion() {
    return this.catalog.version;
  }
}
