'use strict';

/**
 * 颗粒去重裁决求解器（精确全局最优，非贪心）。
 *
 * 规则（详见 README）：
 *  1. 仅允许在“不同视野、类别相同、换算到滤膜坐标后横纵差均 ≤ 容差”的观测间建立候选关联。
 *  2. 所选关联构成森林；每个连通分量（最终颗粒）中同一视野至多一个观测。
 *  3. 目标依次为：最少化最终颗粒数 → 最小化所选关联曼哈顿差总和 →
 *     按“视野录入顺序展开的伙伴编号序列”字典序取最小，确定唯一结论。
 */

export class SolverLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SolverLimitError';
  }
}

export const SOLVER_LIMITS = Object.freeze({
  maxCandidateLinks: 100000, // 全部候选关联上限
  maxComponentNodes: 200,    // 单个候选连通分量的观测上限
  maxComponentEdges: 5000,   // 单个候选连通分量的候选关联上限
});

/** 编号比较：按字符串字典序（提交内编号唯一，不存在相等）。 */
function compareId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 普通并查集（仅用于图分解与结果汇总）。 */
class PlainUnionFind {
  constructor(n) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
    this.rank = new Int32Array(n);
  }
  find(x) {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[x] !== r) { const nxt = this.parent[x]; this.parent[x] = r; x = nxt; }
    return r;
  }
  union(a, b) {
    let ra = this.find(a); let rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) { const t = ra; ra = rb; rb = t; }
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra] += 1;
    return true;
  }
}

/**
 * 可回滚并查集：每个连通分量维护“已占用视野”位掩码，
 * 合并时若两分量占用同一视野则拒绝（保证同一视野至多一个观测）；
 * 拒绝成环（所选关联构成森林）。
 */
class RollbackUnionFind {
  constructor(fieldOfNode) {
    const n = fieldOfNode.length;
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
    this.size = new Int32Array(n).fill(1);
    this.mask = Int32Array.from({ length: n }, (_, i) => 1 << fieldOfNode[i]);
    this.history = []; // [ra, rb, maskRa, sizeRa]
  }
  find(x) {
    while (this.parent[x] !== x) x = this.parent[x];
    return x;
  }
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false; // 成环
    if ((this.mask[ra] & this.mask[rb]) !== 0) return false; // 视野冲突
    if (this.size[ra] < this.size[rb]) { const t = ra; ra = rb; rb = t; }
    this.history.push([ra, rb, this.mask[ra], this.size[ra]]);
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    this.mask[ra] |= this.mask[rb];
    return true;
  }
  checkpoint() { return this.history.length; }
  rollback(cp) {
    while (this.history.length > cp) {
      const [ra, rb, maskRa, sizeRa] = this.history.pop();
      this.parent[rb] = rb;
      this.mask[ra] = maskRa;
      this.size[ra] = sizeRa;
    }
  }
}

/**
 * 第一阶段：在候选边上求 (最多关联数, 该数量下的最小曼哈顿差总和)。
 * 迭代式分支定界；边已按 (w, a, b) 升序。
 */
function bestForest(edges, uf) {
  const m = edges.length;
  const pref = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) pref[i + 1] = pref[i] + edges[i].w;

  // 初始界：按重量升序贪心（仅作下界，最终答案由精确搜索确定）
  let bestCount = -1;
  let bestWeight = Infinity;
  {
    const cp = uf.checkpoint();
    let c = 0; let w = 0;
    for (const e of edges) if (uf.union(e.a, e.b)) { c += 1; w += e.w; }
    bestCount = c; bestWeight = w;
    uf.rollback(cp);
  }

  // 栈帧：{i, sel, w, phase, cp}；phase 0=待展开 1=已探索包含 2=两分支完成
  const stack = [{ i: 0, sel: 0, w: 0, phase: 0, cp: 0 }];
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    if (f.phase === 0) {
      if (f.i === m) {
        if (f.sel > bestCount || (f.sel === bestCount && f.w < bestWeight)) {
          bestCount = f.sel; bestWeight = f.w;
        }
        stack.pop();
        continue;
      }
      const remaining = m - f.i;
      if (f.sel + remaining < bestCount) { stack.pop(); continue; }
      if (f.sel + remaining === bestCount) {
        const need = bestCount - f.sel;
        // 重量下界：剩余边升序，最便宜的 need 条即 edges[i..i+need-1]
        if (f.w + pref[f.i + need] - pref[f.i] >= bestWeight) { stack.pop(); continue; }
      }
      f.phase = 1;
      f.cp = uf.checkpoint();
      const e = edges[f.i];
      if (uf.union(e.a, e.b)) {
        stack.push({ i: f.i + 1, sel: f.sel + 1, w: f.w + e.w, phase: 0, cp: 0 });
        continue;
      }
      f.phase = 2; // 包含不可行，仅探索排除分支
      stack.push({ i: f.i + 1, sel: f.sel, w: f.w, phase: 0, cp: 0 });
      continue;
    }
    if (f.phase === 1) {
      uf.rollback(f.cp);
      f.phase = 2;
      stack.push({ i: f.i + 1, sel: f.sel, w: f.w, phase: 0, cp: 0 });
      continue;
    }
    stack.pop();
  }
  return { count: bestCount, weight: bestWeight };
}

