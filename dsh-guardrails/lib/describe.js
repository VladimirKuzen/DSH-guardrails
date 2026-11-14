/**
 * Render approval text from facts and a locale pack.
 *
 * Returns one string per locale; the host picks the active language, so the
 * card never pays for a second language it will not display.
 */

import { readFileSync } from 'node:fs';

import { clipPath } from './facts.js';

const readPack = (file) => JSON.parse(readFileSync(new URL(`../locales/${file}`, import.meta.url), 'utf8'));

/** Loaded once; a broken pack fails at import time rather than at prompt time. */
export const LOCALES = Object.freeze({
  en: readPack('en.json'),
  zh: readPack('zh.json'),
});

const SEPARATOR = { zh: '｜', en: ' · ' };

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));
}

function text(pack, key, vars = {}) {
  const template = pack[key];
  return template === undefined ? key : fill(template, vars);
}

function actionKey(facts) {
  if (facts.kind === 'delete' && facts.recursive === true) return 'action.delete.recursive';
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
  const prefixKey = verdict?.mode === 'deny' ? 'prefix.block' : 'prefix.warn';
  const rendered = {};

  for (const locale of Object.keys(locales)) {
    const pack = locales[locale];
    const prefix = text(pack, prefixKey);
    const body = [];

    if (facts.kind === 'secret') {
      const label = facts.secretLabel;
      const tail = label === '' ? text(pack, 'seg.secret.generic') : text(pack, 'seg.secret', { label });
      body.push(`${text(pack, 'action.secret')}${tail}`);
      rendered[locale] = `${prefix} ${body.join(SEPARATOR[locale] ?? ' ')}`.trim();
      continue;
    }

    body.push(text(pack, actionKey(facts)));
    if (facts.target !== '') body.push(text(pack, 'seg.target', { path: clipPath(facts.target) }));
    if (facts.kind === 'overwrite') body.push(text(pack, 'seg.existed'));
    if (facts.count === 1) body.push(text(pack, 'seg.count.one'));
    else if (facts.count !== undefined) body.push(text(pack, 'seg.count', { count: facts.count }));
    if (facts.protectedHit === true) body.push(text(pack, 'seg.protected'));
    if (facts.reversible === 'no') body.push(text(pack, 'seg.reversible.no'));
    else if (facts.reversible === 'yes') body.push(text(pack, 'seg.reversible.yes'));

    rendered[locale] = `${prefix} ${body.join(SEPARATOR[locale] ?? ' ')}`.trim();
  }

  return rendered;
}
