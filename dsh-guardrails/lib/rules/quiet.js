/**
 * Workspace quiet (P1.7): decide whether a destructive hit is the routine
 * "clean up a temp file" case that should not raise a card.
 *
 * The rule is deliberately narrow — a false negative costs one card, a false
 * positive silently deletes something the user did not mean to approve.
 * / 工作区静默：只把"清理工作区临时产物"这一种情形降为静默放行。
 * 判定刻意收窄——漏判只多一张卡，误判则会静默删掉用户没打算批准的东西。
 *
 * Every condition must hold:
 *   1. shell tool, exactly one statement;
 *   2. a single-target delete or move, no -Recurse, no wildcard;
 *   3. the target has no unresolved variable and is already absolute;
 *   4. it sits under a configured root and under one of the quiet paths;
 *   5. it is neither the root itself nor a directory in `alwaysAsk`.
 * `-Force` is allowed when the call is otherwise single-target and
 * non-recursive: in PowerShell almost every delete carries it.
 * 其余条件必须全部成立；单目标、非递归时允许 `-Force`。
 */

import { isUnder } from './kit.js';
import { isUnresolved, splitStatements } from '../facts.js';

const WILDCARD = /[*?[]/;
const RECURSIVE = /-recurse\b|\b(?:rd|rmdir|del|erase)\s+\/s\b/i;
const KINDS = new Set(['delete', 'move']);

/** Lowercase, backslash-normalized, no trailing separator. */
function normalize(value) {
  const text = String(value).trim().replace(/\//g, '\\');
  return text.replace(/\\+$/, '').toLowerCase();
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) return null;
  const out = [];
  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const value = normalize(raw);
    if (!/^[a-z]:\\/i.test(value) && !/^\\\\[^\\]+\\[^\\]+/i.test(value)) return null;
    if (/^[a-z]:\\?$/i.test(value)) return null; // drive root
    if (value.split('\\').includes('..')) return null;
    out.push(value);
  }
  return out.length === 0 ? null : out;
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return null;
  const out = [];
  for (const raw of paths) {
    if (typeof raw !== 'string') return null;
    const value = normalize(raw);
    if (value === '' || value === '.' || value === '..' || value === '**') return null;
    if (/[\\/:*?"<>|]/.test(value)) return null; // single segment only
    out.push(value);
  }
  return out.length === 0 ? null : out;
}

/**
 * @returns {{quiet: boolean, reason: string}}
 *   `quiet: true` only when every condition holds. `reason` is for tests and
 *   for a debug log; it is not written to the audit record.
 */
export function decideQuiet({ tool, command, facts, config, cwd } = {}) {
  if (config === null || config === undefined || config.enabled !== true) {
    return { quiet: false, reason: 'disabled' };
  }
  if (tool !== 'pwsh' && tool !== 'bash') return { quiet: false, reason: 'tool' };
  if (typeof command !== 'string' || command.trim() === '') return { quiet: false, reason: 'no-command' };
  if (splitStatements(command).filter((statement) => statement.trim() !== '').length !== 1) {
    return { quiet: false, reason: 'multi-statement' };
  }
  if (RECURSIVE.test(command)) return { quiet: false, reason: 'recursive' };
  if (WILDCARD.test(command)) return { quiet: false, reason: 'wildcard' };

  const target = facts?.target;
  if (typeof target !== 'string' || target === '') return { quiet: false, reason: 'no-target' };
  if (isUnresolved(target)) return { quiet: false, reason: 'unresolved' };
  if (!KINDS.has(facts?.kind)) return { quiet: false, reason: 'kind' };
  if (facts?.count !== 1) return { quiet: false, reason: 'count' };

  const roots = normalizeRoots(config.roots);
  const paths = normalizePaths(config.paths);
  if (roots === null || paths === null) return { quiet: false, reason: 'config-invalid' };

  // A root that does not contain the session cwd is a configuration mistake;
  // quiet must not silently cover some other workspace.
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const here = normalize(cwd);
    if (!isUnder(here, roots)) return { quiet: false, reason: 'cwd-mismatch' };
  }

  const path = normalize(target);
  const root = roots.find((candidate) => isUnder(path, [candidate]));
  if (root === undefined) return { quiet: false, reason: 'outside-roots' };
  if (path === root) return { quiet: false, reason: 'always-ask' };

  const relative = path.slice(root.length + 1);
  const segments = relative.split('\\');
  const first = segments[0];
  if (!paths.includes(first)) return { quiet: false, reason: 'outside-paths' };
  if (relative === first) return { quiet: false, reason: 'always-ask' }; // the quiet dir itself

  const alwaysAsk = Array.isArray(config.alwaysAsk) ? config.alwaysAsk.map((entry) => normalize(entry)) : [];
  if (segments.some((segment) => alwaysAsk.includes(segment))) return { quiet: false, reason: 'always-ask' };
  if (segments.includes('..')) return { quiet: false, reason: 'always-ask' };

  return { quiet: true, reason: 'eligible' };
}