/** 在 avail（全局边下标，保持重量升序）中精确选出 needCount 条、总重恰为 needWeight 的可行森林是否存在。 */
function dfsExact(edges, avail, uf, needCount, needWeight) {
  const m = avail.length;
  const pref = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) pref[i + 1] = pref[i] + edges[avail[i]].w;

  let found = false;
  const stack = [{ j: 0, picked: 0, w: 0, phase: 0, cp: 0 }];
  while (stack.length > 0 && !found) {
    const f = stack[stack.length - 1];
    if (f.phase === 0) {
      const need = needCount - f.picked;
      if (need === 0) {
        if (f.w === needWeight) found = true;
        stack.pop();
        continue;
      }
      const remaining = m - f.j;
      if (need > remaining) { stack.pop(); continue; }
      const lo = f.w + pref[f.j + need] - pref[f.j]; // 最便宜 need 条
      const hi = f.w + pref[m] - pref[m - need];     // 最贵 need 条
      if (needWeight < lo || needWeight > hi) { stack.pop(); continue; }
      f.phase = 1;
      f.cp = uf.checkpoint();
      const e = edges[avail[f.j]];
      if (uf.union(e.a, e.b)) {
        stack.push({ j: f.j + 1, picked: f.picked + 1, w: f.w + e.w, phase: 0, cp: 0 });
        continue;
      }
      f.phase = 2;
      stack.push({ j: f.j + 1, picked: f.picked, w: f.w, phase: 0, cp: 0 });
      continue;
    }
    if (f.phase === 1) {
      uf.rollback(f.cp);
      f.phase = 2;
      stack.push({ j: f.j + 1, picked: f.picked, w: f.w, phase: 0, cp: 0 });
      continue;
    }
    stack.pop();
  }
  return found;
}

/** 判定：在强制包含 inSet、强制排除 outSet 下，是否存在达到 (targetCount, targetWeight) 的可行森林。 */
function existsOptimalForest(edges, uf, inSet, outSet, targetCount, targetWeight) {
  const cp0 = uf.checkpoint();
  let inCount = 0;
  let inWeight = 0;
  let ok = true;
  for (const idx of inSet) {
    const e = edges[idx];
    if (!uf.union(e.a, e.b)) { ok = false; break; }
    inCount += 1; inWeight += e.w;
  }
  if (!ok || inCount > targetCount || inWeight > targetWeight) {
    uf.rollback(cp0);
    return false;
  }
  const avail = [];
  for (let i = 0; i < edges.length; i += 1) {
    if (!inSet.has(i) && !outSet.has(i)) avail.push(i);
  }
  const found = dfsExact(edges, avail, uf, targetCount - inCount, targetWeight - inWeight);
  uf.rollback(cp0);
  return found;
}

/**
 * 第二阶段：在达到 (targetCount, targetWeight) 的全部森林中，构造
 * “按视野录入顺序展开的伙伴编号序列”字典序最小者。
 *
 * 逐观测（全局顺序）确定其伙伴编号升序列表：能终止则终止（前缀更短更小），
 * 否则取可行的最小编号作为下一个伙伴；已确定的约束通过强制包含/排除传播。
 */
