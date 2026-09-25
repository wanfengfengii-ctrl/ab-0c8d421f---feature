'use strict';

/**
 * 异类近邻复测计划求解器（精确全局最优，非贪心）。
 *
 * 背景：去重裁决只合并“不同视野、同类别、滤膜坐标足够近”的观测；但相邻视野重叠带内
 * 若两个 *聚合物类别不同* 的候选距离过近，它们可能本是同一颗粒的误分类，不能直接当作
 * 可靠区分。分析员为每个颗粒候选录入非负整数复测代价与统一复测半径，服务端：
 *
 *  1. 先按既有校验与去重规则重算当前最终颗粒；
 *  2. 以滤膜坐标找出“不同视野、类别不同、横向差与纵向差均 ≤ 半径”的近邻对；
 *  3. 每一对都必须由其任一端进入复测计划覆盖 —— 即在“参与观测”诱导的图上求带权顶点覆盖；
 *  4. 目标依次为：最小化复测总代价 → 最小化复测数量 →
 *     按“视野录入顺序 → 颗粒录入顺序”的被选序号序列字典序决胜，得到唯一清单。
 *
 * 精确算法（带权顶点覆盖）：
 *   字典序权重 (代价, 1) 编码为标量 代价·(n+1) + 1，最小化标量即等价于先压代价再压数量。
 *   核心归约为 Nemhauser–Trotter：把图复制为二分图后用最小割求带权顶点覆盖，
 *   其半整数解把顶点分为必选（值 1）/ 必不选（值 0）/ 待定（值 1/2）三类，
 *   且必选、必不选与某个最优解一致，可安全剥离；待定残图再做连通分量分解与
 *   顶点二选一分支（选 v，或弃 v 则邻居必选），诱导子图最小值记忆化。
 * 规模过大时抛出 SolverLimitError，由路由转换为 422 明确拒绝。
 */

import { SolverLimitError, expandObservations } from './dedup.js';

export const RETEST_LIMITS = Object.freeze({
  maxParticipantNodes: 100,   // 参与近邻对的观测上限（精确裁决规模）
  maxNeighborPairs: 5000,     // 异类近邻对总数上限
  maxSearchNodes: 500_000,    // 分支访问节点预算（兜底保护）
});

const INFINITY_SCALAR = Number.POSITIVE_INFINITY;

function bitNumber(bit) {
  let n = 0;
  let b = bit;
  while (b > 1n) { b >>= 1n; n += 1; }
  return n;
}
function popCount(big) {
  let n = 0;
  while (big !== 0n) { big &= big - 1n; n += 1; }
  return n;
}
const listBits = function* (big) {
  let b = big;
  while (b !== 0n) { const bit = b & -b; yield bitNumber(bit); b ^= bit; }
};

/** Dinic 最大流（容量为非负整数标量）。 */
class Dinic {
  constructor(nodeCount) {
    this.n = nodeCount;
    this.g = Array.from({ length: nodeCount }, () => []);
  }
  addEdge(u, v, cap) {
    this.g[u].push({ to: v, rev: this.g[v].length, cap });
    this.g[v].push({ to: u, rev: this.g[u].length - 1, cap: 0 });
  }
  maxFlow(s, t) {
    let flow = 0;
    const level = new Int32Array(this.n);
    const iter = new Int32Array(this.n);
    const bfs = () => {
      level.fill(-1);
      level[s] = 0;
      const queue = [s];
      for (let qi = 0; qi < queue.length; qi += 1) {
        const u = queue[qi];
        for (const e of this.g[u]) {
          if (e.cap > 0 && level[e.to] < 0) { level[e.to] = level[u] + 1; queue.push(e.to); }
        }
      }
      return level[t] >= 0;
    };
    const dfs = (u, pushed) => {
      if (u === t) return pushed;
      for (let i = iter[u]; i < this.g[u].length; i += 1) {
        iter[u] = i;
        const e = this.g[u][i];
        if (e.cap > 0 && level[e.to] === level[u] + 1) {
          const d = dfs(e.to, Math.min(pushed, e.cap));
          if (d > 0) {
            e.cap -= d;
            this.g[e.to][e.rev].cap += d;
            return d;
          }
        }
      }
      return 0;
    };
    while (bfs()) {
      iter.fill(0);
      for (;;) {
        const f = dfs(s, INFINITY_SCALAR);
        if (f === 0) break;
        flow += f;
      }
    }
    return flow;
  }
  /** 最大流后残量网络中从 s 可达的顶点集合（位掩码）。 */
  reachable(s) {
    const seen = new Uint8Array(this.n);
    seen[s] = 1;
    const queue = [s];
    for (let qi = 0; qi < queue.length; qi += 1) {
      const u = queue[qi];
      for (const e of this.g[u]) {
        if (e.cap > 0 && !seen[e.to]) { seen[e.to] = 1; queue.push(e.to); }
      }
    }
    return seen;
  }
}

