import type { Asset, Finding } from '../../types/ir';

/** A referenced local file that doesn't exist is a guaranteed runtime failure. */
export function assetFindings(assets: Asset[]): Finding[] {
  const findings: Finding[] = [];
  for (const asset of assets) {
    if (!asset.external && asset.exists === false) {
      findings.push({
        rule: 'broken-asset-reference',
        severity: 'error',
        message: `Referenced ${asset.kind} '${asset.path}' does not exist in the input folder.`,
        file: asset.file,
        line: asset.line,
      });
    }
  }
  return findings;
}
