/**
 * Registry of external libraries the analyzer can recognize from script URLs.
 * In v1 only jQuery itself is supported; every other external script produces a
 * refusal. In v2 this registry grows mapping entries (source library → React
 * equivalents, versions, licenses) — the refusal machinery is the seed of that.
 */

export interface LibraryMatch {
  name: string;
  supported: boolean;
}

const REGISTRY: ReadonlyArray<{ pattern: RegExp; name: string; supported: boolean }> = [
  { pattern: /jquery/i, name: 'jquery', supported: true },
  { pattern: /ag-grid/i, name: 'ag-grid', supported: false },
  { pattern: /devextreme|dx\.all/i, name: 'devextreme', supported: false },
  { pattern: /datatables/i, name: 'datatables', supported: false },
  { pattern: /select2/i, name: 'select2', supported: false },
  { pattern: /knockout/i, name: 'knockout', supported: false },
  { pattern: /bootstrap/i, name: 'bootstrap', supported: false },
  { pattern: /moment(\.min)?\.js/i, name: 'moment', supported: false },
];

export function classifyExternalScript(url: string): LibraryMatch {
  for (const entry of REGISTRY) {
    if (entry.pattern.test(url)) {
      return { name: entry.name, supported: entry.supported };
    }
  }
  return { name: 'unknown', supported: false };
}

export function isExternalUrl(path: string): boolean {
  return /^(https?:)?\/\//i.test(path);
}