/**
 * 带权顶点覆盖精确求解器。
 * 顶点标量权重 = 复测代价 × base + 1（base = n+1），标量大小即字典序 (代价, 数量)。
 */
class WeightedCoverSolver {
  constructor(adjMask, costs) {
    this.n = costs.length;
    this.adj = adjMask;                    // BigInt[n]：邻接位掩码
    this.base = this.n + 1;                // 字典序编码基数（大于任何可行覆盖的数量）
    this.weight = Int32Array.from(costs, (c) => c * this.base + 1);
    this.totalWeight = [...this.weight].reduce((a, b) => a + b, 0);
    this.memo = new Map();                 // 诱导子图掩码 → 最小标量权重
    this.visited = 0;
  }

  tick() {
    this.visited += 1;
    if (this.visited > RETEST_LIMITS.maxSearchNodes) {
      throw new SolverLimitError('异类近邻复测计划的精确求解超过搜索规模上限，请缩小复测半径或拆分批次');
    }
  }

  components(mask) {
    const parts = [];
    let rest = mask;
    while (rest !== 0n) {
      let comp = 0n;
      let frontier = rest & -rest;
      while (frontier !== 0n) {
        comp |= frontier;
        let next = 0n;
        for (const u of listBits(frontier)) next |= this.adj[u] & mask & ~comp;
        frontier = next;
      }
      parts.push(comp);
      rest &= ~comp;
    }
    return parts;
  }

  scalarOf(mask) {
    let sum = 0;
    for (const u of listBits(mask)) sum += this.weight[u];
    return sum;
  }

  /**
   * Nemhauser–Trotter 归约（最小割实现）。
   * 对残图构造二分双覆图：左副本 L_i、右副本 R_i，边 (L_u,R_v)、(L_v,R_u) 容量无穷；
   * s→L_i、R_i→t 容量为顶点权重。最小割即二分图最小带权顶点覆盖，对应原图 LP 松弛的
   * 半整数最优解：
   *   L_i 在割的源侧 ⇔ 左副本不取（0）；R_i 在汇侧 ⇔ 右副本不取（0）。
   *   两侧都取（L 汇侧且 R 源侧）→ x_i=1：存在最优覆盖必选该点；
   *   两侧都不取（L 源侧且 R 汇侧）→ x_i=0：存在最优覆盖必不选该点；
   *   其余 → x_i=1/2：进入待定残图。
   * @returns {{pick:bigint, drop:bigint, half:bigint, fixedWeight:number, lpWeight:number}}
   */
  nemhauserTrotter(mask) {
    const verts = [...listBits(mask)];
    const k = verts.length;
    const compact = new Map();
    verts.forEach((u, i) => compact.set(u, i));
    const s = 2 * k;
    const t = s + 1;
    const dinic = new Dinic(2 * k + 2);
    const INF = this.totalWeight + 1; // 大于全部顶点权重之和，保证割不切约束边

    for (let i = 0; i < k; i += 1) {
      dinic.addEdge(s, i, this.weight[verts[i]]);       // s → L_i
      dinic.addEdge(k + i, t, this.weight[verts[i]]);   // R_i → t
    }
    const added = new Set();
    for (const u of verts) {
      for (const v of listBits(this.adj[u] & mask)) {
        if (v <= u) continue;
        const cu = compact.get(u);
        const cv = compact.get(v);
        const key = cu * k + cv;
        if (added.has(key)) continue;
        added.add(key);
        dinic.addEdge(cu, k + cv, INF); // L_u → R_v
        dinic.addEdge(cv, k + cu, INF); // L_v → R_u
      }
    }
    const lpWeight = dinic.maxFlow(s, t);
    const reachable = dinic.reachable(s);

    let pick = 0n;
    let drop = 0n;
    let half = 0n;
    for (let i = 0; i < k; i += 1) {
      const leftInSource = reachable[i];       // L_i 源侧 → 左副本 0
      const rightInSource = reachable[k + i];  // R_i 源侧 → 右副本 1
      const bit = 1n << BigInt(verts[i]);
      if (!leftInSource && rightInSource) pick |= bit;  // (1,1)
      else if (leftInSource && !rightInSource) drop |= bit; // (0,0)
      else half |= bit;                                       // (1/2)
    }
    return { pick, drop, half, fixedWeight: this.scalarOf(pick), lpWeight };
  }

