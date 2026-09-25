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
  return fetch(`${base}/api/particle-deduplications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
}

test('GET /api/health 返回健康状态', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('GET / 返回前端页面', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /微塑料/);
  assert.match(html, /app\.js/);
});

test('POST /api/particle-deduplications 返回裁决结果', async () => {
  const res = await post({
    tolerance: 1,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
      { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totalParticles, 3); // 拒绝贪心：{A1,B2}、{A2,B1}、{C1}
  assert.equal(body.linkCount, 2);
  assert.equal(body.observationCount, 5);
  const groups = body.particles
    .map((p) => p.observations.map((o) => o.particleId).sort().join('+'))
    .sort();
  assert.deepEqual(groups, ['A1+B2', 'A2+B1', 'C1']);
  const merged = body.particles.find((p) => p.observations.length === 2);
  assert.equal(merged.category, 'PE');
  assert.ok(merged.representative && typeof merged.representative.x === 'number');
});

test('输入不合规返回 400 与可定位问题列表', async () => {
  const res = await post({
    tolerance: 1,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0.5, y: 0, category: '' }] },
    ],
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error && Array.isArray(body.error.issues));
  const paths = body.error.issues.map((i) => i.path);
  assert.ok(paths.includes('fields')); // 视野数量不足
  assert.ok(paths.includes('fields[1].particles[0].id')); // 编号重复
  assert.ok(paths.includes('fields[1].particles[0].x')); // 非整数坐标
  assert.ok(paths.includes('fields[1].particles[0].category')); // 类别为空
});

test('非法 JSON 请求体返回 400', async () => {
  const res = await post('{not valid json', true);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /JSON/);
});

test('未知接口返回 404', async () => {
  const res = await fetch(`${base}/api/no-such-endpoint`);
  assert.equal(res.status, 404);
});

function postRetest(body, raw = false) {
  return fetch(`${base}/api/neighbor-retest-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
}

test('POST /api/neighbor-retest-plans 返回最小代价复测计划', async () => {
  const res = await postRetest({
    tolerance: 5,
    radius: 2,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [
        { id: 'A1', x: 0, y: 0, category: 'PE', retestCost: 5 },
        { id: 'A2', x: 10, y: 10, category: 'PP', retestCost: 3 },
      ] },
      { offset: { x: 0, y: 0 }, particles: [
        { id: 'B1', x: 1, y: 1, category: 'PP', retestCost: 1 },
        { id: 'B2', x: 10, y: 11, category: 'PE', retestCost: 4 },
      ] },
      { offset: { x: 100, y: 100 }, particles: [
        { id: 'C1', x: 0, y: 0, category: 'PET', retestCost: 9 },
      ] },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.neighborPairCount, 2);
  assert.equal(body.involvedObservationCount, 4);
  assert.equal(body.totalRetestCost, 4); // B1(1) + A2(3)
  assert.equal(body.retestCount, 2);
  assert.deepEqual(body.selected.map((s) => s.particleId), ['A2', 'B1']);
  assert.deepEqual(body.unselected.map((s) => s.particleId), ['A1', 'B2']);
  // 每对证据由被选端覆盖
  for (const p of body.pairs) {
    assert.ok(body.selected.some((s) => s.particleId === p.coveredBy));
    assert.ok(p.a.particle !== undefined && p.b.particle !== undefined);
  }
  // 服务端重算了最终颗粒
  assert.ok(body.deduplication && typeof body.deduplication.totalParticles === 'number');
  // 每项含其覆盖的近邻证据
  assert.equal(body.selected.find((s) => s.particleId === 'A2').covers.length, 1);
});

test('无异类近邻对时复测计划为空', async () => {
  const res = await postRetest({
    tolerance: 1,
    radius: 1,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', retestCost: 1 }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE', retestCost: 1 }] },
      { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP', retestCost: 1 }] },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.neighborPairCount, 0);
  assert.equal(body.retestCount, 0);
  assert.equal(body.totalRetestCost, 0);
  assert.deepEqual(body.selected, []);
  assert.deepEqual(body.unselected, []);
  assert.deepEqual(body.pairs, []);
});

test('复测计划输入不合规返回 400 且问题可定位', async () => {
  const res = await postRetest({
    tolerance: 1,
    radius: -1,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 0, y: 0, category: 'PP' }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PET', retestCost: -2 }] },
    ],
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  const paths = body.error.issues.map((i) => i.path);
  assert.ok(paths.includes('radius'));
  assert.ok(paths.includes('fields[0].particles[0].retestCost'));
  assert.ok(paths.includes('fields[2].particles[0].retestCost'));
});

test('参与观测超过精确裁决规模时复测计划返回 422', async () => {
  const cats = ['PE', 'PP', 'PET'];
  const fields = cats.map((cat, fi) => ({
    name: `F${fi + 1}`,
    offset: { x: 0, y: 0 },
    particles: Array.from({ length: 67 }, (_, i) => ({
      id: `F${fi}_${i}`, x: 0, y: 0, category: cat, retestCost: 1,
    })),
  }));
  const res = await postRetest({ tolerance: 0, radius: 0, fields });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error.message, /参与近邻对的观测数/);
});
