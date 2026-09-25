'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { solveDeduplication } from '../src/dedup.js';

/** 构造归一化输入（与校验后的结构一致）。 */
function mk(tolerance, fields) {
  return {
    tolerance,
    fields: fields.map((f, i) => ({
      name: f.name || `F${i + 1}`,
      offset: { x: f.offset?.x ?? 0, y: f.offset?.y ?? 0 },
      particles: f.particles.map((p) => ({ id: p.id, x: p.x, y: p.y, category: p.category })),
    })),
  };
}

function linkPairs(result) {
  const pairs = [];
  for (const p of result.particles) {
    for (const l of p.links) pairs.push([l.a, l.b].sort().join('~'));
  }
  return pairs.sort();
}

function groupOf(result, particleId) {
  const found = result.particles.find((p) => p.observations.some((o) => o.particleId === particleId));
  return found ? found.observations.map((o) => o.particleId).sort() : null;
}

test('拒绝局部贪心：全局最少化最终颗粒数（匹配陷阱）', () => {
  // 候选关联：A1-B1、A1-B2、A2-B1（权重均为 1）。
  // 贪心先取 A1-B1 后其余均被“同一视野至多一个”阻断 → 仅 1 条关联、3 个颗粒；
  // 全局最优为 {A1,B2} 与 {A2,B1} → 2 条关联、2 个颗粒。
  const input = mk(1, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 2);
  assert.equal(r.linkCount, 2);
  assert.deepEqual(groupOf(r, 'A1'), ['A1', 'B2']);
  assert.deepEqual(groupOf(r, 'A2'), ['A2', 'B1']);
});

test('颗粒数相同时最小化所选关联的曼哈顿差总和', () => {
  // 两种最大匹配：{A1-B1, A2-B2} 总差 6；{A1-B2, A2-B1} 总差 2 → 选后者。
  const input = mk(3, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 2, y: 1, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 2);
  assert.deepEqual(linkPairs(r), ['A1~B2', 'A2~B1']);
});

test('字典序确定唯一结论：零差三角形取链式关联', () => {
  // 三个视野各一个同位置观测，候选关联构成零权重三角形。
  // 唯一最优（2 条关联、总差 0）中字典序最小者为 {P1-P2, P2-P3}。
  const input = mk(0, [
    { particles: [{ id: 'P1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'P2', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'P3', x: 0, y: 0, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 1);
  assert.equal(r.linkCount, 2);
  assert.deepEqual(linkPairs(r), ['P1~P2', 'P2~P3']);
});

test('五个视野同位置观测：字典序唯一结论为链式关联', () => {
  const input = mk(0, [
    { particles: [{ id: 'P1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'P2', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'P3', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'P4', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'P5', x: 0, y: 0, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 1);
  assert.equal(r.linkCount, 4);
  assert.deepEqual(linkPairs(r), ['P1~P2', 'P2~P3', 'P3~P4', 'P4~P5']);
});

test('同一视野在同一最终颗粒中至多一个观测', () => {
  // A1、A2 同视野，均只与 B1 相邻；权重相同，按字典序取 {A2,B1}（A1 的伙伴列表为空更小）。
  const input = mk(1, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 0, y: 2, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 0, y: 1, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 2);
  assert.equal(r.linkCount, 1);
  assert.deepEqual(groupOf(r, 'B1'), ['A2', 'B1']);
  assert.deepEqual(groupOf(r, 'A1'), ['A1']);
});

test('类别不同的观测不得建立关联', () => {
  const input = mk(5, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 0, y: 0, category: 'PP' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 2);
  assert.equal(r.linkCount, 0);
});

test('同一视野内的观测不得建立关联', () => {
  const input = mk(10, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 1, y: 1, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 50, y: 50, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 3);
  assert.equal(r.linkCount, 0);
});

test('容差边界：横纵差均不超过容差才可关联', () => {
  const within = solveDeduplication(mk(4, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 3, y: 4, category: 'PE' }] },
  ]));
  assert.equal(within.totalParticles, 1);

  const beyondX = solveDeduplication(mk(4, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 5, y: 0, category: 'PE' }] },
  ]));
  assert.equal(beyondX.totalParticles, 2);

  const beyondY = solveDeduplication(mk(4, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 0, y: 5, category: 'PE' }] },
  ]));
  assert.equal(beyondY.totalParticles, 2);
});

test('平移位置换算到滤膜坐标后再判定', () => {
  // F2 平移 (100, 0)：B1 局部 (-98, 2) → 滤膜坐标 (2, 2)，与 A1 (0,0) 差 (2,2)。
  const input = mk(2, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { offset: { x: 100, y: 0 }, particles: [{ id: 'B1', x: -98, y: 2, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 1);
  assert.equal(r.linkCount, 1);
  const obs = r.particles[0].observations;
  assert.deepEqual(obs.find((o) => o.particleId === 'B1').filterX, 2);
});

test('代表坐标为成员滤膜坐标的质心（保留两位小数）', () => {
  const input = mk(1, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 0, y: 1, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 1);
  assert.deepEqual(r.particles[0].representative, { x: 0, y: 0.5 });
  assert.equal(r.particles[0].category, 'PE');
});

test('最终颗粒内观测必须通过所选关联连通（链式合并）', () => {
  // A1-B1、B1-C1 可关联，A1-C1 距离过远；结果为一个三观测颗粒。
  const input = mk(2, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 2, y: 0, category: 'PE' }] },
    { particles: [{ id: 'C1', x: 4, y: 0, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 1);
  assert.equal(r.linkCount, 2);
  assert.deepEqual(groupOf(r, 'A1'), ['A1', 'B1', 'C1']);
});

test('孤立观测构成独立颗粒，结果按录入顺序编号', () => {
  const input = mk(1, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { particles: [{ id: 'B1', x: 0, y: 0, category: 'PP' }] },
    { particles: [{ id: 'C1', x: 0, y: 0, category: 'PET' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 3);
  assert.deepEqual(r.particles.map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(r.particles.map((p) => p.observations[0].particleId), ['A1', 'B1', 'C1']);
});

test('复杂场景：多视野重叠带的整体最优', () => {
  // F1: A1(0,0) A2(10,0)；F2 平移(10,0): B1(-9,1)→(1,1) B2(1,1)→(11,1)；F3 平移(5,10): C1(-5,-9)→(0,1)
  // 候选：A1-B1(2)、A1-C1(1)、A2-B2(2)、B1-C1(1)。最优 3 条关联？同一分量至多每视野一个：
  // {A1,B1,C1} 需 2 条（如 A1-C1 + B1-C1 总差 2），A2-B2 1 条 → 共 3 条关联、2 个颗粒。
  const input = mk(2, [
    { particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 10, y: 0, category: 'PE' }] },
    { offset: { x: 10, y: 0 }, particles: [{ id: 'B1', x: -9, y: 1, category: 'PE' }, { id: 'B2', x: 1, y: 1, category: 'PE' }] },
    { offset: { x: 5, y: 10 }, particles: [{ id: 'C1', x: -5, y: -9, category: 'PE' }] },
  ]);
  const r = solveDeduplication(input);
  assert.equal(r.totalParticles, 2);
  assert.equal(r.linkCount, 3);
  assert.deepEqual(groupOf(r, 'C1'), ['A1', 'B1', 'C1']);
  assert.deepEqual(groupOf(r, 'A2'), ['A2', 'B2']);
});
