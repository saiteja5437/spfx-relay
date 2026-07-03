import type { Finding } from '../../types/ir';
import type { StringAssignment } from '../script';

/**
 * Deterministic hardcoded-secret detection. Two precise triggers, chosen to
 * keep false positives near zero rather than to catch everything:
 *  1. A secret-suggesting name (apiKey, password, token, …) assigned a string.
 *  2. A value matching a known credential prefix, regardless of name.
 */

const SECRET_NAME = /(api[_-]?key|secret|passw(or)?d|token|credential)/i;
const SECRET_VALUE_PREFIX = /^(sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]|xox[baprs]-|AIza[0-9A-Za-z_-]{10})/;
const MIN_SECRET_LENGTH = 4;

export function secretFindings(assignments: StringAssignment[]): Finding[] {
  const findings: Finding[] = [];
  for (const a of assignments) {
    const nameHit = SECRET_NAME.test(a.name) && a.value.trim().length >= MIN_SECRET_LENGTH;
    const valueHit = SECRET_VALUE_PREFIX.test(a.value);
    if (nameHit || valueHit) {
      findings.push({
        rule: 'hardcoded-secret',
        severity: 'error',
        message:
          `Possible hardcoded secret '${a.name}' = "${redact(a.value)}" — ` +
          `secrets must never ship in front-end code; move this server-side or behind a secured API.`,
        file: a.file,
        line: a.line,
      });
    }
  }
  return findings;
}

/** Findings must never reproduce the secret itself. */
function redact(value: string): string {
  return value.length <= MIN_SECRET_LENGTH ? '****' : `${value.slice(0, 4)}…`;
}