function lexMinForest(observations, compUids, edges, uf, targetCount, targetWeight) {
  const adj = new Map(); // 局部下标 → [{idx, partnerId}]（按伙伴编号升序）
  for (let idx = 0; idx < edges.length; idx += 1) {
    const e = edges[idx];
    for (const [self, other] of [[e.a, e.b], [e.b, e.a]]) {
      if (!adj.has(self)) adj.set(self, []);
      adj.get(self).push({ idx, partnerId: observations[compUids[other]].id });
    }
  }
  for (const list of adj.values()) list.sort((x, y) => compareId(x.partnerId, y.partnerId));

  const inSet = new Set();
  const outSet = new Set();
  const feasible = () => existsOptimalForest(edges, uf, inSet, outSet, targetCount, targetWeight);

  for (let local = 0; local < compUids.length; local += 1) {
    const all = adj.get(local) || [];
    let rem = all.filter((c) => !inSet.has(c.idx) && !outSet.has(c.idx)); // 未决伙伴（升序）
    const fixed = all.filter((c) => inSet.has(c.idx)).map((c) => c.partnerId).sort(compareId);
    if (rem.length === 0) continue;
    let fi = 0; // 下一个待放置的固定伙伴下标

    for (;;) {
      if (fi >= fixed.length) {
        // 尝试终止该观测的伙伴列表：排除全部未决边
        const added = [];
        for (const c of rem) if (!outSet.has(c.idx)) { outSet.add(c.idx); added.push(c.idx); }
        if (feasible()) break;
        for (const idx of added) outSet.delete(idx);
      }
      const f = fi < fixed.length ? fixed[fi] : null;
      let placed = false;
      for (const c of rem) {
        if (f !== null && compareId(c.partnerId, f) >= 0) break; // 只尝试比固定伙伴更小的编号
        const added = [];
        for (const d of rem) {
          if (compareId(d.partnerId, c.partnerId) < 0 && !outSet.has(d.idx)) {
            outSet.add(d.idx); added.push(d.idx);
          }
        }
        inSet.add(c.idx);
        if (feasible()) {
          rem = rem.filter((d) => compareId(d.partnerId, c.partnerId) > 0);
          placed = true;
          break;
        }
        inSet.delete(c.idx);
        for (const idx of added) outSet.delete(idx);
      }
      if (placed) continue;
      if (f === null) throw new Error('字典序构造失败：约束不一致');
      // 放置固定伙伴 f：排除所有编号 < f 的未决边
      const added = [];
      for (const d of rem) {
        if (compareId(d.partnerId, f) < 0 && !outSet.has(d.idx)) { outSet.add(d.idx); added.push(d.idx); }
      }
      if (feasible()) {
        fi += 1;
        rem = rem.filter((d) => compareId(d.partnerId, f) > 0);
        continue;
      }
      for (const idx of added) outSet.delete(idx);
      throw new Error('字典序构造失败：约束不一致');
    }
  }
  return inSet;
}

const round2 = (v) => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r; // 避免 -0
};

/**
 * 求解去重裁决。
 * @param {{tolerance:number, fields:Array}} input 已通过校验并归一化的输入
 * @returns 裁决结果（最终颗粒、观测归属、代表坐标、类别、所选关联、总数）
 */
