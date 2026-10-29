import { expect, test } from "bun:test";
import { CacheBudget, ByteCache } from "../src/shared/byte-cache";

test('cache namespaces share one budget and evict their least recently used values', () => {
  const budget = new CacheBudget(1000);
  const render = new ByteCache<string>(budget);
  const highlight = new ByteCache<string>(budget);
  const mdx = new ByteCache<string>(budget);
  render.set('a', 'render', 100);
  highlight.set('b', 'highlight', 100);
  expect(render.get('a')).toBe('render');
  mdx.set('c', 'mdx', 100);
  expect(highlight.get('b')).toBeUndefined();
  expect(render.get('a')).toBe('render');
  expect(mdx.get('c')).toBe('mdx');
  expect(budget.bytes).toBe(712);
  render.set('large', 'too large', 1001);
  expect(render.get('large')).toBeUndefined();
  render.clear(); mdx.clear();
  expect(budget.bytes).toBe(0);
});

test('thread owners reserve against the same cap and shutdown releases their reservations', () => {
  const parent = new CacheBudget(1000);
  const owner = parent.claimOwner();
  const worker = new CacheBudget(1000, owner.data.buffer, owner.data.owner);
  const mainCache = new ByteCache<string>(parent);
  const workerCache = new ByteCache<string>(worker);
  mainCache.set('main', 'main', 400);
  workerCache.set('worker', 'worker', 400);
  expect(workerCache.get('worker')).toBeUndefined();
  mainCache.clear();
  workerCache.set('worker', 'worker', 400);
  expect(parent.bytes).toBe(656);
  owner.release(); owner.release();
  expect(parent.bytes).toBe(0);
});
