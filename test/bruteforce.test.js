'use strict';

/**
 * 随机化对拍：将精确求解器与“枚举全部候选关联子集”的暴力实现对比，
 * 验证三目标（最少颗粒数 → 最小曼哈顿差总和 → 字典序唯一结论）完全一致。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { solveDeduplication } from '../src/dedup.js';

// 确定性伪随机数（可复现）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const compareId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function expand(input) {
  const obs = [];
  input.fields.forEach((f, fi) => {
    f.particles.forEach((p) => {
      obs.push({ uid: obs.length, fieldIndex: fi, id: p.id, category: p.category, fx: f.offset.x + p.x, fy: f.offset.y + p.y });
    });
  });
  const edges = [];
  for (let i = 0; i < obs.length; i += 1) {
    for (let j = i + 1; j < obs.length; j += 1) {
      const a = obs[i]; const b = obs[j];
      if (a.fieldIndex === b.fieldIndex || a.category !== b.category) continue;
      const dx = Math.abs(a.fx - b.fx); const dy = Math.abs(a.fy - b.fy);
      if (dx <= input.tolerance && dy <= input.tolerance) edges.push({ a: i, b: j, w: dx + dy });
    }
  }
  return { obs, edges };
}

/** 暴力参考实现：枚举候选关联的全部子集，按三目标全序取最优。 */
function bruteForce(input) {
  const { obs, edges } = expand(input);
  const n = obs.length;
  const m = edges.length;

  // 字典序序列：按观测全局顺序展开的伙伴编号升序列表
  const lexSequence = (selected) => {
    const partners = obs.map(() => []);
    for (const ei of selected) {
      partners[edges[ei].a].push(obs[edges[ei].b].id);
      partners[edges[ei].b].push(obs[edges[ei].a].id);
    }
    return partners.map((list) => list.sort(compareId));
  };
  const lexCompare = (s1, s2) => {
    for (let i = 0; i < s1.length; i += 1) {
      const a = s1[i]; const b = s2[i];
      const len = Math.min(a.length, b.length);
      for (let k = 0; k < len; k += 1) if (a[k] !== b[k]) return compareId(a[k], b[k]);
      if (a.length !== b.length) return a.length - b.length;
    }
    return 0;
  };

  let best = null;
  for (let mask = 0; mask < (1 << m); mask += 1) {
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) x = parent[x]; return x; };
    const compFields = new Map();
    let ok = true;
    let weight = 0;
    const selected = [];
    for (let i = 0; i < m && ok; i += 1) {
      if (!(mask & (1 << i))) continue;
      const e = edges[i];
      const ra = find(e.a); const rb = find(e.b);
      if (ra === rb) { ok = false; break; } // 成环
      const fa = compFields.get(ra) ?? new Set([obs[e.a].fieldIndex]);
      const fb = compFields.get(rb) ?? new Set([obs[e.b].fieldIndex]);
      let conflict = false;
      for (const f of fb) if (fa.has(f)) { conflict = true; break; }
      if (conflict) { ok = false; break; } // 同一视野多于一个观测
      parent[rb] = ra;
      compFields.set(ra, new Set([...fa, ...fb]));
      compFields.delete(rb);
      weight += e.w;
      selected.push(i);
    }
    if (!ok) continue;
    const roots = new Set();
    for (let i = 0; i < n; i += 1) roots.add(find(i));
    const components = roots.size;
    const seq = lexSequence(selected);
    if (!best
      || components < best.components
      || (components === best.components && weight < best.weight)
      || (components === best.components && weight === best.weight && lexCompare(seq, best.seq) < 0)) {
      best = { components, weight, seq, selected };
    }
  }
  return { ...best, obs, edges };
}

function randomCase(rand, caseIndex) {
  const fieldCount = 3 + Math.floor(rand() * 3); // 3~5 个视野
  const categories = ['PE', 'PP'];
  const fields = [];
  let serial = 0;
  for (let fi = 0; fi < fieldCount; fi += 1) {
    const count = 1 + Math.floor(rand() * 3); // 每视野 1~3 个颗粒
    const particles = [];
    for (let pi = 0; pi < count; pi += 1) {
      serial += 1;
      particles.push({
        id: `P${caseIndex}_${serial}`,
        x: Math.floor(rand() * 6),
        y: Math.floor(rand() * 6),
        category: categories[Math.floor(rand() * categories.length)],
      });
    }
    fields.push({
      name: `F${fi + 1}`,
      offset: { x: Math.floor(rand() * 4) - 1, y: Math.floor(rand() * 4) - 1 },
      particles,
    });
  }
  return { tolerance: Math.floor(rand() * 3), fields };
}

test('随机小规模用例与暴力枚举结果一致（三目标全序）', () => {
  const rand = mulberry32(20260925);
  let compared = 0;
  for (let c = 0; c < 400 && compared < 200; c += 1) {
    const input = randomCase(rand, c);
    const { edges } = expand(input);
    if (edges.length > 20) continue; // 暴力枚举规模限制
    compared += 1;

    const expected = bruteForce(input);
    const actual = solveDeduplication(input);

    const actualLinks = [];
    for (const p of actual.particles) for (const l of p.links) actualLinks.push([l.a, l.b].sort().join('~'));
    actualLinks.sort();
    const expectedLinks = expected.selected
      .map((ei) => [expected.obs[expected.edges[ei].a].id, expected.obs[expected.edges[ei].b].id].sort().join('~'))
      .sort();

    const dump = JSON.stringify(input);
    assert.equal(actual.totalParticles, expected.components, `用例 #${c} 颗粒数不一致: ${dump}`);
    assert.equal(actual.linkCount, expected.selected.length, `用例 #${c} 关联数不一致: ${dump}`);
    assert.deepEqual(actualLinks, expectedLinks, `用例 #${c} 所选关联不一致: ${dump}`);
  }
  assert.ok(compared >= 200, `有效对拍用例不足（${compared}）`);
});
