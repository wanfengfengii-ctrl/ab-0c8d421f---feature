'use strict';

/**
 * 异类近邻复测计划单元测试 + 随机化暴力对拍。
 * 暴力实现枚举参与观测的全部子集，按（总代价 → 数量 → 被选序号序列字典序）取最小覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planNeighborRetest,
  findNeighborPairs,
  RetestLimitError,
  RETEST_LIMITS,
} from '../src/retest.js';
import { expandObservations } from '../src/dedup.js';

function mkInput(tolerance, fields) {
  return {
    tolerance,
    fields: fields.map((f, i) => ({
      name: f.name || `F${i + 1}`,
      offset: { x: f.offset?.x ?? 0, y: f.offset?.y ?? 0 },
      particles: f.particles.map((p) => ({ id: p.id, x: p.x, y: p.y, category: p.category })),
    })),
  };
}

test('异类近邻对：不同视野、类别不同、横纵差均 ≤ 半径', () => {
  const input = mkInput(0, [
    { offset: { x: 0, y: 0 }, particles: [
      { id: 'A1', x: 0, y: 0, category: 'PE' },
      { id: 'A2', x: 50, y: 50, category: 'PP' },
    ] },
    { offset: { x: 100, y: 0 }, particles: [
      { id: 'B1', x: -99, y: 1, category: 'PP' }, // 与 A1：dx=1 dy=1
      { id: 'B2', x: -98, y: 3, category: 'PET' }, // 与 A1：dx=2 dy=3，异类，半径 3 时成对
    ] },
    { offset: { x: 0, y: 0 }, particles: [
      { id: 'C1', x: 100, y: 100, category: 'PE' }, // 距离过远：不算
    ] },
  ]);
  const obs = expandObservations(input);
  assert.deepEqual(findNeighborPairs(obs, 2).map((p) => [obs[p.a].id, obs[p.b].id]), [['A1', 'B1']]);
  // 半径放大后 B2 也与 A1 成对（同视野内的候选永不配对）
  assert.deepEqual(
    findNeighborPairs(obs, 3).map((p) => [obs[p.a].id, obs[p.b].id]).sort(),
    [['A1', 'B1'], ['A1', 'B2']],
  );
});

test('最小总代价复测集合：每条近邻证据由任一端覆盖', () => {
  // 两条互不相交的异类对：A1(PE)–B1(PP)、A2(PP)–B2(PE)
  const input = mkInput(0, [
    { offset: { x: 0, y: 0 }, particles: [
      { id: 'A1', x: 0, y: 0, category: 'PE' },
      { id: 'A2', x: 10, y: 10, category: 'PP' },
    ] },
    { offset: { x: 0, y: 0 }, particles: [
      { id: 'B1', x: 1, y: 1, category: 'PP' },
      { id: 'B2', x: 10, y: 11, category: 'PE' },
    ] },
    { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PE' }] },
  ]);
  const r = planNeighborRetest(input, 2, [5, 3, 1, 4, 9]);
  assert.equal(r.neighborPairCount, 2);
  assert.equal(r.involvedObservationCount, 4);
  assert.equal(r.totalRetestCost, 4); // B1(1) + A2(3)
  assert.equal(r.retestCount, 2);
  assert.deepEqual(r.selected.map((s) => s.particleId), ['A2', 'B1']);
  assert.deepEqual(r.unselected.map((s) => s.particleId), ['A1', 'B2']);
  // 每项返回覆盖的近邻证据，且证据标注了对应最终颗粒
  const a2 = r.selected.find((s) => s.particleId === 'A2');
  assert.equal(a2.covers.length, 1);
  assert.equal(a2.covers[0].pairKey, 'E2');
  assert.equal(a2.covers[0].other.particleId, 'B2');
  assert.equal(typeof a2.particle, 'number');
  // 每一对都由其被选端覆盖
  for (const p of r.pairs) {
    const coverIsSelected = r.selected.some((s) => s.particleId === p.coveredBy);
    assert.ok(coverIsSelected, `${p.key} 的覆盖端 ${p.coveredBy} 不在复测集合中`);
    assert.ok(p.coveredBy === p.a.particleId || p.coveredBy === p.b.particleId);
  }
});

test('同代价时最小化复测数量', () => {
  // 星形异类图：中心 A1(PE) 与 B1、B2（PP）相邻，A1 代价 2，B1/B2 各 1。
  // 最小代价 = 2：{A1} 数量 1 vs {B1,B2} 数量 2 → 选 A1。
  const input = mkInput(0, [
    { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { offset: { x: 0, y: 0 }, particles: [
      { id: 'B1', x: 1, y: 0, category: 'PP' },
      { id: 'B2', x: 0, y: 1, category: 'PP' },
    ] },
    { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PET' }] },
  ]);
  const r = planNeighborRetest(input, 1, [2, 1, 1, 0]);
  assert.equal(r.totalRetestCost, 2);
  assert.equal(r.retestCount, 1);
  assert.deepEqual(r.selected.map((s) => s.particleId), ['A1']);
});

test('代价与数量均相同：按视野与颗粒录入顺序的被选序号序列稳定决胜', () => {
  // 两条不相交异类对（A1–B1、A2–B2），四个候选代价均为 1。
  // 最优覆盖的被选序号序列中字典序最小为 [A1, A2]（序号 0、1 最早）。
  const input = mkInput(0, [
    { offset: { x: 0, y: 0 }, particles: [
      { id: 'A1', x: 0, y: 0, category: 'PE' },
      { id: 'A2', x: 10, y: 10, category: 'PP' },
    ] },
    { offset: { x: 0, y: 0 }, particles: [
      { id: 'B1', x: 1, y: 1, category: 'PP' },
      { id: 'B2', x: 10, y: 11, category: 'PE' },
    ] },
    { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PET' }] },
  ]);
  const r = planNeighborRetest(input, 2, [1, 1, 1, 1, 0]);
  assert.equal(r.totalRetestCost, 2);
  assert.equal(r.retestCount, 2);
  assert.deepEqual(r.selected.map((s) => s.particleId), ['A1', 'A2']);
  assert.deepEqual(r.selected.map((s) => s.seq), [1, 2]); // 序号按录入顺序
});

test('三角形异类近邻：最小权覆盖取两个便宜端点', () => {
  const input = mkInput(0, [
    { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PP' }] },
    { offset: { x: 0, y: 0 }, particles: [
      { id: 'C1', x: 0, y: 1, category: 'PET' },
      { id: 'C2', x: 50, y: 50, category: 'PE' },
    ] },
  ]);
  const r = planNeighborRetest(input, 1, [10, 1, 1, 0]);
  assert.equal(r.neighborPairCount, 3);
  assert.deepEqual(r.selected.map((s) => s.particleId), ['B1', 'C1']);
  assert.equal(r.totalRetestCost, 2);
});

test('没有异类近邻对时返回空计划（含去重重算结果）', () => {
  const input = mkInput(1, [
    { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }] },
    { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
  ]);
  const r = planNeighborRetest(input, 1, [5, 5, 5]);
  assert.equal(r.neighborPairCount, 0);
  assert.equal(r.involvedObservationCount, 0);
  assert.equal(r.retestCount, 0);
  assert.equal(r.totalRetestCost, 0);
  assert.deepEqual(r.selected, []);
  assert.deepEqual(r.unselected, []);
  assert.deepEqual(r.pairs, []);
  // 同类别近邻照常进入去重裁决，但不产生复测证据
  assert.equal(r.deduplication.totalParticles, 2);
});

test('复测依据服务端重算的最终颗粒标注', () => {
  // A1、B1 同类别相邻会被去重为同一最终颗粒；二者不产生近邻证据。
  // 与它们异类相邻的 C1 与任一端成证据，返回中两端 particle 相同。
  const input = mkInput(2, [
    { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }] },
    { offset: { x: 0, y: 0 }, particles: [{ id: 'C1', x: 0, y: 1, category: 'PP' }] },
  ]);
  const r = planNeighborRetest(input, 2, [5, 5, 1]);
  assert.equal(r.deduplication.totalParticles, 2);
  const mergedId = r.deduplication.particles[0].id;
  for (const s of r.selected) {
    if (s.particleId === 'C1') continue;
    assert.equal(s.particle, mergedId);
  }
  for (const p of r.pairs) {
    const peSide = p.a.particleId === 'C1' ? p.b : p.a;
    assert.equal(peSide.particle, mergedId);
  }
});

test('参与观测超过精确裁决规模时明确拒绝', () => {
  // 201 个参与观测：3 个视野各 67 个、同一点、三个互不相同的类别。
  // 不同类别使去重阶段无候选关联（快速完成），异类近邻覆盖全部跨视野对。
  const cats = ['PE', 'PP', 'PET'];
  const perField = 67;
  const f = [];
  const costs = [];
  for (let fi = 0; fi < 3; fi += 1) {
    const ps = [];
    for (let i = 0; i < perField; i += 1) {
      ps.push({ id: `F${fi}_${i}`, x: 0, y: 0, category: cats[fi] });
      costs.push(1);
    }
    f.push({ offset: { x: 0, y: 0 }, particles: ps });
  }
  const input = mkInput(0, f);
  assert.throws(
    () => planNeighborRetest(input, 0, costs),
    (err) => err instanceof RetestLimitError && /参与近邻对的观测数/.test(err.message),
  );
  assert.equal(RETEST_LIMITS.maxInvolvedObservations, 200);
});

// ── 随机化暴力对拍 ────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 暴力参考：枚举参与观测的全部子集求最小覆盖（代价 → 数量 → 被选序号序列字典序）。
 *  决胜比较的是按全局录入顺序的“局部序号”序列（数值比较）。 */
