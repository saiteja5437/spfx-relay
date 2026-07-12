import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { analyzeCouplingDir, type CouplingReport } from './analyze/coupling';
import { analyzeWebPart } from './analyze/index';
import { emitProject } from './emit/index';
import { runEval } from './eval/index';
import { renderEvalMarkdown } from './eval/render';
import { FileResponseCache, type ResponseCache } from './pipeline/cache';
import { loadSourceFiles } from './pipeline/context';
import { RunManifest } from './pipeline/manifest';
import { buildPlan, type MigrationPlan } from './pipeline/plan';
import { runVerifiedTransform } from './pipeline/verifiedTransform';
import { createProvider, type ProviderConfig } from './providers/index';
import { renderReport, type ReportArgs } from './report/index';
import { runBundleSeal, type BundleResult } from './verify/bundle';

/**
 * spfx-relay migrate <input> --out <dir> [options]
 *
 * analyze → plan (approved by the user) → transform (sealed LLM step with
 * compile-repair) → verify → emit → bundle seal → report. A blocked plan or a
 * failed verification still produces a report — the tool never exits silently.
 */

export interface MigrateOptions {
  command: 'migrate';
  input: string;
  out: string;
  provider: 'anthropic' | 'ollama';
  model?: string;
  /** Component name override; otherwise derived from the input folder. */
  name?: string;
  /** Strategy override — applied through the safe-direction rule at plan time. */
  strategy?: 'spa' | 'decompose';
  yes: boolean;
  noCache: boolean;
  skipBundle: boolean;
  force: boolean;
}

export interface EvalOptions {
  command: 'eval';
  provider: 'anthropic' | 'ollama';
  model?: string;
  corpus: string;
  noCache: boolean;
}

export type CliOptions = MigrateOptions | EvalOptions;

export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      provider: { type: 'string', default: 'anthropic' },
      model: { type: 'string' },
      name: { type: 'string' },
      strategy: { type: 'string' },
      corpus: { type: 'string', default: 'corpus' },
      yes: { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      'skip-bundle': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });

  const [command, input] = positionals;
  if (values.provider !== 'anthropic' && values.provider !== 'ollama') {
    throw new Error(`Unknown provider '${values.provider}' — supported: anthropic, ollama.`);
  }

  if (command === 'eval') {
    return {
      command: 'eval',
      provider: values.provider,
      model: values.model,
      corpus: values.corpus,
      noCache: values['no-cache'],
    };
  }

  if (command !== 'migrate') {
    throw new Error(
      `Unknown command '${command ?? ''}' — usage: spfx-relay migrate <input> --out <dir> | spfx-relay eval [--corpus <dir>]`,
    );
  }
  if (!input) throw new Error('Missing <input>: the folder containing the legacy web part (index.html + assets).');
  if (!values.out) throw new Error('Missing --out: the folder to emit the SPFx project into.');
  const strategy = values.strategy === 'spa' || values.strategy === 'decompose' ? values.strategy : undefined;
  if (values.strategy !== undefined && strategy === undefined) {
    throw new Error(`Unknown strategy '${values.strategy}' — supported overrides: spa, decompose.`);
  }

  return {
    command: 'migrate',
    input,
    out: values.out,
    provider: values.provider,
    model: values.model,
    name: values.name,
    strategy,
    yes: values.yes,
    noCache: values['no-cache'],
    skipBundle: values['skip-bundle'],
    force: values.force,
  };
}

/**
 * Derives the migration name from the input path, skipping generic folder
 * names ('input', 'src', 'source') that describe layout rather than the web part.
 */
