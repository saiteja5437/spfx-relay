import type { Dependency, Refusal } from '../../types/ir';

/**
 * Unsupported external dependencies produce refusals, not guesses. This is the
 * v1 seed of the v2 plugin-mapping engine: detection already works; v2 upgrades
 * each refusal to a user-approved mapping (same plugin via its React wrapper,
 * or a recommended replacement, with version/license metadata).
 */
export function pluginRefusals(dependencies: Dependency[]): Refusal[] {
  const refusals: Refusal[] = [];
  for (const dep of dependencies) {
    if (dep.supported) continue;
    if (dep.name === 'unknown') {
      refusals.push({
        construct: 'unknown-external-script',
        reason: `Unrecognized external script '${dep.source}' — cannot verify what it does; migrate it manually.`,
        file: dep.file,
        line: dep.line,
      });
    } else {
      refusals.push({
        construct: 'external-plugin',
        reason: `External library '${dep.name}' (${dep.source}) is not supported in v1 — this dependency requires manual migration.`,
        file: dep.file,
        line: dep.line,
      });
    }
  }
  return refusals;
}