export function solveDeduplication(input) {
  const { tolerance, fields } = input;

  // 展开观测：全局顺序 = 视野录入顺序 → 视野内录入顺序
  const observations = [];
  fields.forEach((field, fieldIndex) => {
    field.particles.forEach((p, particleIndex) => {
      observations.push({
        uid: observations.length,
        fieldIndex,
        particleIndex,
        id: p.id,
        category: p.category,
        localX: p.x,
        localY: p.y,
        filterX: field.offset.x + p.x,
        filterY: field.offset.y + p.y,
      });
    });
  });
  const n = observations.length;

  // 候选关联：不同视野、类别相同、滤膜坐标横纵差均 ≤ 容差
  const edges = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = observations[i];
      const b = observations[j];
      if (a.fieldIndex === b.fieldIndex) continue;
      if (a.category !== b.category) continue;
      const dx = Math.abs(a.filterX - b.filterX);
      const dy = Math.abs(a.filterY - b.filterY);
      if (dx <= tolerance && dy <= tolerance) edges.push({ a: i, b: j, w: dx + dy });
    }
  }
  if (edges.length > SOLVER_LIMITS.maxCandidateLinks) {
    throw new SolverLimitError(`候选关联数量 ${edges.length} 超出求解上限 ${SOLVER_LIMITS.maxCandidateLinks}，请缩小容差或拆分批次`);
  }

  // 按候选图连通分量分解，逐分量独立精确求解
  const decomp = new PlainUnionFind(n);
  for (const e of edges) decomp.union(e.a, e.b);
  const edgeGroups = new Map(); // root → 全局边下标数组
  edges.forEach((e, idx) => {
    const r = decomp.find(e.a);
    if (!edgeGroups.has(r)) edgeGroups.set(r, []);
    edgeGroups.get(r).push(idx);
  });
  const components = [...edgeGroups.values()].map((edgeIdx) => {
    const nodeSet = new Set();
    for (const gi of edgeIdx) { nodeSet.add(edges[gi].a); nodeSet.add(edges[gi].b); }
    return { edgeIdx, nodes: [...nodeSet].sort((x, y) => x - y) };
  }).sort((c1, c2) => c1.nodes[0] - c2.nodes[0]);

  const chosenGlobal = new Set();
  for (const comp of components) {
    if (comp.nodes.length > SOLVER_LIMITS.maxComponentNodes) {
      throw new SolverLimitError(`单个重叠区域的观测数 ${comp.nodes.length} 超出求解上限 ${SOLVER_LIMITS.maxComponentNodes}`);
    }
    if (comp.edgeIdx.length > SOLVER_LIMITS.maxComponentEdges) {
      throw new SolverLimitError(`单个重叠区域的候选关联数 ${comp.edgeIdx.length} 超出求解上限 ${SOLVER_LIMITS.maxComponentEdges}`);
    }
    const localOf = new Map();
    comp.nodes.forEach((u, i) => localOf.set(u, i));
    const localEdges = comp.edgeIdx.map((gi) => ({
      g: gi, a: localOf.get(edges[gi].a), b: localOf.get(edges[gi].b), w: edges[gi].w,
    }));
    localEdges.sort((x, y) => x.w - y.w || x.a - y.a || x.b - y.b);
    const uf = new RollbackUnionFind(comp.nodes.map((u) => observations[u].fieldIndex));
    const { count, weight } = bestForest(localEdges, uf);
    const inSet = lexMinForest(observations, comp.nodes, localEdges, uf, count, weight);
    for (const li of inSet) chosenGlobal.add(localEdges[li].g);
  }

  // 由所选关联汇总最终颗粒
  const finalUf = new PlainUnionFind(n);
  const chosen = [...chosenGlobal].map((gi) => edges[gi]);
  for (const e of chosen) finalUf.union(e.a, e.b);
  const groups = new Map(); // root → 观测 uid 数组（升序）
  for (let u = 0; u < n; u += 1) {
    const r = finalUf.find(u);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(u);
  }
  const linksByRoot = new Map();
  for (const e of chosen) {
    const r = finalUf.find(e.a);
    if (!linksByRoot.has(r)) linksByRoot.set(r, []);
    linksByRoot.get(r).push(e);
  }

  const particles = [...groups.entries()].map(([root, members]) => {
    const obs = members.map((u) => observations[u]);
    const rx = round2(obs.reduce((s, o) => s + o.filterX, 0) / obs.length);
    const ry = round2(obs.reduce((s, o) => s + o.filterY, 0) / obs.length);
    const links = (linksByRoot.get(root) || [])
      .map((e) => ({
        a: observations[e.a].id,
        b: observations[e.b].id,
        manhattan: e.w,
      }))
      .sort((x, y) => compareId(x.a, y.a) || compareId(x.b, y.b));
    return {
      minUid: members[0],
      category: obs[0].category,
      representative: { x: rx, y: ry },
      observations: obs.map((o) => ({
        fieldIndex: o.fieldIndex,
        fieldName: fields[o.fieldIndex].name,
        particleId: o.id,
        localX: o.localX,
        localY: o.localY,
        filterX: o.filterX,
        filterY: o.filterY,
      })),
      links,
    };
  });
  particles.sort((p1, p2) => p1.minUid - p2.minUid);
  particles.forEach((p, i) => { p.id = i + 1; delete p.minUid; });

  return {
    tolerance,
    fieldCount: fields.length,
    observationCount: n,
    linkCount: chosen.length,
    totalParticles: particles.length,
    particles,
  };
}