  /** 贪心可行上界：反复选“权重 / 未覆盖边数”最划算（并列编号最小）的顶点。 */
  greedyScalar(mask) {
    let m = mask;
    let total = 0;
    for (;;) {
      let pick = -1;
      let pickScore = Infinity;
      for (const u of listBits(m)) {
        const deg = popCount(this.adj[u] & m);
        if (deg > 0) {
          const score = this.weight[u] / deg;
          if (score < pickScore || (score === pickScore && (pick === -1 || u < pick))) {
            pick = u; pickScore = score;
          }
        }
      }
      if (pick === -1) return total;
      total += this.weight[pick];
      m ^= 1n << BigInt(pick);
    }
  }

  /** 选择分支顶点：残图中度数最大者；并列取标量权重最大、再并列取编号最小。 */
  branchVertex(m) {
    let branch = -1;
    let bestDeg = -1;
    let bestW = -1;
    for (const u of listBits(m)) {
      const deg = popCount(this.adj[u] & m);
      const w = this.weight[u];
      if (deg > bestDeg
        || (deg === bestDeg && w > bestW)
        || (deg === bestDeg && w === bestW && (branch === -1 || u < branch))) {
        bestDeg = deg; bestW = w; branch = u;
      }
    }
    return branch;
  }

  /**
   * 诱导子图 maskIn 的最小标量覆盖权重（精确值，记忆化）。
   * 记忆以“归约后的残图掩码”为键：不同外层掩码若归约到同一残图，子问题值相同，
   * 故缓存残图最小值，返回时再加上本次剥离的必选权重 fixed。
   */
  minimum(maskIn) {
    if (maskIn === 0n) return 0;
    const cachedIn = this.memo.get(maskIn);
    if (cachedIn !== undefined) return cachedIn;

    // Nemhauser–Trotter 闭包归约：反复剥离必选 / 必不选顶点。
    // 割值 = Σ_必选 2w + Σ_待定 w，即原问题 LP 最优值的 2 倍；
    // 原问题 LP 值 = 必选权重和 + 待定权重和 / 2。
    let mask = maskIn;
    let fixed = 0;
    let halfWeight = 0;
    for (;;) {
      const nt = this.nemhauserTrotter(mask);
      fixed += nt.fixedWeight;
      halfWeight = this.scalarOf(nt.half);
      if (nt.half === mask) { mask = nt.half; break; } // 没有新归约
      mask = nt.half;
      if (mask === 0n) break;
    }
    if (mask === 0n) {
      this.memo.set(maskIn, fixed);
      return fixed;
    }

    const cached = this.memo.get(mask);
    if (cached !== undefined) {
      const value = fixed + cached;
      this.memo.set(maskIn, value); // 外层掩码同样可直接复用
      return value;
    }
    this.tick();

    // 连通分量可加：最小权重 = 各分量最小权重之和
    const parts = this.components(mask);
    if (parts.length > 1) {
      let sub = 0;
      for (const p of parts) sub += this.minimum(p);
      this.memo.set(mask, sub);
      this.memo.set(maskIn, fixed + sub);
      return fixed + sub;
    }

    // LP 下界（翻倍为整数比较）：2·残图最优 ≥ 待定权重和；与贪心上界相等即已最优
    const greedy = this.greedyScalar(mask);
    if (halfWeight >= 2 * greedy) {
      this.memo.set(mask, greedy);
      this.memo.set(maskIn, fixed + greedy);
      return fixed + greedy;
    }

    // 二选一分支：选 v；或弃 v（则其全部邻居必选）
    const branch = this.branchVertex(mask);
    const vBit = 1n << BigInt(branch);
    const neigh = this.adj[branch] & mask;
    const wTake = this.weight[branch];
    const wSkip = this.scalarOf(neigh);

    let bestSub = greedy;
    if (wTake <= wSkip) {
      const take = wTake + this.minimum(mask ^ vBit);
      if (take < bestSub) bestSub = take;
      const skip = wSkip + this.minimum(mask ^ vBit ^ neigh);
      if (skip < bestSub) bestSub = skip;
    } else {
      const skip = wSkip + this.minimum(mask ^ vBit ^ neigh);
      if (skip < bestSub) bestSub = skip;
      const take = wTake + this.minimum(mask ^ vBit);
      if (take < bestSub) bestSub = take;
    }
    this.memo.set(mask, bestSub);
    const best = fixed + bestSub;
    this.memo.set(maskIn, best);
    return best;
  }

