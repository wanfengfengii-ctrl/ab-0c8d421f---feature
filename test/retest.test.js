'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { solveDeduplication } from '../src/dedup.js';
import { buildRetestPlan, RETEST_LIMITS } from '../src/retest.js';

/** 构造归一化输入（颗粒附带 retestCost）。 */
function mk(radius, fields, tolerance = 5) {
  return {
    tolerance,
    radius,
    fields: fields.map((f, i) => ({
      name: f.name || `F${i + 1}`,
      offset: { x: f.offset?.x ?? 0, y: f.offset?.y ?? 0 },
      particles: f.particles.map((p) => ({
        id: p.id, x: p.x, y: p.y, category: p.category, retestCost: p.cost ?? 0,
      })),
    })),
  };
}

test('单个异类近邻对：选取代价较低的一端，并回传近邻证据与最终颗粒', () => {
  // F1 的 A1(PE) 与 F2 的 B1(PP) 滤膜坐标重合；F3 放一个远离的无关观测。
  const input = mk(0, [
    { particles: [{ id: 'A1', x: 3, y: 4, category: 'PE', cost: 5 }] },
    { particles: [{ id: 'B1', x: 3, y: 4, category: 'PP', cost: 3 }] },
    { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PE', cost: 1 }] },
  ]);
  const plan = buildRetestPlan(input, solveDeduplication(input));
  assert.equal(plan.radius, 0);
  assert.equal(plan.pairCount, 1);
  assert.equal(plan.participantCount, 2);
  assert.equal(plan.selectedCount, 1);
  assert.equal(plan.totalRetestCost, 3);

  const only = plan.retests[0];
  assert.equal(only.sequence, 1);
  assert.equal(only.retestCost, 3);
  assert.equal(only.observation.particleId, 'B1');
  assert.equal(only.observation.category, 'PP');
  assert.deepEqual([only.observation.filterX, only.observation.filterY], [3, 4]);
  assert.equal(only.coveredPairs.length, 1);
  const ev = only.coveredPairs[0];
  assert.equal(ev.observation.particleId, 'A1');
  assert.equal(ev.dx, 0);
  assert.equal(ev.dy, 0);
  // 异类观测属于不同最终颗粒
  assert.notEqual(only.observation.finalParticleId, ev.observation.finalParticleId);
  // 未入选的另一端出现在未选观测中
  assert.deepEqual(plan.unselectedObservations.map((o) => o.particleId), ['A1']);
});

test('路径形近邻对：宁可复测两个便宜端点，也不复测昂贵中点', () => {
  // 对：A1-B1、B1-C1（A、C 同视野不同位置）；B 复测价 10，两端各 1。
  const input = mk(1, [
    { particles: [
      { id: 'A1', x: 0, y: 0, category: 'PE', cost: 1 },
      { id: 'C1', x: 0, y: 2, category: 'PET', cost: 1 },
    ] },
    { particles: [{ id: 'B1', x: 0, y: 1, category: 'PP', cost: 10 }] },
    { offset: { x: 100, y: 0 }, particles: [{ id: 'Z1', x: 0, y: 0, category: 'PE', cost: 1 }] },
  ]);
  const plan = buildRetestPlan(input, solveDeduplication(input));
  assert.equal(plan.pairCount, 2);
  assert.equal(plan.totalRetestCost, 2);
  assert.equal(plan.selectedCount, 2);
  assert.deepEqual(plan.retests.map((r) => r.observation.particleId), ['A1', 'C1']);
});

test('总代价相同时最小化复测数量；数量再相同按录入序号序列字典序决胜', () => {
  // 三视野各一个、滤膜坐标重合、类别两两不同 → 三条近邻对构成三角形；
  // 全部代价相同：最优覆盖大小为 2，字典序最前的被选序列为 [A1, B1]。
  const input = mk(0, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', cost: 5 }] },
    { particles: [{ id: 'B1', x: 0, y: 0, category: 'PP', cost: 5 }] },
    { particles: [{ id: 'C1', x: 0, y: 0, category: 'PET', cost: 5 }] },
  ]);
  const plan = buildRetestPlan(input, solveDeduplication(input));
  assert.equal(plan.totalRetestCost, 10);
  assert.equal(plan.selectedCount, 2);
  assert.deepEqual(plan.retests.map((r) => r.observation.particleId), ['A1', 'B1']);
  assert.deepEqual(plan.unselectedObservations.map((o) => o.particleId), ['C1']);
});