export function migrationNameFrom(inputDir: string): string {
  const generic = new Set(['input', 'src', 'source', 'legacy']);
  let dir = inputDir;
  while (generic.has(basename(dir).toLowerCase())) {
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return basename(dir);
}

export function providerConfigFrom(
  options: Pick<EvalOptions, 'provider' | 'model'>,
  env: NodeJS.ProcessEnv,
): ProviderConfig {
  if (options.provider === 'anthropic') {
    return {
      provider: 'anthropic',
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      ...(options.model ? { model: options.model } : {}),
    };
  }
  return { provider: 'ollama', model: options.model ?? 'llama3.1' };
}

export function renderPlan(plan: MigrationPlan): string {
  const lines = [
    '',
    `Migration plan — ${plan.componentName}`,
    `  Source files:      ${plan.sourceFiles.join(', ')}`,
    `  DOM operations:    ${plan.stats.domOperations}`,
    `  Event handlers:    ${plan.stats.eventHandlers}`,
    `  Network calls:     ${plan.stats.networkCalls}`,
    `  Dependencies:      ${plan.stats.dependencies}`,
  ];
  if (plan.strategy) {
    lines.push(`  Strategy:          ${plan.strategy.recommendation}`);
    for (const part of plan.strategy.parts) lines.push(`    ${part.name}  ←  ${part.rootSelector}`);
    for (const reason of plan.strategy.reasons) lines.push(`    ${reason}`);
  }
  if (plan.findings.length > 0) {
    lines.push(`  Flagged issues:`);
    for (const f of plan.findings) lines.push(`    - [${f.rule}] ${f.file}:${f.line} ${f.message}`);
  }
  if (plan.refusals.length > 0) {
    lines.push(`  REFUSED (manual migration required):`);
    for (const r of plan.refusals) lines.push(`    - [${r.construct}] ${r.file}:${r.line} ${r.reason}`);
  }
  lines.push(plan.blocked ? '  => Plan is BLOCKED: no transform will run.' : '  => Ready to transform.');
  return lines.join('\n');
}

export interface StrategyDecision {
  /** What steps 03/05/06 execute — runtime input, deliberately NOT stored in the plan. */
  chosen: 'single' | 'decompose' | 'spa';
  /** Set only when the override is unsafe; the run must exit blocked (2). */
  refusal?: string;
  /** Printed before plan approval (ignored-flag note, tolerance-override warning). */
  notes: string[];
}

/**
 * The safe-direction rule: merging (→ spa) can never break behavior, so it is
 * always allowed. Splitting (→ decompose) against detected coupling edges WOULD
 * break shared state, so it is refused — the tool cannot be forced into a guess.
 * When spa was recommended only because too many lookups were unattributable
 * (zero edges), the user may know the page better than static analysis: allow
 * the split, but say loudly what the analysis could not see.
 */
export function resolveStrategy(coupling: CouplingReport, override?: 'spa' | 'decompose'): StrategyDecision {
  const recommendation = coupling.recommendation;
  if (!override || override === recommendation) return { chosen: recommendation, notes: [] };

  if (recommendation === 'single') {
    return {
      chosen: 'single',
      notes: [`Note: --strategy ${override} ignored — this page has at most one widget region; the single-web-part path applies.`],
    };
  }

  if (override === 'spa') {
    return { chosen: 'spa', notes: ['Strategy override: decompose → spa (safe direction — merging cannot break behavior).'] };
  }

  // override === 'decompose', recommendation === 'spa'
  if (coupling.edges.length > 0) {
    const refusal = [
      `--strategy decompose refused: ${coupling.edges.length} coupling edge(s) tie these regions together — splitting shared state breaks the page.`,
      ...coupling.edges.map((edge) => `  - [${edge.kind}] ${edge.from} ↔ ${edge.to} via '${edge.evidence}' (${edge.file}:${edge.line})`),
    ].join('\n');
    return { chosen: 'spa', refusal, notes: [] };
  }

  return {
    chosen: 'decompose',
    notes: [
      `WARNING: overriding spa → decompose. ${coupling.unattributed} DOM lookup(s) could not be statically attributed to a region — the split is on YOUR judgment; verify each part against the original page.`,
    ],
  };
}

async function approved(yes: boolean): Promise<boolean> {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Proceed with this plan? [y/N] ')).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

function writeRunArtifacts(outDir: string, report: ReportArgs, manifest: RunManifest): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'migration-report.md'), renderReport(report));
  manifest.save(join(outDir, 'run-manifest.json'));
  console.log(`\nReport:   ${join(outDir, 'migration-report.md')}`);
  console.log(`Manifest: ${join(outDir, 'run-manifest.json')}`);
}

