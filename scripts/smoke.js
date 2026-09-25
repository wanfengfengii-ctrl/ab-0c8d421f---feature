'use strict';

/**
 * API 冒烟验收：针对运行中的服务执行健康检查、页面可达性、
 * 去重裁决（含拒绝贪心的关键用例）、校验反馈与错误处理检查。
 * 既可被 verify 调用，也可独立运行：BASE_URL=http://host:port node scripts/smoke.js
 */

export async function runSmoke(base) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail || '' });
  };
  const post = (body, raw = false) => fetch(`${base}/api/particle-deduplications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  const postRetest = (body) => fetch(`${base}/api/neighbor-retest-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // 1. 健康检查
  try {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    check('GET /api/health → 200 且 status=ok', res.status === 200 && body.status === 'ok', `HTTP ${res.status}`);
  } catch (err) {
    check('GET /api/health', false, String(err));
  }

  // 2. 前端页面
  try {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    check('GET / → 200 且包含录入界面', res.status === 200 && html.includes('微塑料') && html.includes('app.js'), `HTTP ${res.status}`);
    check('页面包含异类近邻复测入口', html.includes('异类近邻复测'), '缺少复测入口');
  } catch (err) {
    check('GET /', false, String(err));
  }

  // 3. 去重裁决：关键用例（局部贪心会得出 4 个颗粒，全局最优为 3 个）
  try {
    const res = await post({
      tolerance: 1,
      fields: [
        { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
        { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
        { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
      ],
    });
    const body = await res.json();
    check('POST 裁决 → 200', res.status === 200, `HTTP ${res.status}`);
    check('最终颗粒总数为 3（拒绝贪心结果 4）', body.totalParticles === 3, `实际为 ${body.totalParticles}`);
    const groups = (body.particles || [])
      .map((p) => p.observations.map((o) => o.particleId).sort().join('+'))
      .sort();
    check('分组为 {A1,B2}、{A2,B1}、{C1}', JSON.stringify(groups) === JSON.stringify(['A1+B2', 'A2+B1', 'C1']), groups.join(' | '));
    const merged = (body.particles || []).find((p) => p.observations.some((o) => o.particleId === 'B2'));
    check(
      '代表坐标为质心 (0, 0.5) 且类别正确',
      !!merged && merged.representative.x === 0 && merged.representative.y === 0.5 && merged.category === 'PE',
      merged ? JSON.stringify(merged.representative) : '未找到颗粒',
    );
    const links = (body.particles || []).flatMap((p) => p.links.map((l) => [l.a, l.b].sort().join('~'))).sort();
    check('所选关联为 A1-B2、A2-B1', JSON.stringify(links) === JSON.stringify(['A1~B2', 'A2~B1']), links.join(' | '));
  } catch (err) {
    check('POST 裁决', false, String(err));
  }

  // 4. 校验反馈：可定位且保留草稿语义（400 + issues）
  try {
    const res = await post({
      tolerance: 1,
      fields: [
        { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
        { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0.5, y: 0, category: '' }] },
      ],
    });
    const body = await res.json();
    const paths = (body.error && Array.isArray(body.error.issues)) ? body.error.issues.map((i) => i.path) : [];
    check('不合规输入 → 400', res.status === 400, `HTTP ${res.status}`);
    check(
      '反馈包含可定位路径',
      paths.includes('fields[1].particles[0].id') && paths.includes('fields[1].particles[0].x') && paths.includes('fields'),
      paths.join(' | '),
    );
  } catch (err) {
    check('校验反馈', false, String(err));
  }

  // 5. 非法 JSON
  try {
    const res = await post('{not valid json', true);
    check('非法 JSON → 400', res.status === 400, `HTTP ${res.status}`);
  } catch (err) {
    check('非法 JSON', false, String(err));
  }

  // 6. 未知接口
  try {
    const res = await fetch(`${base}/api/no-such-endpoint`);
    check('未知接口 → 404', res.status === 404, `HTTP ${res.status}`);
  } catch (err) {
    check('未知接口', false, String(err));
  }

  // 7. 异类近邻复测计划：每对异类近邻至少复测一端，最小总代价清单唯一
  try {
    const res = await postRetest({
      tolerance: 5,
      radius: 2,
      fields: [
        { name: 'F1', offset: { x: 0, y: 0 }, particles: [
          { id: 'A1', x: 0, y: 0, category: 'PE', retestCost: 5 },
          { id: 'A2', x: 10, y: 10, category: 'PP', retestCost: 3 },
        ] },
        { name: 'F2', offset: { x: 0, y: 0 }, particles: [
          { id: 'B1', x: 1, y: 1, category: 'PP', retestCost: 1 },
          { id: 'B2', x: 10, y: 11, category: 'PE', retestCost: 4 },
        ] },
        { name: 'F3', offset: { x: 100, y: 100 }, particles: [
          { id: 'C1', x: 0, y: 0, category: 'PET', retestCost: 9 },
        ] },
      ],
    });
    const body = await res.json();
    check('POST 复测计划 → 200', res.status === 200, `HTTP ${res.status}`);
    check('近邻证据 2 对、参与观测 4 个', body.neighborPairCount === 2 && body.involvedObservationCount === 4,
      `${body.neighborPairCount}/${body.involvedObservationCount}`);
    check('最小总代价 4、复测 2 项', body.totalRetestCost === 4 && body.retestCount === 2,
      `代价 ${body.totalRetestCost}、${body.retestCount} 项`);
    check('复测清单为 A2、B1（字典序稳定决胜）',
      JSON.stringify(body.selected.map((s) => s.particleId)) === JSON.stringify(['A2', 'B1']),
      (body.selected || []).map((s) => s.particleId).join('、'));
    check('未选观测为 A1、B2',
      JSON.stringify(body.unselected.map((s) => s.particleId)) === JSON.stringify(['A1', 'B2']),
      (body.unselected || []).map((s) => s.particleId).join('、'));
    let covered = true;
    for (const p of body.pairs || []) {
      if (!body.selected.some((s) => s.particleId === p.coveredBy)) covered = false;
    }
    check('每条近邻证据均由被选端覆盖', covered);
    check('每项返回覆盖证据与最终颗粒编号',
      body.selected.every((s) => Array.isArray(s.covers) && s.covers.length > 0
        && typeof s.particle === 'number'),
    );
    check('服务端重算最终颗粒', typeof body.deduplication?.totalParticles === 'number');
  } catch (err) {
    check('POST 复测计划', false, String(err));
  }

  // 8. 复测计划空结果：无异类近邻对
  try {
    const res = await postRetest({
      tolerance: 1,
      radius: 1,
      fields: [
        { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE', retestCost: 1 }] },
        { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE', retestCost: 1 }] },
        { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP', retestCost: 1 }] },
      ],
    });
    const body = await res.json();
    check('无异类近邻对 → 200 且空计划',
      res.status === 200 && body.neighborPairCount === 0 && body.retestCount === 0
        && body.selected.length === 0 && body.unselected.length === 0 && body.pairs.length === 0,
      `HTTP ${res.status}`);
  } catch (err) {
    check('复测空计划', false, String(err));
  }

  // 9. 复测计划入参校验
  try {
    const res = await postRetest({
      tolerance: 1,
      radius: -1,
      fields: [
        { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
        { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 0, y: 0, category: 'PP' }] },
        { offset: { x: 0, y: 0 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PET', retestCost: 'x' }] },
      ],
    });
    const body = await res.json();
    const paths = (body.error && Array.isArray(body.error.issues)) ? body.error.issues.map((i) => i.path) : [];
    check('复测不合规 → 400', res.status === 400, `HTTP ${res.status}`);
    check('复测反馈可定位到 radius 与 retestCost',
      paths.includes('radius') && paths.includes('fields[0].particles[0].retestCost')
        && paths.includes('fields[2].particles[0].retestCost'),
      paths.join(' | '));
  } catch (err) {
    check('复测入参校验', false, String(err));
  }

  // 10. 复测规模保护
  try {
    const cats = ['PE', 'PP', 'PET'];
    const fields = cats.map((cat, fi) => ({
      name: `F${fi + 1}`,
      offset: { x: 0, y: 0 },
      particles: Array.from({ length: 67 }, (_, i) => ({
        id: `F${fi}_${i}`, x: 0, y: 0, category: cat, retestCost: 1,
      })),
    }));
    const res = await postRetest({ tolerance: 0, radius: 0, fields });
    check('参与观测超精确裁决规模 → 422', res.status === 422, `HTTP ${res.status}`);
  } catch (err) {
    check('复测规模保护', false, String(err));
  }

  return results;
}

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const base = process.env.BASE_URL || 'http://127.0.0.1:8080';
  console.log(`[smoke] 目标服务: ${base}`);
  const results = await runSmoke(base);
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  }
  const ok = results.every((r) => r.ok);
  console.log(ok ? '[smoke] 全部通过' : '[smoke] 存在失败项');
  process.exit(ok ? 0 : 1);
}
