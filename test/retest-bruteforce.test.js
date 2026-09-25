'use strict';

/**
 * 随机化对拍：异类近邻复测计划的精确求解器与“枚举参与观测全部子集”的暴力顶点覆盖对比，
 * 验证三目标（最小总代价 → 最小复测数量 → 被选序号序列字典序）完全一致。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { solveDeduplication, expandObservations } from '../src/dedup.js';
import { buildRetestPlan } from '../src/retest.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 暴力参考：枚举参与观测的全部子集，按三目标全序取唯一最优覆盖。 */
function bruteForce(input) {
  const { observations } = expandObservations(input);
  const edges = [];
  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      const a = observations[i]; const b = observations[j];
      if (a.fieldIndex === b.fieldIndex || a.category === b.category) continue;
      const dx = Math.abs(a.filterX - b.filterX);
      const dy = Math.abs(a.filterY - b.filterY);
      if (dx <= input.radius && dy <= input.radius) edges.push([i, j]);
    }
  }
  if (edges.length === 0) return { edges: [], parts: [], best: null };
  const parts = [...new Set(edges.flat())].sort((x, y) => x - y);
  const m = parts.length;
  let best = null;
  for (let mask = 0; mask < (1 << m); mask += 1) {
    if (!edges.every(([a, b]) => (mask & (1 << parts.indexOf(a))) || (mask & (1 << parts.indexOf(b))))) continue;
    let cost = 0;
    const seq = [];
    for (let k = 0; k < m; k += 1) {
      if (mask & (1 << k)) {
        seq.push(k);
        const o = observations[parts[k]];
        cost += input.fields[o.fieldIndex].particles[o.particleIndex].retestCost;
      }
    }
    const count = seq.length;
    const lexLess = best === null
      || cost < best.cost
      || (cost === best.cost && count < best.count)
      || (cost === best.cost && count === best.count && (() => {
        for (let k = 0; k < Math.min(seq.length, best.seq.length); k += 1) {
          if (seq[k] !== best.seq[k]) return seq[k] < best.seq[k];
        }
        return seq.length < best.seq.length;
      })());
    if (lexLess) best = { cost, count, seq };
  }
  return { edges, parts, best, observations };
}

function randomCase(rand, caseIndex) {
  const fieldCount = 3 + Math.floor(rand() * 3); // 3~5 个视野
  const categories = ['PE', 'PP', 'PET'];
  const fields = [];
  let serial = 0;
  for (let fi = 0; fi < fieldCount; fi += 1) {
    const count = 1 + Math.floor(rand() * 3); // 每视野 1~3 个颗粒
    const particles = [];
    for (let pi = 0; pi < count; pi += 1) {
      serial += 1;
      particles.push({
        id: `R${caseIndex}_${serial}`,
        x: Math.floor(rand() * 6),
        y: Math.floor(rand() * 6),
        category: categories[Math.floor(rand() * categories.length)],
        retestCost: Math.floor(rand() * 5),
      });
    }
    fields.push({
      name: `F${fi + 1}`,
      offset: { x: Math.floor(rand() * 3) - 1, y: Math.floor(rand() * 3) - 1 },
      particles,
    });
  }
  return { tolerance: Math.floor(rand() * 2), radius: Math.floor(rand() * 3), fields };
}

test('随机小规模用例与暴力枚举结果一致（复测计划三目标全序）', () => {
  const rand = mulberry32(20260926);
  let compared = 0;
  for (let c = 0; c < 4000 && compared < 400; c += 1) {
    const input = randomCase(rand, c);
    const expected = bruteForce(input);
    if (expected.edges.length === 0 || expected.parts.length > 14) continue; // 暴力枚举规模限制
    compared += 1;

    const actual = buildRetestPlan(input, solveDeduplication(input));
    const actualSeq = actual.retests.map((r) => expected.parts.findIndex((u) =>
      expected.observations[u].fieldIndex === r.observation.fieldIndex
      && expected.observations[u].id === r.observation.particleId));

    const dump = JSON.stringify(input);
    assert.equal(actual.pairCount, expected.edges.length, `近邻对数不一致: ${dump}`);
    assert.equal(actual.totalRetestCost, expected.best.cost, `总代价不一致: ${dump}`);
    assert.equal(actual.selectedCount, expected.best.count, `复测数量不一致: ${dump}`);
    assert.deepEqual(actualSeq, expected.best.seq, `被选序号序列不一致: ${dump}`);

    // 每条近邻对都被至少一端覆盖
    const selectedIds = new Set(actual.retests.map((r) => r.observation.particleId));
    for (const [a, b] of expected.edges) {
      const ia = expected.observations[a].id;
      const ib = expected.observations[b].id;
      assert.ok(selectedIds.has(ia) || selectedIds.has(ib), `近邻对 ${ia}-${ib} 未被覆盖: ${dump}`);
    }
    // 每项回传的证据确实是与它异类近邻的观测，且证据两端最终颗粒不同
    for (const r of actual.retests) {
      for (const ev of r.coveredPairs) {
        assert.notEqual(r.observation.finalParticleId, ev.observation.finalParticleId);
        assert.ok(Math.abs(r.observation.filterX - ev.observation.filterX) <= input.radius);
        assert.ok(Math.abs(r.observation.filterY - ev.observation.filterY) <= input.radius);
      }
    }
  }
  assert.ok(compared >= 400, `有效对拍用例不足（${compared}）`);
});
