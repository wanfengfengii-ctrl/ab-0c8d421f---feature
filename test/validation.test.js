'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmission } from '../src/validation.js';

function validBody() {
  return {
    tolerance: 5,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 1, y: 2, category: 'PE' }] },
      { offset: { x: 100, y: 0 }, particles: [{ id: 'B1', x: 3, y: 4, category: 'PP' }] },
      { offset: { x: 0, y: 100 }, particles: [{ id: 'C1', x: 5, y: 6, category: 'PET' }] },
    ],
  };
}

test('合法输入通过校验并归一化（默认视野名、修剪字符串）', () => {
  const body = validBody();
  body.fields[0].name = '  视野甲  ';
  body.fields[0].particles[0].id = '  A1  ';
  const r = validateSubmission(body);
  assert.equal(r.ok, true);
  assert.equal(r.value.fields[0].name, '视野甲');
  assert.equal(r.value.fields[0].particles[0].id, 'A1');
  assert.equal(r.value.fields[1].name, 'F2'); // 未命名视野使用默认名
});

test('视野数量必须为 3~5 个', () => {
  const tooFew = validateSubmission({ tolerance: 1, fields: validBody().fields.slice(0, 2) });
  assert.equal(tooFew.ok, false);
  assert.ok(tooFew.issues.some((i) => i.path === 'fields'));

  const tooMany = validateSubmission({
    tolerance: 1,
    fields: [...validBody().fields, ...validBody().fields, ...validBody().fields].map((f, i) => ({
      ...f,
      particles: f.particles.map((p) => ({ ...p, id: `${p.id}_${i}` })),
    })),
  });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.issues.some((i) => i.path === 'fields'));
});

test('颗粒编号必须全局唯一，反馈可定位到重复位置', () => {
  const body = validBody();
  body.fields[2].particles[0].id = 'A1'; // 与 fields[0].particles[0] 重复
  const r = validateSubmission(body);
  assert.equal(r.ok, false);
  const issue = r.issues.find((i) => i.path === 'fields[2].particles[0].id');
  assert.ok(issue, '应定位到 fields[2].particles[0].id');
  assert.match(issue.message, /A1/);
  assert.match(issue.message, /fields\[0\]\.particles\[0\]\.id/);
});

test('坐标必须为整数，反馈定位到具体颗粒的具体分量', () => {
  const body = validBody();
  body.fields[1].particles[0].x = 1.5;
  const r = validateSubmission(body);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === 'fields[1].particles[0].x'));
});

test('平移位置必须为整数对象', () => {
  const body = validBody();
  body.fields[0].offset = { x: '0', y: 0 };
  const r = validateSubmission(body);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === 'fields[0].offset.x'));

  const missing = validBody();
  delete missing.fields[0].offset;
  const r2 = validateSubmission(missing);
  assert.equal(r2.ok, false);
  assert.ok(r2.issues.some((i) => i.path === 'fields[0].offset'));
});

test('类别必须非空', () => {
  const body = validBody();
  body.fields[0].particles[0].category = '   ';
  const r = validateSubmission(body);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === 'fields[0].particles[0].category'));
});

test('容差必须是非负整数', () => {
  for (const bad of [-1, 0.5, '5', null]) {
    const body = validBody();
    body.tolerance = bad;
    const r = validateSubmission(body);
    assert.equal(r.ok, false, `tolerance=${bad} 应被拒绝`);
    assert.ok(r.issues.some((i) => i.path === 'tolerance'));
  }
  const okZero = validateSubmission({ ...validBody(), tolerance: 0 });
  assert.equal(okZero.ok, true);
});

test('非对象请求体与缺失字段被拒绝', () => {
  assert.equal(validateSubmission(null).ok, false);
  assert.equal(validateSubmission([1, 2, 3]).ok, false);
  const r = validateSubmission({ tolerance: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === 'fields'));
});

test('一次返回全部可定位问题', () => {
  const body = validBody();
  body.tolerance = -1;
  body.fields[0].particles[0].id = '';
  body.fields[1].particles[0].y = 2.5;
  const r = validateSubmission(body);
  assert.equal(r.ok, false);
  const paths = r.issues.map((i) => i.path);
  assert.ok(paths.includes('tolerance'));
  assert.ok(paths.includes('fields[0].particles[0].id'));
  assert.ok(paths.includes('fields[1].particles[0].y'));
});