function bruteForceCover(k, pairs, costOfLocal) {
  let best = null;
  for (let mask = 0; mask < (1 << k); mask += 1) {
    const chosen = new Set();
    for (let i = 0; i < k; i += 1) if (mask & (1 << i)) chosen.add(i);
    let covers = true;
    for (const [a, b] of pairs) if (!chosen.has(a) && !chosen.has(b)) { covers = false; break; }
    if (!covers) continue;
    const seq = [...chosen].sort((a, b) => a - b);
    const cost = seq.reduce((s, i) => s + costOfLocal[i], 0);
    const lexLess = (s1, s2) => {
      const len = Math.min(s1.length, s2.length);
      for (let i = 0; i < len; i += 1) {
        if (s1[i] < s2[i]) return true;
        if (s1[i] > s2[i]) return false;
      }
      return s1.length < s2.length; // 公共前缀较短者更小
    };
    if (!best
      || cost < best.cost
      || (cost === best.cost && seq.length < best.seq.length)
      || (cost === best.cost && seq.length === best.seq.length && lexLess(seq, best.seq))) {
      best = { cost, seq };
    }
  }
  return best;
}

test('随机用例与暴力枚举的最小权覆盖结论一致', () => {
  const rand = mulberry32(20260925);
  const categories = ['PE', 'PP', 'PET'];
  let compared = 0;
  for (let c = 0; c < 300 && compared < 150; c += 1) {
    const fieldCount = 3 + Math.floor(rand() * 3);
    const fields = [];
    const costs = [];
    let serial = 0;
    for (let fi = 0; fi < fieldCount; fi += 1) {
      const count = 1 + Math.floor(rand() * 4);
      const ps = [];
      for (let i = 0; i < count; i += 1) {
        ps.push({
          id: `P${c}_${serial}`,
          x: Math.floor(rand() * 5),
          y: Math.floor(rand() * 5),
          category: categories[Math.floor(rand() * categories.length)],
        });
        costs.push(Math.floor(rand() * 4)); // 0~3 制造等代价
        serial += 1;
      }
      fields.push({
        name: `F${fi + 1}`,
        offset: { x: Math.floor(rand() * 3) - 1, y: Math.floor(rand() * 3) - 1 },
        particles: ps,
      });
    }
    const radius = Math.floor(rand() * 3);
    const input = mkInput(100, fields); // 容差不影响近邻对，仅保证去重可解
    const obs = expandObservations(input);
    const gPairs = findNeighborPairs(obs, radius);
    if (gPairs.length === 0 || gPairs.length > 12) continue; // 暴力枚举规模控制

    const involved = [...new Set(gPairs.flatMap((p) => [p.a, p.b]))].sort((a, b) => a - b);
    if (involved.length > 14) continue;
    const localOf = new Map(involved.map((u, i) => [u, i]));
    const localPairs = gPairs.map((p) => [localOf.get(p.a), localOf.get(p.b)]);
    const costOfLocal = involved.map((u) => costs[u]);
    const expected = bruteForceCover(involved.length, localPairs, costOfLocal);

    const actual = planNeighborRetest(input, radius, costs);
    const actualSeq = actual.selected.map((s) => s.particleId);
    const expectedSeq = expected.seq.map((i) => obs[involved[i]].id);

    const dump = JSON.stringify({ input, radius, costs });
    assert.equal(actual.totalRetestCost, expected.cost, dump);
    assert.equal(actual.retestCount, expected.seq.length, dump);
    assert.deepEqual(actualSeq, expectedSeq, dump);
    compared += 1;
  }
  assert.ok(compared >= 150, `有效对拍用例不足（${compared}）`);
});
