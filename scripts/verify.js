'use strict';

/**
 * 一次性验收服务（docker compose 中的 verify）：
 *   1. 构建检查：对全部源码执行 node --check（本项目无编译期，语法检查即构建验证）；
 *   2. 单元测试：node --test 运行求解器 / 校验 / API 测试；
 *   3. API 冒烟验收：启动真实服务并执行 scripts/smoke.js 的验收项。
 * 全部通过以退出码 0 结束，否则以退出码 1 结束。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { runSmoke } from './smoke.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function listJsFiles(dir) {
  const abs = path.join(ROOT, dir);
  try {
    return readdirSync(abs)
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(abs, f));
  } catch {
    return [];
  }
}

// ── 步骤 1：构建检查 ─────────────────────────────────────────────
{
  const files = [
    ...listJsFiles('src'),
    ...listJsFiles('scripts'),
    ...listJsFiles('test'),
    ...listJsFiles('public'),
  ];
  const failed = [];
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) failed.push(`${path.relative(ROOT, file)}: ${(r.stderr || '').trim().split('\n')[0]}`);
  }
  record(`构建检查（node --check，共 ${files.length} 个文件）`, failed.length === 0, failed.join('；'));
}

// ── 步骤 2：单元测试 ─────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8' });
  const ok = r.status === 0;
  record('单元测试（node --test）', ok);
  if (!ok) {
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n');
    console.log(out.slice(-40).join('\n'));
  }
}

// ── 步骤 3：API 冒烟验收 ─────────────────────────────────────────
{
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`  冒烟验收目标: ${base}（verify 内部启动的真实服务）`);
  let ok = true;
  try {
    const results = await runSmoke(base);
    for (const r of results) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
      if (!r.ok) ok = false;
    }
  } catch (err) {
    ok = false;
    console.log(`  ✗ 冒烟验收异常: ${err && err.stack ? err.stack : err}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  record('API 冒烟验收', ok);
}

const allOk = steps.every((s) => s.ok);
console.log('');
console.log(allOk ? '═══ 验收通过：构建、测试与 API 冒烟全部成功 ═══' : '═══ 验收未通过，请检查上述失败项 ═══');
process.exit(allOk ? 0 : 1);