export async function main(argv: string[]): Promise<number> {
  const options = parseCliArgs(argv);
  if (options.command === 'eval') return runEvalCommand(options);
  const inputDir = resolve(options.input);
  const outDir = resolve(options.out);

  if (!existsSync(inputDir)) {
    console.error(`Input folder not found: ${inputDir}`);
    return 1;
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && !options.force) {
    console.error(`Output folder is not empty: ${outDir} — pass --force to write into it anyway.`);
    return 1;
  }

  const manifest = new RunManifest();
  const cache: ResponseCache | undefined = options.noCache
    ? undefined
    : new FileResponseCache(join(process.cwd(), '.spfx-relay', 'cache'));

  console.log(`Analyzing ${inputDir} …`);
  const analysis = analyzeWebPart(inputDir);
  const coupling = analyzeCouplingDir(inputDir);
  const plan = buildPlan({ analysis, name: options.name ?? migrationNameFrom(inputDir), coupling });
  console.log(renderPlan(plan));

  if (plan.blocked) {
    writeRunArtifacts(outDir, { status: 'blocked', plan, manifest }, manifest);
    return 2;
  }

  const decision = resolveStrategy(coupling, options.strategy);
  if (decision.refusal) {
    console.error(`\n${decision.refusal}`);
    writeRunArtifacts(outDir, { status: 'blocked', plan, manifest }, manifest);
    return 2;
  }
  for (const note of decision.notes) console.log(`\n${note}`);

  if (!(await approved(options.yes))) {
    console.log('Aborted — nothing was written.');
    return 0;
  }

  const provider = createProvider(providerConfigFrom(options, process.env));
  const caps = provider.capabilities();
  console.log(`\nTransforming with ${caps.name}/${caps.model} …`);

  const sources = loadSourceFiles(inputDir, plan.sourceFiles);
  const verified = await runVerifiedTransform({ provider, plan, analysis, sources, cache, manifest });

  if (!verified.ok) {
    console.error(`Transform failed verification after ${verified.attempts} attempt(s).`);
    writeRunArtifacts(
      outDir,
      {
        status: 'failed',
        plan,
        chosen: decision.chosen,
        transform: verified.result.value,
        gates: verified.gates,
        transformAttempts: verified.attempts,
        manifest,
      },
      manifest,
    );
    return 3;
  }

  console.log(`Verified in ${verified.attempts} attempt(s). Emitting project …`);
  const emitted = emitProject({
    outDir,
    plan,
    componentCode: verified.result.value.componentCode,
    inputDir,
    assets: analysis.ir.assets,
  });

  let bundle: BundleResult | undefined;
  if (options.skipBundle) {
    bundle = { status: 'skipped', detail: 'Skipped via --skip-bundle.' };
  } else {
    console.log('Running the SPFx bundle seal (npm install + gulp bundle) — this can take a few minutes …');
    bundle = runBundleSeal(outDir);
  }
  console.log(`Bundle seal: ${bundle.status.toUpperCase()}`);

  writeRunArtifacts(
    outDir,
    {
      status: 'migrated',
      plan,
      chosen: decision.chosen,
      transform: verified.result.value,
      gates: verified.gates,
      transformAttempts: verified.attempts,
      bundle,
      emittedFiles: emitted.files,
      manifest,
    },
    manifest,
  );

  return bundle.status === 'failed' ? 4 : 0;
}

async function runEvalCommand(options: EvalOptions): Promise<number> {
  const corpusDir = resolve(options.corpus);
  if (!existsSync(corpusDir)) {
    console.error(`Corpus folder not found: ${corpusDir}`);
    return 1;
  }

  const provider = createProvider(providerConfigFrom(options, process.env));
  const caps = provider.capabilities();
  console.log(`Evaluating corpus at ${corpusDir} against ${caps.name}/${caps.model} …`);

  const run = await runEval({
    provider,
    corpusDir,
    cache: options.noCache ? undefined : new FileResponseCache(join(process.cwd(), '.spfx-relay', 'cache')),
    onProgress: (message) => console.log(`  ${message}`),
  });

  const markdown = renderEvalMarkdown(run);
  console.log(`\n${markdown}`);

  const resultsDir = join(process.cwd(), 'eval-results');
  mkdirSync(resultsDir, { recursive: true });
  const fileStem = `${run.provider}-${run.model.replace(/[^a-z0-9.-]+/gi, '_')}`;
  writeFileSync(join(resultsDir, `${fileStem}.json`), JSON.stringify(run, null, 2));
  writeFileSync(join(resultsDir, `${fileStem}.md`), markdown);
  console.log(`Results written to eval-results/${fileStem}.{json,md}`);

  return 0;
}

// Invoked directly (tsx src/cli.ts …), not when imported by tests.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: Error) => {
      console.error(`\n${error.name}: ${error.message}`);
      process.exitCode = 1;
    });
}
