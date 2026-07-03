import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { analyzeWebPart } from './analyze/index';
import { emitProject } from './emit/index';
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

export interface CliOptions {
  command: 'migrate';
  input: string;
  out: string;
  provider: 'anthropic' | 'ollama';
  model?: string;
  yes: boolean;
  noCache: boolean;
  skipBundle: boolean;
  force: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      provider: { type: 'string', default: 'anthropic' },
      model: { type: 'string' },
      yes: { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      'skip-bundle': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });

  const [command, input] = positionals;
  if (command !== 'migrate') throw new Error(`Unknown command '${command ?? ''}' — usage: spfx-relay migrate <input> --out <dir>`);
  if (!input) throw new Error('Missing <input>: the folder containing the legacy web part (index.html + assets).');
  if (!values.out) throw new Error('Missing --out: the folder to emit the SPFx project into.');
  if (values.provider !== 'anthropic' && values.provider !== 'ollama') {
    throw new Error(`Unknown provider '${values.provider}' — supported: anthropic, ollama.`);
  }

  return {
    command: 'migrate',
    input,
    out: values.out,
    provider: values.provider,
    model: values.model,
    yes: values.yes,
    noCache: values['no-cache'],
    skipBundle: values['skip-bundle'],
    force: values.force,
  };
}

export function providerConfigFrom(options: CliOptions, env: NodeJS.ProcessEnv): ProviderConfig {
  if (options.provider === 'anthropic') {
    return {
      provider: 'anthropic',
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      ...(options.model ? { model: options.model } : {}),
    };
  }
  return { provider: 'ollama', model: options.model ?? 'llama3.1' };
}

function printPlan(plan: MigrationPlan): void {
  const lines = [
    '',
    `Migration plan — ${plan.componentName}`,
    `  Source files:      ${plan.sourceFiles.join(', ')}`,
    `  DOM operations:    ${plan.stats.domOperations}`,
    `  Event handlers:    ${plan.stats.eventHandlers}`,
    `  Network calls:     ${plan.stats.networkCalls}`,
    `  Dependencies:      ${plan.stats.dependencies}`,
  ];
  if (plan.findings.length > 0) {
    lines.push(`  Flagged issues:`);
    for (const f of plan.findings) lines.push(`    - [${f.rule}] ${f.file}:${f.line} ${f.message}`);
  }
  if (plan.refusals.length > 0) {
    lines.push(`  REFUSED (manual migration required):`);
    for (const r of plan.refusals) lines.push(`    - [${r.construct}] ${r.file}:${r.line} ${r.reason}`);
  }
  lines.push(plan.blocked ? '  => Plan is BLOCKED: no transform will run.' : '  => Ready to transform.');
  console.log(lines.join('\n'));
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
  const plan = buildPlan({ analysis, name: basename(inputDir) });
  printPlan(plan);

  if (plan.blocked) {
    writeRunArtifacts(outDir, { status: 'blocked', plan, manifest }, manifest);
    return 2;
  }

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
