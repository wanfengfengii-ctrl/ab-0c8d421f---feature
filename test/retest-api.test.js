'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

let server;
let base;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function post(body, raw = false) {
  return fetch(`${base}/api/particle-retest-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
}

function validBody() {
  return {
    tolerance: 5,
    radius: 2,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', retestCost: 5 }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PP', retestCost: 3 }] },
      { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PET', retestCost: 1 }] },
    ],
  };
}

test('复测计划 → 200：服务端重算最终颗粒并给出唯一最小代价清单', async () => {
  const res = await post(validBody());
  assert.equal(res.status, 200);
  const body = await res.json();
  // 先重算去重裁决
  assert.equal(body.fieldCount, 3);
  assert.equal(body.observationCount, 3);
  assert.equal(body.deduplicatedParticles, 3);
  // 异类近邻对 A1(PE)-B1(PP) 距离 (1,0) ≤ 半径 2 → 选便宜的 B1
  assert.equal(body.plan.pairCount, 1);
  assert.equal(body.plan.participantCount, 2);
  assert.equal(body.plan.selectedCount, 1);
  assert.equal(body.plan.totalRetestCost, 3);
  assert.equal(body.plan.retests[0].observation.particleId, 'B1');
  assert.equal(body.plan.retests[0].coveredPairs[0].observation.particleId, 'A1');
  // 证据两端对应不同最终颗粒
  const pB = body.plan.retests[0].observation.finalParticleId;
  const pA = body.plan.retests[0].coveredPairs[0].observation.finalParticleId;
  assert.notEqual(pA, pB);
  assert.deepEqual(body.plan.unselectedObservations.map((o) => o.particleId), ['A1']);
});

test('没有异类近邻对时返回空计划', async () => {
  const body0 = validBody();
  body0.radius = 0; // A1(0,0) 与 B1(1,0) 横向差 1 > 0
  const res = await post(body0);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan.pairCount, 0);
  assert.equal(body.plan.participantCount, 0);
  assert.equal(body.plan.selectedCount, 0);
  assert.equal(body.plan.totalRetestCost, 0);
  assert.deepEqual(body.plan.retests, []);
  assert.deepEqual(body.plan.unselectedObservations, []);
});

test('缺少复测半径返回 400 且定位到 radius', async () => {
  const body0 = validBody();
  delete body0.radius;
  const res = await post(body0);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error && Array.isArray(body.error.issues));
  assert.ok(body.error.issues.some((i) => i.path === 'radius'));
});

test('复测半径必须是非负整数（负数 / 小数 / 字符串均拒绝）', async () => {
  for (const bad of [-1, 1.5, '3', null]) {
    const body0 = validBody();
    body0.radius = bad;
    const res = await post(body0);
    assert.equal(res.status, 400, `radius=${bad} 应被拒绝`);
    const body = await res.json();
    assert.ok(body.error.issues.some((i) => i.path === 'radius'));
  }
});

test('缺少或非法复测代价返回 400 且定位到具体颗粒', async () => {
  const missing = validBody();
  delete missing.fields[1].particles[0].retestCost;
  let res = await post(missing);
  assert.equal(res.status, 400);
  let body = await res.json();
  assert.ok(body.error.issues.some((i) => i.path === 'fields[1].particles[0].retestCost'));

  for (const bad of [-2, 1.5, '3']) {
    const b = validBody();
    b.fields[0].particles[0].retestCost = bad;
    res = await post(b);
    assert.equal(res.status, 400, `retestCost=${bad} 应被拒绝`);
    body = await res.json();
    assert.ok(body.error.issues.some((i) => i.path === 'fields[0].particles[0].retestCost'));
  }
});

test('复测代价 0 合法', async () => {
  const body0 = validBody();
  body0.fields[0].particles[0].retestCost = 0;
  const res = await post(body0);
  assert.equal(res.status, 200);
});

test('既有的去重裁决接口不受影响（不要求 radius / retestCost）', async () => {
  const body0 = validBody();
  delete body0.radius;
  delete body0.fields[0].particles[0].retestCost;
  delete body0.fields[1].particles[0].retestCost;
  delete body0.fields[2].particles[0].retestCost;
  const res = await fetch(`${base}/api/particle-deduplications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body0),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totalParticles, 3);
});

test('参与观测超过精确裁决规模返回 422', async () => {
  const body0 = {
    tolerance: 0,
    radius: 0,
    fields: [0, 1, 2, 3, 4].map((fi) => ({
      offset: { x: 0, y: 0 },
      particles: Array.from({ length: 21 }, (_, pi) => ({
        id: `F${fi}P${pi}`, x: 0, y: 0, category: `CAT${fi}`, retestCost: 1,
      })),
    })),
  };
  const res = await post(body0);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error.message, /精确裁决规模/);
});

test('非法 JSON 返回 400', async () => {
  const res = await post('{not valid json', true);
  assert.equal(res.status, 400);
});
