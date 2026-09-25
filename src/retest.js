import { solveDeduplication, expandObservations, SolverLimitError } from './dedup.js';

export { SolverLimitError };

export class RetestLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetestLimitError';
  }
}

export const RETEST_LIMITS = Object.freeze({
  maxInvolvedObservations: 200, // 参与近邻对的观测上限（精确裁决规模）
  maxNeighborPairs: 5000,       // 近邻证据对数上限
  maxSearchNodes: 2000000,      // 单次计划全部精确搜索的分支节点预算
  maxSearchMs: 5000,            // 单次计划精确搜索的墙钟时间预算（毫秒）
});

/**
 * 找出异类近邻观测对。
 * 条件：不同视野、类别不同、滤膜坐标横向差与纵向差均 ≤ 半径。
 * @returns {{a:number, b:number, dx:number, dy:number}[]} 全局观测下标对（a < b）
 */
export function findNeighborPairs(observations, radius) {
  const pairs = [];
  const n = observations.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = observations[i];
      const b = observations[j];
      if (a.fieldIndex === b.fieldIndex) continue;
      if (a.category === b.category) continue;
      const dx = Math.abs(a.filterX - b.filterX);
      const dy = Math.abs(a.filterY - b.filterY);
      if (dx <= radius && dy <= radius) pairs.push({ a: i, b: j, dx, dy });
    }
  }
  return pairs;
}

/**
 * 分支定界搜索最小权顶点覆盖 / 带上下界的覆盖可行性判定。
 *
 * st[v]：0 未决 / 1 选取 / 2 排除。所有变更写日志，离开节点时回滚到节点入口。
 *
 * @param {number} k 顶点数
 * @param {Array<{a:number,b:number}>} edges 局部下标边
 * @param {number[][]} adj 邻接表（邻点下标）
 * @param {number[]} costs 每点复测代价
 * @param {Set<number>} forcedIn 强制选取
 * @param {Set<number>} forcedOut 强制排除
 * @param {{cost:number,count:number}|null} caps 非空时做可行性判定（≤ caps）；
 *        为空时求 (最小代价, 最少数量) 并记录最优状态
 * @returns 可行性模式返回 boolean；最优模式返回 {cost, count, state}
 */
function vertexCoverSearch(k, edges, adj, costs, forcedIn, forcedOut, caps, tick) {
  const st = new Uint8Array(k);
  let curCost = 0;
  let curCount = 0;
  const log = []; // [v, oldSt]
  const setSt = (v, s) => { log.push([v, st[v]]); st[v] = s; };
  const pick = (v) => { setSt(v, 1); curCost += costs[v]; curCount += 1; };

  for (const v of forcedIn) {
    if (st[v] === 2) return caps ? false : null;
    if (st[v] === 0) pick(v);
  }
  for (const v of forcedOut) {
    if (st[v] === 1) return caps ? false : null;
    if (st[v] === 0) setSt(v, 2);
  }

  const capCost = caps ? caps.cost : Infinity;
  const capCount = caps ? caps.count : Infinity;

  // 最优模式的初始可行上界：全部选取
  let bestCost = caps ? Infinity : costs.reduce((s, c) => s + c, 0);
  let bestCount = caps ? Infinity : k;
  let bestSt = caps ? null : st.slice();

  function dfs() {
    if (tick) tick();
    const cp = log.length;
    const savedCost = curCost;
    const savedCount = curCount;
    const rollback = () => {
      while (log.length > cp) {
        const [v, old] = log.pop();
        st[v] = old;
      }
      curCost = savedCost;
      curCount = savedCount;
    };

    // ── 归约：一端排除 → 另一端必须选取；孤立未决点直接排除 ──
    let changed = true;
    let feasible = true;
    while (changed && feasible) {
      changed = false;
      for (const e of edges) {
        const sa = st[e.a];
        const sb = st[e.b];
        if (sa === 1 || sb === 1) continue; // 已覆盖
        if (sa === 2 && sb === 2) { feasible = false; break; }
        if (sa === 2 && sb === 0) { pick(e.b); changed = true; continue; }
        if (sb === 2 && sa === 0) { pick(e.a); changed = true; continue; }
      }
      if (!feasible) break;
      for (let v = 0; v < k; v += 1) {
        if (st[v] !== 0) continue;
        let isolated = true;
        for (const w of adj[v]) {
          if (st[v] !== 1 && st[w] !== 1) { isolated = false; break; }
        }
        if (isolated) { setSt(v, 2); changed = true; }
      }
    }
    if (!feasible) { rollback(); return false; }

    // 剩余（未覆盖）边：两端均未选取（归约后必均为未决）
    const rem = [];
    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i];
      if (st[e.a] !== 1 && st[e.b] !== 1) rem.push(i);
    }
    if (rem.length === 0) {
      if (caps) {
        const ok = curCost <= capCost && curCount <= capCount;
        rollback();
        return ok;
      }
      if (curCost < bestCost || (curCost === bestCost && curCount < bestCount)) {
        bestCost = curCost;
        bestCount = curCount;
        bestSt = st.slice();
      }
      rollback();
      return false;
    }

    // ── 下界：贪心匹配（每条匹配边需要互不相同的被选端点）──
    // 仅在剩余边构成的子图上取匹配，所有剩余边的两端均为未决点
    const remAdj = Array.from({ length: k }, () => []);
    for (const ei of rem) {
      remAdj[edges[ei].a].push(edges[ei].b);
      remAdj[edges[ei].b].push(edges[ei].a);
    }
    const deg = Int32Array.from(remAdj, (ns) => ns.length);
    const removed = new Uint8Array(k);
    let lbCount = 0;
    let lbCost = 0;
    for (;;) {
      let v = -1;
      for (let i = 0; i < k; i += 1) {
        if (!removed[i] && deg[i] > 0 && (v < 0 || deg[i] > deg[v])) v = i;
      }
      if (v < 0) break;
      let w = -1;
      for (const cand of remAdj[v]) {
        if (!removed[cand]) { w = cand; break; }
      }
      if (w < 0) { deg[v] = 0; continue; }
      removed[v] = 1;
      removed[w] = 1;
      lbCount += 1;
      lbCost += Math.min(costs[v], costs[w]);
      for (const u of remAdj[v]) if (!removed[u]) deg[u] -= 1;
      for (const u of remAdj[w]) if (!removed[u]) deg[u] -= 1;
    }

    if (caps) {
      if (curCost + lbCost > capCost || curCount + lbCount > capCount) {
        rollback();
        return false;
      }
    } else if (curCost + lbCost > bestCost
      || (curCost + lbCost === bestCost && curCount + lbCount >= bestCount)) {
      rollback();
      return false;
    }

    // ── 分支：剩余度数最大的未决点 v：选取 v / 排除 v（邻点由归约强制选取）──
    let v = -1;
    for (const ei of rem) {
      for (const cand of [edges[ei].a, edges[ei].b]) {
        if (st[cand] !== 0) continue;
        if (v < 0 || deg[cand] > deg[v]) v = cand;
      }
    }

    pick(v);
    if (dfs()) { rollback(); return true; } // 可行性模式：已找到，提前结束
    // 撤回选取改为排除：选取发生在本节点（回滚点之后），需手动恢复计数
    curCost -= costs[v];
    curCount -= 1;
    setSt(v, 2); // 邻点由下一帧归约强制选取
    if (dfs()) { rollback(); return true; }

    rollback();
    return false;
  }

  const found = dfs();
  if (caps) return found;
  return { cost: bestCost, count: bestCount, state: bestSt };
}

