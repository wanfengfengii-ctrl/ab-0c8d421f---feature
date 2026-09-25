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