  /**
   * 强制选入 forcedIn、强制排除 forcedOut 下的最小标量权重；不可行返回 Infinity。
   * 禁止点之间有边则该近邻对无人覆盖；禁止点的其余邻居必须选入。
   */
  constrainedMinimum(forcedIn, forcedOut) {
    if ((forcedIn & forcedOut) !== 0n) return INFINITY_SCALAR;
    for (const u of listBits(forcedOut)) {
      if ((this.adj[u] & forcedOut) !== 0n) return INFINITY_SCALAR;
    }
    let required = forcedIn;
    for (const u of listBits(forcedOut)) required |= this.adj[u] & ~forcedOut;
    if ((required & forcedOut) !== 0n) return INFINITY_SCALAR;
    const all = (1n << BigInt(this.n)) - 1n;
    const residual = all & ~required & ~forcedOut;
    return this.scalarOf(required) + this.minimum(residual);
  }

  /** 标量权重解码为 {cost, count}（count ≤ n < base，余数唯一）。 */
  decode(scalar) {
    return { cost: Math.floor(scalar / this.base), count: scalar % this.base };
  }
}

function observationDescriptor(o, fields) {
  return {
    fieldIndex: o.fieldIndex,
    fieldName: fields[o.fieldIndex].name,
    particleId: o.id,
    category: o.category,
    localX: o.localX,
    localY: o.localY,
    filterX: o.filterX,
    filterY: o.filterY,
  };
}

/**
 * 依据已重算的去重裁决结果与录入的代价 / 半径，构造异类近邻复测计划。
 * @param {{radius:number, fields:Array}} input 已通过复测校验并归一化（颗粒含 retestCost）
 * @param {object} dedupResult solveDeduplication 的结果（服务端按当前草稿重算）
 * @returns 复测计划（被选复测项、近邻证据、对应最终颗粒、未选参与观测）
 */
