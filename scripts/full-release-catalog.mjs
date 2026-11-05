import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const fail = () => { throw new Error('Full release catalog differs from the trusted phase contract'); };
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
export const catalogDigest = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
function index(objects) {
  if (!Array.isArray(objects) || objects.length > 10000) fail();
  const map = new Map();
  for (const o of objects) {
    if (!o || Object.keys(o).sort().join(',') !== 'identity,value' || typeof o.identity !== 'string'
      || !/^(schema|table|column|constraint|index|trigger|policy|function):/.test(o.identity)
      || !o.value || Array.isArray(o.value) || typeof o.value !== 'object' || map.has(o.identity)) fail();
    map.set(o.identity, structuredClone(o.value));
  }
  return map;
}
const entries = map => [...map].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([identity,value]) => ({identity,value}));
export const catalogObjectsDigest = objects => catalogDigest(entries(index(objects)));
// The caller supplies this contract only from the checked-in, reviewed policy.
// Neither the manifest nor the evidence report supplies patch operations.
export function projectCatalog(before, trusted) {
  const map = index(before);
  if (!trusted || !Array.isArray(trusted.patches) || trusted.patches.length > 10000) fail();
  if (!Array.isArray(trusted.required_before) || !Array.isArray(trusted.required_after)
    || trusted.required_before.some(id => typeof id !== 'string' || !map.has(id))
    || new Set(trusted.required_before).size !== trusted.required_before.length
    || new Set(trusted.required_after).size !== trusted.required_after.length) fail();
  const seen = new Set();
  for (const p of trusted.patches) {
    if (!p || typeof p.identity !== 'string' || seen.has(p.identity)
      || !/^[a-f0-9]{64}$/.test(p.source_sha256 || '')) fail();
    seen.add(p.identity);
    const existing = map.get(p.identity);
    if (p.operation === 'add') {
      if (existing || !p.value) fail();
      map.set(p.identity, structuredClone(p.value));
    } else if (p.operation === 'ensure') {
      if (!p.value || (existing && !isDeepStrictEqual(existing, p.value))) fail();
      map.set(p.identity, structuredClone(p.value));
    } else if (p.operation === 'replace' || p.operation === 'remove') {
      if (!existing || !Array.isArray(p.before_sha256) || !p.before_sha256.includes(catalogDigest(existing))) fail();
      if (p.operation === 'remove') map.delete(p.identity);
      else { if (!p.value) fail(); map.set(p.identity, structuredClone(p.value)); }
    } else if (p.operation === 'remove-bound') {
      if (!existing || !p.preconditions) fail();
      for (const [key,value] of Object.entries(p.preconditions)) if (!isDeepStrictEqual(existing[key],value)) fail();
      map.delete(p.identity);
    } else if (p.operation === 'modify') {
      if (!existing || !p.fields || !p.preconditions || !Object.keys(p.fields).length) fail();
      for (const [key,value] of Object.entries(p.preconditions)) if (!isDeepStrictEqual(existing[key],value)) fail();
      for (const [key,value] of Object.entries(p.fields)) {
        if (!Object.hasOwn(existing,key) || ['owner'].includes(key)) fail();
        existing[key]=structuredClone(value);
      }
    } else if (p.operation === 'fields') {
      if (!existing || !p.fields || !p.before || Object.keys(p.fields).sort().join() !== Object.keys(p.before).sort().join()) fail();
      for (const key of Object.keys(p.fields)) {
        if (!Object.hasOwn(existing,key) || !Array.isArray(p.before[key])
          || !p.before[key].some(v => isDeepStrictEqual(v,existing[key]))) fail();
        existing[key] = structuredClone(p.fields[key]);
      }
    } else fail();
  }
  if (trusted.required_after.some(id => typeof id !== 'string' || !map.has(id))) fail();
  return entries(index(entries(map)));
}
export function verifyCatalogSequence(actual, binding, phases) {
  if (!Array.isArray(phases) || !phases.length) fail();
  const trusted=phases.at(-1);
  if (!actual || !binding || !trusted || actual.phase !== trusted.phase || binding.phase !== trusted.phase
    || actual.environment !== trusted.environment || binding.environment !== trusted.environment
    || !/^[a-f0-9]{64}$/.test(trusted.query_sha256 || '')
    || actual.query_sha256 !== trusted.query_sha256 || binding.query_sha256 !== trusted.query_sha256
    || phases.some(p=>p.environment!==trusted.environment || p.query_sha256!==trusted.query_sha256)
    || typeof binding.before_catalog_sha256 !== 'string'
    || catalogObjectsDigest(actual.before) !== binding.before_catalog_sha256
    || catalogObjectsDigest(actual.before) !== actual.before_catalog_sha256) fail();
  let expected=actual.before;
  for (const phase of phases) expected=projectCatalog(expected,phase);
  const observed = entries(index(actual.after));
  if (!isDeepStrictEqual(observed, expected) || actual.after_catalog_sha256 !== catalogDigest(expected)) fail();
  return true;
}
export function verifyCatalogTransition(actual,binding,trusted) {
  return verifyCatalogSequence(actual,binding,[trusted]);
}