test('复测代价全为 0 时仍最小化复测数量', () => {
  const input = mk(0, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', cost: 0 }] },
    { particles: [{ id: 'B1', x: 0, y: 0, category: 'PP', cost: 0 }] },
    { particles: [{ id: 'C1', x: 0, y: 0, category: 'PET', cost: 0 }] },
  ]);
  const plan = buildRetestPlan(input, solveDeduplication(input));
  assert.equal(plan.totalRetestCost, 0);
  assert.equal(plan.selectedCount, 2); // 三角形至少复测两个
});

test('不产生近邻对的情形返回空计划', () => {
  // 同类别不算异类近邻；横向差超过半径不算；同视野不算。
  const sameCategory = mk(0, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', cost: 1 }] },
    { particles: [{ id: 'B1', x: 0, y: 0, category: 'PE', cost: 1 }] },
    { offset: { x: 50, y: 50 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP', cost: 1 }] },
  ]);
  let plan = buildRetestPlan(sameCategory, solveDeduplication(sameCategory));
  assert.equal(plan.pairCount, 0);
  assert.equal(plan.selectedCount, 0);
  assert.equal(plan.totalRetestCost, 0);
  assert.deepEqual(plan.retests, []);
  assert.deepEqual(plan.unselectedObservations, []);

  const tooFar = mk(1, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', cost: 1 }] },
    { particles: [{ id: 'B1', x: 2, y: 0, category: 'PP', cost: 1 }] }, // 横向差 2 > 半径 1
    { offset: { x: 50, y: 50 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PET', cost: 1 }] },
  ]);
  plan = buildRetestPlan(tooFar, solveDeduplication(tooFar));
  assert.equal(plan.pairCount, 0);

  const sameField = mk(0, [
    { particles: [
      { id: 'A1', x: 0, y: 0, category: 'PE', cost: 1 },
      { id: 'A2', x: 0, y: 0, category: 'PP', cost: 1 },
    ] },
    { offset: { x: 50, y: 0 }, particles: [{ id: 'B1', x: 0, y: 0, category: 'PET', cost: 1 }] },
    { offset: { x: 50, y: 50 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PE', cost: 1 }] },
  ]);
  plan = buildRetestPlan(sameField, solveDeduplication(sameField));
  assert.equal(plan.pairCount, 0);
});

test('横纵差必须均不超过半径：单方向超出即不配对，坐标按滤膜坐标换算', () => {
  // F2 平移 (-3, 1)：B1 局部 (3,-1) → 滤膜 (0,0)，与 A1 完全重合。
  const input = mk(0, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', cost: 1 }] },
    { offset: { x: -3, y: 1 }, particles: [{ id: 'B1', x: 3, y: -1, category: 'PP', cost: 1 }] },
    { offset: { x: 100, y: 0 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PET', cost: 1 }] },
  ]);
  const plan = buildRetestPlan(input, solveDeduplication(input));
  assert.equal(plan.pairCount, 1);
  assert.equal(plan.participantCount, 2);
});

test('一对多证据：被选复测项回传它覆盖的全部近邻证据', () => {
  // A1 与 B1、B2 都异类近邻；复测 A1 一并覆盖两对（且更便宜）。
  const input = mk(1, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', cost: 1 }] },
    { particles: [
      { id: 'B1', x: 0, y: 1, category: 'PP', cost: 10 },
      { id: 'B2', x: 1, y: 0, category: 'PET', cost: 10 },
    ] },
    { offset: { x: 100, y: 0 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PE', cost: 1 }] },
  ]);
  const plan = buildRetestPlan(input, solveDeduplication(input));
  assert.deepEqual(plan.retests.map((r) => r.observation.particleId), ['A1']);
  const evidenceIds = plan.retests[0].coveredPairs.map((e) => e.observation.particleId).sort();
  assert.deepEqual(evidenceIds, ['B1', 'B2']);
  assert.deepEqual(plan.unselectedObservations.map((o) => o.particleId).sort(), ['B1', 'B2']);
});

test('参与观测超过精确裁决规模时抛出 SolverLimitError', () => {
  // 5 个视野各 21 个、滤膜坐标全部重合，类别按视野区分（跨视野必为异类，同视野不配对）
  // → 105 个参与观测、10×21² 条异类近邻对；同类别候选关联为空，去重重算本身平凡。
  const fields = [0, 1, 2, 3, 4].map((fi) => ({
    particles: Array.from({ length: 21 }, (_, pi) => ({
      id: `F${fi}P${pi}`,
      x: 0,
      y: 0,
      category: `CAT${fi}`,
      cost: 1,
    })),
  }));
  const input = mk(0, fields);
  assert.throws(
    () => buildRetestPlan(input, solveDeduplication(input)),
    (err) => err.name === 'SolverLimitError' && /精确裁决规模/.test(err.message),
  );
  assert.equal(RETEST_LIMITS.maxParticipantNodes, 100);
});
