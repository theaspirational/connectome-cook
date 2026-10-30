import { resolve } from 'node:path';
import { canonical, fail, issue, report, UUID, type Command, type Findings } from './schema.js';
import { bindings, complete } from './seed.js';
import { candidateArtifact, fresh, guard, ioError } from './io.js';
import { prepare } from './prepare.js';
import { verify } from './verify.js';

export const CANDIDATE_HELP = `Disposable held candidates (Linux, util-linux /usr/bin/flock, admitted local filesystem only):
  cook install RECIPE --hold --agent-id UUID --lineage-id UUID --out R --no-prompts --yes
       [--seed-required] [--env-file PRIVATE_FILE] [--pin-refs] [--ch-repo URL] [--ch-ref REF]
       [--allow-incomplete-templates] [--json | --schema connectome.findings/v1]
  cook hold R [--clear] [--json | --schema connectome.findings/v1]
  cook seed check R [--json | --schema connectome.findings/v1]
  cook seed complete R [--json | --schema connectome.findings/v1]
  cook verify R [--json | --schema connectome.findings/v1]
No activation, adoption, interactive prompts, ambient secrets or production ingest adapter.
--clear always refuses. Verification never launches anything or authorizes activation.
`;
export function emit(result: Findings, json: boolean): void {
  if (json) process.stdout.write(canonical(result) + '\n');
  else {
    for (const f of result.findings) process.stdout.write(`${f.severity} ${f.code} [${f.check}:${f.subject}] ${f.message} ${f.remedy}\n`);
    process.stdout.write(`Status: ${result.status}; activationAllowed: false\n`);
  }
}
function parse(args: string[], command: Command): { positional: string[]; flags: Record<string, string | boolean> } {
  const bool = new Set(['json', 'help', ...(command === 'prepare' ? ['hold', 'no-prompts', 'yes', 'seed-required', 'strict', 'pin-refs', 'allow-incomplete-templates'] : command.startsWith('hold') ? ['clear'] : [])]);
  const strings = new Set(['schema', ...(command === 'prepare' ? ['out', 'agent-id', 'lineage-id', 'env-file', 'ch-repo', 'ch-ref'] : [])]);
  const flags: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg); if (!m) fail('E_USAGE', 1);
    const key = m[1]!; if (Object.hasOwn(flags, key)) fail('E_USAGE', 1);
    if (bool.has(key) && m[2] === undefined) flags[key] = true;
    else if (strings.has(key)) { const value = m[2] ?? args[++i]; if (!value || value.startsWith('--')) fail('E_USAGE', 1); flags[key] = value; }
    else fail('E_USAGE', 1);
  }
  return { positional, flags };
}
export async function candidateCommand(command: Command, args: string[]): Promise<number> {
  const json = args.some(a => a === '--json' || a === '--schema' || a.startsWith('--schema='));
  let held: boolean | null = null;
  try {
    const { positional, flags } = parse(args, command);
    if (flags.schema !== undefined && flags.schema !== 'connectome.findings/v1') fail('E_SCHEMA');
    if (flags.help) { process.stdout.write(CANDIDATE_HELP); return 0; }
    if (command === 'hold' && flags.clear) command = 'hold-clear';
    if (positional.length !== 1) fail('E_USAGE', 1);
    // Clear is a one-way policy refusal, independent of root state or proof.
    if (command === 'hold-clear') fail('E_CLEAR_UNSUPPORTED', 4);
    let result: Findings;
    if (command === 'prepare') {
      if (!flags.hold || !flags['no-prompts'] || !flags.yes || typeof flags.out !== 'string' || typeof flags['agent-id'] !== 'string' || typeof flags['lineage-id'] !== 'string') fail('E_USAGE', 1);
      if (!UUID.test(flags['agent-id']) || !UUID.test(flags['lineage-id'])) fail('E_IDENTITY');
      const root = resolve(flags.out); guard(root);
      await prepare({ root, recipe: positional[0]!, agent: { id: flags['agent-id'], lineage: flags['lineage-id'] }, seedRequired: !!flags['seed-required'], envFile: flags['env-file'] as string | undefined, hostUrl: flags['ch-repo'] as string | undefined, hostRef: flags['ch-ref'] as string | undefined, pinRefs: !!flags['pin-refs'], allowIncompleteTemplates: !!flags['allow-incomplete-templates'] });
      held = true;
      result = report(command, held, [issue('I_MATERIALIZED', 'materialization', '.', 'Candidate prepared under an immutable hold; installed and running are not recorded.')]);
    } else {
      const root = resolve(positional[0]!);
      held = candidateArtifact(root) ? true : null;
      if (command === 'verify') result = verify(root);
      else if (command === 'seed-check') {
        // Check D independently of whether any metadata can be decoded.
        fresh(root);
        const findings = [issue('I_SEED_ELIGIBLE', 'seed', 'data', 'No history entries or prior intent found; this is not ingest authorization.')];
        if (!held) findings.push(issue('W_LEGACY_UNMANAGED', 'envelope', '.', 'No candidate envelope established; existing installations cannot be adopted.'));
        result = report(command, held, findings);
      } else if (command === 'seed-complete') {
        await complete(root);
        result = report(command, true, [issue('I_SEED_COMPLETED', 'seed', 'data/seed.consumed', 'Marker publication confirmed; hold remains unchanged.')]);
      } else {
        if (!held) fail('E_SCOPE');
        bindings(root);
        result = report(command, true, [issue('I_HELD', 'hold', '.cook/hold.json', 'Disposable candidate remains held; no files changed.')]);
      }
    }
    emit(result, json); return result.status === 'error' ? 2 : 0;
  } catch (error) {
    const e = ioError(error);
    emit(report(command, held, [issue(e.code, 'cli', '.', e.code === 'E_CLEAR_UNSUPPORTED' ? 'Hold clear requires PR08; hold unchanged.' : e.code === 'E_HELD' ? 'Disposable candidate is held; PR01b cannot activate it.' : e.code === 'E_SCHEMA' ? 'Unsupported schema or invalid record; request a supported findings schema.' : 'Operation refused; private details are not emitted.')]), json);
    return e.exitCode;
  }
}
export async function seedCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'check') return candidateCommand('seed-check', rest);
  if (subcommand === 'complete') return candidateCommand('seed-complete', rest);
  return candidateCommand('seed-check', [...args, '--invalid-subcommand']);
}
