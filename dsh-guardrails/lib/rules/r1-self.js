/**
 * R1 self-protection: the gate's own source, next to the host's home.
 * R1 自保护：护栏自己的源码，与 DSH 家目录并列。
 *
 * This is not a sandbox and does not pretend to be one: it raises the cost of a
 * tool call that edits the code enforcing the three red lines. A user editing
 * files by hand, a non-DSH process, or an fs write inside the plugin process all
 * bypass it. It only closes the "the agent edits the gate it is being held by"
 * path.
 * 这不是沙箱，也不假装是：它只提高"用工具改写护栏源码"的成本。手工编辑、
 * 非 DSH 进程、插件进程内部的 fs 写都不经过它。
 *
 * The auto root is the plugin directory itself, derived from this module's URL
 * (never from process.cwd(), which is the host's install directory). Extra roots
 * can be declared in policy under rules.selfProtect.paths.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PATH_TOOLS,
  SHELL_TOOLS,
  allStrings,
  expandPath,
  isUnder,
  mentionsPathNearWrite,
  pathOf,
  str,
} from './kit.js';

/** Absolute path of the plugin checkout, with symlinks resolved when possible. */
export function pluginRoot() {
  const raw = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

/**
 * Startup assertion: a self-protection root that is not the plugin is worse than
 * none, because it silently protects the wrong directory.
 * 启动断言：算错的保护根比没有保护更糟，因为它静默地保护了错的目录。
 */
export function assertSelfRoot(root = pluginRoot()) {
  if (basename(root).toLowerCase() !== 'dsh-guardrails') {
    throw new Error(`self-protect root is not a dsh-guardrails directory: ${root}`);
  }
  return root;
}

/** Normalized roots: the plugin itself plus policy-declared extras, deduplicated. */
export function selfRoots(rule = {}, env = {}) {
  const declared = Array.isArray(rule.paths) ? rule.paths : [];
  const roots = [pluginRoot(), ...declared]
    .map((root) => expandPath(root, env))
    .filter((root) => root !== '');
  return [...new Set(roots)];
}

/** `apply_patch` carries its targets inside the patch text, not in a path argument. */
const PATCH_TARGET = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function patchTargets(args) {
  const targets = [];
  for (const text of allStrings(args)) {
    for (const match of text.matchAll(PATCH_TARGET)) targets.push(match[1].trim());
  }
  return targets;
}

/**
 * @param {{name: string, arguments?: object, args?: object}} call
 * @param {object} rule the policy slice rules.selfProtect
 * @param {object} env shape: { USERPROFILE, HOME, DSH_HOME, AGENTS_HOME }
 * @returns {null | {rule: 'R1', sub: 'self', mode: string, reason: string}}
 */
export function evaluateR1Self(call, rule = {}, env) {
  // "off" and "allow" are rejected by policy validation; a hand-written policy
  // that skips validation still cannot switch it off from here.
  if (rule.mode !== 'ask' && rule.mode !== 'deny') return null;
  const mode = rule.mode;
  const name = str(call?.name);
  const args = call?.arguments ?? call?.args ?? {};
  const roots = selfRoots({ paths: rule.paths }, env);
  if (roots.length === 0) return null;

  if (PATH_TOOLS.has(name)) {
    const target = expandPath(pathOf(args), env, env?.CWD);
    if (isUnder(target, roots)) {
      return {
        rule: 'R1',
        sub: 'self',
        mode,
        reason: `Guardrails R1: tool "${name}" writes inside the guardrails' own source (${target}). `
          + 'Changes there can disable this gate, so they need explicit approval.',
      };
    }
  }

  // `apply_patch` has no path argument: its targets live in the patch text. This
  // scan is the only thing standing between it and the gate's own source.
  for (const raw of patchTargets(args)) {
    const target = expandPath(raw, env, env?.CWD);
    if (isUnder(target, roots)) {
      return {
        rule: 'R1',
        sub: 'self',
        mode,
        reason: `Guardrails R1: a patch edits inside the guardrails' own source (${target}). `
          + 'Changes there can disable this gate, so they need explicit approval.',
      };
    }
  }

  if (SHELL_TOOLS.has(name)) {
    const command = str(args.command ?? args.cmd ?? args.script);
    if (mentionsPathNearWrite(command, roots)) {
      return {
        rule: 'R1',
        sub: 'self',
        mode,
        reason: "Guardrails R1: shell command writes into the guardrails' own source. "
          + 'The gate cannot be edited by the calls it gates.',
      };
    }
  }

  return null;
}