export function buildRetestPlan(input, dedupResult) {
  const { radius, fields } = input;
  const { observations } = expandObservations(input);

  // 观测编号 → 最终颗粒编号（异类观测必属不同最终颗粒，证据两端颗粒编号必不同）
  const particleIdOfObs = new Map();
  for (const p of dedupResult.particles) {
    for (const o of p.observations) particleIdOfObs.set(o.particleId, p.id);
  }

  // 异类近邻对：不同视野、类别不同、滤膜坐标横纵差均 ≤ 统一复测半径
  const pairs = [];
  const total = observations.length;
  for (let i = 0; i < total; i += 1) {
    for (let j = i + 1; j < total; j += 1) {
      const a = observations[i];
      const b = observations[j];
      if (a.fieldIndex === b.fieldIndex) continue;
      if (a.category === b.category) continue;
      const dx = Math.abs(a.filterX - b.filterX);
      const dy = Math.abs(a.filterY - b.filterY);
      if (dx <= radius && dy <= radius) pairs.push({ a: i, b: j, dx, dy });
    }
  }

  if (pairs.length > RETEST_LIMITS.maxNeighborPairs) {
    throw new SolverLimitError(
      `异类近邻对数量 ${pairs.length} 超出精确求解上限 ${RETEST_LIMITS.maxNeighborPairs}，请缩小复测半径或拆分批次`,
    );
  }

  // 参与观测（至少出现在一对中），按全局录入顺序（uid 递增）排列作为决胜序号
  const participantUids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))].sort((x, y) => x - y);
  if (participantUids.length > RETEST_LIMITS.maxParticipantNodes) {
    throw new SolverLimitError(
      `参与异类近邻对的观测数 ${participantUids.length} 超出精确裁决规模 ${RETEST_LIMITS.maxParticipantNodes}，请缩小复测半径或拆分批次`,
    );
  }

  if (pairs.length === 0) {
    return {
      radius,
      pairCount: 0,
      participantCount: 0,
      selectedCount: 0,
      totalRetestCost: 0,
      retests: [],
      unselectedObservations: [],
    };
  }

  const n = participantUids.length;
  const localOf = new Map();
  participantUids.forEach((u, i) => localOf.set(u, i));
  const costs = Int32Array.from({ length: n }, (_, i) => {
    const o = observations[participantUids[i]];
    return fields[o.fieldIndex].particles[o.particleIndex].retestCost;
  });

  // 近邻对转局部下标，建位掩码邻接表与证据表
  const endpoints = pairs.map((p) => ({
    a: localOf.get(p.a),
    b: localOf.get(p.b),
    dx: p.dx,
    dy: p.dy,
  }));
  const adjMask = new Array(n).fill(0n);
  const adjEdges = Array.from({ length: n }, () => []);
  endpoints.forEach((p, e) => {
    adjMask[p.a] |= 1n << BigInt(p.b);
    adjMask[p.b] |= 1n << BigInt(p.a);
    adjEdges[p.a].push({ v: p.b, e });
    adjEdges[p.b].push({ v: p.a, e });
  });
  for (const list of adjEdges) list.sort((x, y) => x.v - y.v);

  // 阶段一：无约束最小标量权重
  const solver = new WeightedCoverSolver(adjMask, costs);
  const allMask = (1n << BigInt(n)) - 1n;
  const optimumScalar = solver.minimum(allMask);
  const optimum = solver.decode(optimumScalar);

  // 阶段二：逐观测（全局录入顺序）尝试选入 —— 更前位置被选使被选序号序列字典序更小；
  // 约束最小值仍等于最优，则存在“选 i”的最优方案，固定选入；否则固定排除。
  let forcedIn = 0n;
  let forcedOut = 0n;
  for (let i = 0; i < n; i += 1) {
    const bit = 1n << BigInt(i);
    if (solver.constrainedMinimum(forcedIn | bit, forcedOut) === optimumScalar) {
      forcedIn |= bit;
    } else {
      forcedOut |= bit;
    }
  }

  const selectedLocals = [...listBits(forcedIn)];

  const describeLocal = (local) => {
    const o = observations[participantUids[local]];
    return {
      ...observationDescriptor(o, fields),
      finalParticleId: particleIdOfObs.get(o.id),
    };
  };

  const retests = selectedLocals.map((local, idx) => {
    const o = observations[participantUids[local]];
    const coveredPairs = adjEdges[local]
      .map(({ v, e }) => ({ local: v, pair: endpoints[e] }))
      .sort((x, y) => x.local - y.local)
      .map(({ local: v, pair }) => ({
        observation: describeLocal(v),
        dx: pair.dx,
        dy: pair.dy,
      }));
    return {
      sequence: idx + 1,
      retestCost: costs[local],
      observation: {
        ...observationDescriptor(o, fields),
        finalParticleId: particleIdOfObs.get(o.id),
      },
      coveredPairs,
    };
  });

  const unselectedObservations = [];
  for (let local = 0; local < n; local += 1) {
    if ((forcedIn & (1n << BigInt(local))) !== 0n) continue;
    const o = observations[participantUids[local]];
    unselectedObservations.push({
      retestCost: costs[local],
      ...observationDescriptor(o, fields),
      finalParticleId: particleIdOfObs.get(o.id),
    });
  }

  return {
    radius,
    pairCount: pairs.length,
    participantCount: n,
    selectedCount: selectedLocals.length,
    totalRetestCost: optimum.cost,
    retests,
    unselectedObservations,
  };
}
