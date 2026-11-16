/**
 * Render approval text from facts and a locale pack.
 * 用事实和语言包渲染审批文案。
 *
 * Returns one string per locale; the host picks the active language, so the
 * card never pays for a second language it will not display.
 */

import { readFileSync } from 'node:fs';

import { clipPath } from './facts.js';

const readPack = (file) => JSON.parse(readFileSync(new URL(`../i18n/${file}`, import.meta.url), 'utf8'));

/** Loaded once; a broken pack fails at import time rather than at prompt time. */
export const LOCALES = Object.freeze({
  en: readPack('en.json'),
  zh: readPack('zh.json'),
});

const SEPARATOR = { zh: '｜', en: ' · ' };

/** Import/load/restore act through a file, so the keys they touch are invisible. */
const REGISTRY_SCRIPT = new Set(['import', 'load', 'restore']);

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));
}

function text(pack, key, vars = {}) {
  const template = pack[key];
  return template === undefined ? key : fill(template, vars);
}

/** Critical categories get their own wording and always use the block prefix. */
const CRITICAL_ACTION = {
  disk: 'action.disk',
  boot: 'action.boot',
  systemfiles: 'action.systemfiles',
  permissions: 'action.permissions',
  registry: 'action.registry.system',
  custom: 'action.critical',
};

function actionKey(facts, verdict) {
  if (verdict?.severity === 'critical') return CRITICAL_ACTION[facts.criticalCategory] ?? 'action.critical';
  if (facts.kind === 'registry') {
    if (facts.registryAction === 'add') return 'action.registry.add';
    if (facts.registryAction === 'delete') return 'action.registry.delete';
    return 'action.registry';
  }
  if (facts.kind === 'delete' && facts.recursive === true) return 'action.delete.recursive';
  if (facts.kind === 'create-dir') return 'action.create.dir';
  return `action.${facts.kind}`;
}

/**
 * Build the headline for one approval.
 * @param {{rule?: string, mode?: string} | null} verdict
 * @param {object} facts from collectFacts
 * @param {{locales?: Record<string, Record<string, string>>}} [options]
 * @returns {Record<string, string>} locale -> text
 */
export function describe(verdict, facts, options = {}) {
  const locales = options.locales ?? LOCALES;
  const blocking = verdict?.severity === 'critical' || verdict?.mode === 'deny';
  const prefixKey = blocking ? 'prefix.block' : 'prefix.warn';
  const rendered = {};

  for (const locale of Object.keys(locales)) {
    const pack = locales[locale];
    const prefix = text(pack, prefixKey);
    const body = [];

    if (facts.kind === 'secret') {
      const id = facts.secretLabel;
      const labelText = id === '' ? '' : (pack[`secret.${id}`] ?? '');
      const label = labelText === '' ? text(pack, 'seg.secret.generic') : text(pack, 'seg.secret.wrap', { label: labelText });
      body.push(`${text(pack, 'action.secret')}${label}`);
      // A file write persists the secret; a shell command never reaches the card.
      if (facts.tool === 'write' || facts.tool === 'edit') body.push(text(pack, 'seg.secret.writes'));
      rendered[locale] = `${prefix} ${body.join(SEPARATOR[locale] ?? ' ')}`.trim();
      continue;
    }

    body.push(text(pack, actionKey(facts, verdict)));
    if (facts.target !== '') body.push(text(pack, 'seg.target', { path: clipPath(facts.target) }));
    // The target is set by a variable: name what we do not know rather than
    // omit the segment entirely, which used to read as "no target at all".
    else if (facts.dynamic === true) {
      // After a dry-run the listing is already in the transcript: point at it.
      body.push(text(pack, facts.dryRun === 'retry' ? 'seg.target.listed' : 'seg.target.dynamic'));
    }
    if (facts.kind === 'registry' && REGISTRY_SCRIPT.has(facts.registryAction)) body.push(text(pack, 'seg.registry.script'));
    if (facts.wildcard === true) body.push(text(pack, 'seg.wildcard'));
    if (facts.kind === 'overwrite') body.push(text(pack, 'seg.existed'));
    if (facts.count === 1) body.push(text(pack, 'seg.count.one'));
    else if (facts.count !== undefined) body.push(text(pack, 'seg.count', { count: facts.count }));
    if (facts.protectedHit === true && facts.kind !== 'protected') body.push(text(pack, 'seg.protected'));
    if (facts.reversible === 'no') body.push(text(pack, 'seg.reversible.no'));
    else if (facts.reversible === 'yes') body.push(text(pack, 'seg.reversible.yes'));
    // Registry adds overwrite values we cannot see; say so instead of guessing.
    else if (facts.reversible === 'unknown' && facts.kind === 'registry') body.push(text(pack, 'seg.reversible.unknown'));
    if (typeof facts.lines === 'number' && facts.lines > 3) body.push(text(pack, 'seg.lines', { count: facts.lines }));
    // A retry after the gate asked for a dry run: the listing should be visible
    // in the transcript above this card. Say so when it is not obvious.
    if (facts.dryRun === 'retry') body.push(text(pack, 'seg.dryrun.retry'));

    rendered[locale] = `${prefix} ${body.join(SEPARATOR[locale] ?? ' ')}`.trim();
  }

  return rendered;
}