/**
 * 在参与观测构成的图上求字典序最小的最小权顶点覆盖。
 *
 * @param {number[]} members 参与观测的全局下标（按全局顺序升序）
 * @param {{a:number,b:number}[]} globalEdges 全局下标边
 * @param {number[]} costOf 全局下标 → 复测代价
 * @returns {{chosen:number[], cost:number, count:number}} 全局下标形式的被选集合
 */
function minimumWeightVertexCover(members, globalEdges, costOf) {
  const k = members.length;
  if (k === 0) return { chosen: [], cost: 0, count: 0 };

  const localOf = new Map();
  members.forEach((u, i) => localOf.set(u, i));
  const edges = globalEdges.map((e) => ({ a: localOf.get(e.a), b: localOf.get(e.b) }));
  const adj = Array.from({ length: k }, () => []);
  for (const e of edges) { adj[e.a].push(e.b); adj[e.b].push(e.a); }
  const costs = members.map((u) => costOf[u]);

  // 第一阶段：精确求 (最小总代价, 最少复测数量)
  let searchedNodes = 0;
  const deadline = Date.now() + RETEST_LIMITS.maxSearchMs;
  const tick = () => {
    searchedNodes += 1;
    if ((searchedNodes & 1023) !== 0) return;
    if (searchedNodes > RETEST_LIMITS.maxSearchNodes || Date.now() > deadline) {
      throw new RetestLimitError(
        '异类近邻图过于复杂，精确复测裁决未能在规定计算预算内收敛，请缩小复测半径或拆分批次',
      );
    }
  };
  const optimum = vertexCoverSearch(k, edges, adj, costs, new Set(), new Set(), null, tick);

  // 第二阶段：构造“被选序号序列”（升序）字典序最小者，公共前缀较短者更小。
  // 逐位贪心：当前前缀若已构成最优覆盖即终止；否则在保持前缀可行的前提下，
  // 取最小的下一个被选序号 v（区间 (last, v) 内的未决点全部强制排除）。
  const inSet = new Set();
  const outSet = new Set();
  const coversAll = (chosen) => edges.every((e) => chosen.has(e.a) || chosen.has(e.b));
  let last = -1;
  while (!coversAll(inSet)) {
    let placed = false;
    for (let v = last + 1; v < k; v += 1) {
      if (inSet.has(v)) continue;
      const trialIn = new Set(inSet);
      const trialOut = new Set(outSet);
      for (let u = last + 1; u < v; u += 1) if (!trialIn.has(u)) trialOut.add(u);
      trialIn.add(v);
      if (vertexCoverSearch(
        k, edges, adj, costs, trialIn, trialOut,
        { cost: optimum.cost, count: optimum.count }, tick,
      )) {
        inSet.add(v);
        for (let u = last + 1; u < v; u += 1) outSet.add(u);
        last = v;
        placed = true;
        break;
      }
    }
    if (!placed) throw new Error('复测计划字典序构造失败：约束不一致');
  }

  const chosen = [...inSet].sort((a, b) => a - b).map((v) => members[v]);
  return { chosen, cost: optimum.cost, count: optimum.count };
}

