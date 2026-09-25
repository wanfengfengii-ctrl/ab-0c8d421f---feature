'use strict';

/**
 * 提交内容校验：返回 { ok, issues } 或 { ok, value }。
 * issues 中每条都带有可定位的 path（如 fields[1].particles[2].x），
 * 前端据此高亮对应录入项并保留草稿。
 */

export const VALIDATION_LIMITS = Object.freeze({
  minFields: 3,
  maxFields: 5,
  maxParticlesPerField: 500,
  maxTotalParticles: 2000,
  maxCoordinate: 1000000,
  maxTolerance: 1000000,
  maxIdLength: 64,
  maxCategoryLength: 50,
  maxFieldNameLength: 50,
  maxIssues: 50,
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateSubmission(body) {
  const issues = [];
  const push = (path, message) => {
    if (issues.length < VALIDATION_LIMITS.maxIssues) issues.push({ path, message });
  };

  if (!isPlainObject(body)) {
    return { ok: false, issues: [{ path: '', message: '请求体必须是 JSON 对象' }] };
  }

  // 容差
  const t = body.tolerance;
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > VALIDATION_LIMITS.maxTolerance) {
    push('tolerance', `容差必须是 0 ~ ${VALIDATION_LIMITS.maxTolerance} 的整数`);
  }

  // 视野列表
  const fields = body.fields;
  if (!Array.isArray(fields)) {
    push('fields', 'fields 必须是数组');
    return { ok: false, issues };
  }
  if (fields.length < VALIDATION_LIMITS.minFields || fields.length > VALIDATION_LIMITS.maxFields) {
    push('fields', `视野数量必须为 ${VALIDATION_LIMITS.minFields} ~ ${VALIDATION_LIMITS.maxFields} 个，当前为 ${fields.length} 个`);
  }

  let totalParticles = 0;
  const idSeen = new Map(); // 编号 → 首次出现位置

  fields.forEach((field, fi) => {
    const fp = `fields[${fi}]`;
    if (!isPlainObject(field)) {
      push(fp, '视野必须是对象 {name?, offset:{x,y}, particles:[...]}');
      return;
    }

    if (field.name !== undefined
      && (typeof field.name !== 'string' || field.name.trim().length > VALIDATION_LIMITS.maxFieldNameLength)) {
      push(`${fp}.name`, `视野名称必须是不超过 ${VALIDATION_LIMITS.maxFieldNameLength} 字符的字符串`);
    }

    const off = field.offset;
    if (!isPlainObject(off)) {
      push(`${fp}.offset`, '平移位置必须是 {x, y} 对象');
    } else {
      for (const key of ['x', 'y']) {
        const v = off[key];
        if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > VALIDATION_LIMITS.maxCoordinate) {
          push(`${fp}.offset.${key}`, `平移坐标必须是 |v| ≤ ${VALIDATION_LIMITS.maxCoordinate} 的整数`);
        }
      }
    }

    const ps = field.particles;
    if (!Array.isArray(ps)) {
      push(`${fp}.particles`, 'particles 必须是数组');
      return;
    }
    if (ps.length > VALIDATION_LIMITS.maxParticlesPerField) {
      push(`${fp}.particles`, `单个视野的颗粒数不能超过 ${VALIDATION_LIMITS.maxParticlesPerField}（当前 ${ps.length}）`);
    }
    totalParticles += ps.length;

    ps.forEach((p, pi) => {
      const pp = `${fp}.particles[${pi}]`;
      if (!isPlainObject(p)) {
        push(pp, '颗粒必须是对象 {id, x, y, category}');
        return;
      }
      const id = p.id;
      if (typeof id !== 'string' || id.trim().length === 0) {
        push(`${pp}.id`, '颗粒编号必须是非空字符串');
      } else if (id.trim().length > VALIDATION_LIMITS.maxIdLength) {
        push(`${pp}.id`, `颗粒编号长度不能超过 ${VALIDATION_LIMITS.maxIdLength} 字符`);
      } else {
        const key = id.trim();
        if (idSeen.has(key)) {
          push(`${pp}.id`, `颗粒编号“${key}”重复（首次出现于 ${idSeen.get(key)}）`);
        } else {
          idSeen.set(key, `${pp}.id`);
        }
      }
      for (const key of ['x', 'y']) {
        const v = p[key];
        if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > VALIDATION_LIMITS.maxCoordinate) {
          push(`${pp}.${key}`, `颗粒坐标必须是 |v| ≤ ${VALIDATION_LIMITS.maxCoordinate} 的整数`);
        }
      }
      const c = p.category;
      if (typeof c !== 'string' || c.trim().length === 0) {
        push(`${pp}.category`, '聚合物类别必须是非空字符串（如 PE、PP、PET）');
      } else if (c.trim().length > VALIDATION_LIMITS.maxCategoryLength) {
        push(`${pp}.category`, `聚合物类别长度不能超过 ${VALIDATION_LIMITS.maxCategoryLength} 字符`);
      }
    });
  });

  if (totalParticles > VALIDATION_LIMITS.maxTotalParticles) {
    push('fields', `颗粒总数不能超过 ${VALIDATION_LIMITS.maxTotalParticles}（当前 ${totalParticles}）`);
  }

  if (issues.length > 0) return { ok: false, issues };

  // 归一化：修剪字符串、补默认视野名
  const value = {
    tolerance: t,
    fields: fields.map((f, fi) => ({
      name: typeof f.name === 'string' && f.name.trim().length > 0 ? f.name.trim() : `F${fi + 1}`,
      offset: { x: f.offset.x, y: f.offset.y },
      particles: f.particles.map((p) => ({
        id: p.id.trim(),
        x: p.x,
        y: p.y,
        category: p.category.trim(),
      })),
    })),
  };
  return { ok: true, value };
}