/**
 * 生成异类近邻复测计划。
 *
 * @param {{tolerance:number, fields:Array}} input 已通过校验并归一化的去重草稿
 * @param {number} radius 统一复测半径（非负整数）
 * @param {number[]} retestCosts 按观测全局顺序展开的复测代价（非负整数）
 */
export function planNeighborRetest(input, radius, retestCosts) {
  // 1) 先按既有校验（调用方负责）与去重规则重算当前最终颗粒
  const dedup = solveDeduplication(input);

  const observations = expandObservations(input);
  const uidByParticleId = new Map(observations.map((o) => [o.id, o.uid]));
  const particleOfUid = new Map(); // 观测全局下标 → 最终颗粒编号
  dedup.particles.forEach((particle) => {
    particle.observations.forEach((o) => {
      particleOfUid.set(uidByParticleId.get(o.particleId), particle.id);
    });
  });

  // 2) 以滤膜坐标找出异类近邻观测对
  const pairs = findNeighborPairs(observations, radius);
  const involvedSet = new Set();
  for (const p of pairs) { involvedSet.add(p.a); involvedSet.add(p.b); }

  // 3) 规模保护：参与观测超过精确裁决规模时明确拒绝
  if (involvedSet.size > RETEST_LIMITS.maxInvolvedObservations) {
    throw new RetestLimitError(
      `参与近邻对的观测数 ${involvedSet.size} 超出精确裁决规模 ${RETEST_LIMITS.maxInvolvedObservations}，请缩小复测半径或拆分批次`,
    );
  }
  if (pairs.length > RETEST_LIMITS.maxNeighborPairs) {
    throw new RetestLimitError(
      `异类近邻证据对数量 ${pairs.length} 超出精确裁决上限 ${RETEST_LIMITS.maxNeighborPairs}，请缩小复测半径或拆分批次`,
    );
  }

  // 4) 联合选择复测集合（最小总代价 → 最少数量 → 被选序号序列字典序）
  const members = [...involvedSet].sort((a, b) => a - b);
  const { chosen, cost, count } = minimumWeightVertexCover(members, pairs, retestCosts);
  const chosenSet = new Set(chosen);

  const obsRef = (u) => ({
    fieldIndex: observations[u].fieldIndex,
    fieldName: input.fields[observations[u].fieldIndex].name,
    particleId: observations[u].id,
    category: observations[u].category,
    filterX: observations[u].filterX,
    filterY: observations[u].filterY,
    particle: particleOfUid.get(u),
    cost: retestCosts[u],
  });

  // 近邻证据（按发现顺序编号），并记录由哪一端覆盖
  const pairRecords = pairs.map((p, i) => {
    const coveredBy = chosenSet.has(p.a) ? observations[p.a].id : observations[p.b].id;
    return {
      key: `E${i + 1}`,
      a: obsRef(p.a),
      b: obsRef(p.b),
      dx: p.dx,
      dy: p.dy,
      manhattan: p.dx + p.dy,
      coveredBy,
    };
  });
  // 每项被选观测返回其覆盖的近邻证据（按证据编号 E1、E2、… 的发现顺序）
  const selected = chosen.map((u, i) => {
    const covers = [];
    pairs.forEach((p, pi) => {
      let other = null;
      if (p.a === u) other = p.b;
      else if (p.b === u) other = p.a;
      if (other === null) return;
      covers.push({
        pairKey: pairRecords[pi].key,
        dx: p.dx,
        dy: p.dy,
        manhattan: p.dx + p.dy,
        other: obsRef(other),
      });
    });
    return { seq: i + 1, ...obsRef(u), covers };
  });

  const unselected = members
    .filter((u) => !chosenSet.has(u))
    .map(obsRef);

  return {
    radius,
    fieldCount: input.fields.length,
    observationCount: observations.length,
    neighborPairCount: pairs.length,
    involvedObservationCount: members.length,
    retestCount: count,
    totalRetestCost: cost,
    selected,
    unselected,
    pairs: pairRecords,
    deduplication: dedup,
  };
}
