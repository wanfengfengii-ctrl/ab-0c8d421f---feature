# 海洋微塑料监测站 · 显微视野拼接去重裁决服务

海洋微塑料监测站在拼接同一滤膜的相邻显微视野计数时，重叠带内的同一颗粒容易被重复计数。
本服务让分析员在网页录入 **3–5 个视野** 的已知平移位置及每个视野中的颗粒候选（唯一编号、整数坐标、聚合物类别、非负整数复测代价），
发起去重裁决后，前端调用真实接口 `POST /api/particle-deduplications`，
展示每个最终颗粒包含的观测、代表坐标、类别以及最终颗粒总数；
随后分析员可在**同一草稿**上以统一复测半径发起异类近邻复测计划
（`POST /api/particle-retest-plans`），对“类别不同却距离过近、不能直接当作可靠区分”的候选，
得到唯一的最小代价复测清单。

项目零第三方运行时依赖（Node.js 标准库），从空仓库交付 `Dockerfile` 与 `docker-compose.yml`，
宿主机端口可配置、应用带健康检查，并含名为 **verify** 的一次性服务：
自动执行构建检查、单元测试与 API 冒烟验收后以退出码结束。

---

## 快速开始（Docker）

```bash
# 启动应用（默认宿主机端口 8080）
docker compose up --build app

# 宿主机端口可配置
APP_PORT=9000 docker compose up --build app

# 一次性验收：构建检查 + 单元测试 + API 冒烟，以退出码结束
docker compose up --build --exit-code-from verify verify
# 或
docker compose run --rm verify
```

启动后访问 `http://localhost:${APP_PORT:-8080}` 使用录入界面。

- 应用容器内端口固定为 `8080`（可用环境变量 `PORT` 覆盖，需同步调整映射）；
- 健康检查：`GET /api/health`（Dockerfile 内置 `HEALTHCHECK`，Compose 继承）；
- `verify` 为一次性服务：构建检查（`node --check`）→ 单元测试（`node --test`）→
  在容器内启动真实服务执行 API 冒烟验收，全部通过以退出码 `0` 结束，否则为 `1`。

## 本地开发（Node.js ≥ 20，无需安装依赖）

```bash
npm start        # 启动服务（PORT 环境变量可改端口，默认 8080）
npm test         # 单元测试 + 随机化暴力对拍
npm run verify   # 一次性验收（构建检查 + 测试 + API 冒烟）
BASE_URL=http://127.0.0.1:8080 npm run smoke   # 对已运行服务做 API 冒烟
```

---

## 裁决规则（形式化）

1. **候选关联**：仅当两条观测来自 *不同视野*、*聚合物类别相同*，且换算到滤膜坐标后
   *横向差与纵向差均不超过容差* 时，二者之间才存在候选关联。
   滤膜坐标 = 视野平移位置 + 视野内坐标。
2. **合法方案**：所选关联构成森林；每个最终颗粒（连通分量）中的观测通过所选关联连通，
   且同一视野至多一个观测。冗余（成环）关联不减少颗粒数、不降低总差，不作为方案的一部分。
3. **三目标全序**（精确全局最优，拒绝“局部最近边贪心合并”）：
   1. 最少化最终颗粒数（等价于最多化所选关联数）；
   2. 最小化所选关联的曼哈顿差总和（曼哈顿差 = 滤膜坐标横向差 + 纵向差）；
   3. 仍相同者，按 **字典序** 确定唯一结论：观测按“视野录入顺序 → 视野内录入顺序”展开，
      每个观测贡献其 *直接关联伙伴编号* 的升序列表（编号按字符串序比较）；
      逐观测比较伙伴列表（列表按字典序、公共前缀较短者更小），首个差异决定胜负。
4. **代表坐标**：最终颗粒全部成员滤膜坐标的质心，四舍五入保留两位小数。
5. **输出顺序**：最终颗粒按其最早观测的全局顺序编号（#1、#2、…）。

### 求解方法

候选图按连通分量分解后逐分量精确求解：第一阶段以迭代式分支定界求
`(最多关联数, 最小总差)`；第二阶段在达到该最优值的全部森林中，
通过“逐观测确定伙伴列表 + 可行性判定（强制包含/排除）”构造字典序最小方案。
正确性由 `test/bruteforce.test.js` 中数百个随机用例与全子集枚举的暴力实现对拍保证。

规模保护（超出返回 `422`）：候选关联总数 ≤ 100000；单个重叠区域观测 ≤ 200、候选关联 ≤ 5000。

---

## 异类近邻复测计划（形式化）

去重裁决只合并“不同视野、同类别、滤膜坐标足够近”的观测；但相邻视野重叠带内若两个
**聚合物类别不同** 的候选距离过近，它们可能本是同一颗粒的误分类，不能直接当作可靠区分。

1. **先重算最终颗粒**：服务端按既有校验与去重规则，对当前草稿重新执行一次完整去重裁决。
2. **异类近邻对**：以滤膜坐标找出 *不同视野、聚合物类别不同* 且
   *横向差与纵向差均 ≤ 统一复测半径* 的观测对（半径为非负整数，与容差独立录入）。
3. **联合复测集合**：每一对都必须由其 **任一端** 进入复测计划覆盖 —— 在“参与近邻对的观测”
   诱导的图上即一个带权顶点覆盖；从全部参与观测中联合选择，不按对贪心。
4. **三目标全序**（精确全局最优，唯一清单）：
   1. 最小化复测总代价（每候选录入 0 ~ 1000000 的非负整数复测代价）；
   2. 最小化复测数量；
   3. 仍相同者，按 **视野录入顺序 → 颗粒录入顺序** 的被选观测序号序列字典序决胜。
5. **规模保护**：参与近邻对的观测 **超过 100 个**（精确裁决规模）或近邻对超过 5000 对时
   明确拒绝（`422`），不返回近似方案。
6. **输出**：每项复测回传它覆盖的全部近邻证据（对端观测、横纵差、所属最终颗粒），
   以及参与近邻对但本次无需复测的未选观测；没有近邻对时返回 **空计划**。

### 求解方法

把字典序权重 (复测代价, 1) 编码为标量 `代价·(n+1) + 1`；以 **Nemhauser–Trotter 归约**
（二分双覆图最小割，半整数解把顶点分为必选 / 必不选 / 待定三类并保持某个最优解不变）
压缩问题规模，再在待定残图上做连通分量分解与顶点二选一分支（选 v，或弃 v 则其全部邻居必选），
诱导子图最小值记忆化；第二阶段逐观测以“强制选入后约束最小值是否仍等于全局最优”构造
字典序最小方案。正确性由 `test/retest-bruteforce.test.js` 中数百个随机用例与
全子集枚举的暴力实现对拍保证。

---

## API 契约

### `POST /api/particle-deduplications`

**请求体**

```json
{
  "tolerance": 5,
  "fields": [
    {
      "name": "F1",
      "offset": { "x": 0, "y": 0 },
      "particles": [
        { "id": "A1", "x": 10, "y": 10, "category": "PE" }
      ]
    }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `tolerance` | 必填，0 ~ 1000000 的整数 |
| `fields` | 必填，3 ~ 5 个视野 |
| `fields[i].name` | 可选，≤ 50 字符，缺省为 `F{i+1}` |
| `fields[i].offset.x/y` | 必填整数，|v| ≤ 1000000 |
| `fields[i].particles` | 必填数组，每视野 ≤ 500、合计 ≤ 2000 |
| `particles[j].id` | 非空字符串（≤ 64 字符），**全部视野内唯一** |
| `particles[j].x/y` | 必填整数，|v| ≤ 1000000 |
| `particles[j].category` | 非空字符串（≤ 50 字符） |

**成功响应 `200`**（节选）

```json
{
  "tolerance": 5,
  "fieldCount": 3,
  "observationCount": 7,
  "linkCount": 2,
  "totalParticles": 5,
  "particles": [
    {
      "id": 2,
      "category": "PP",
      "representative": { "x": 40, "y": 41 },
      "observations": [
        { "fieldIndex": 0, "fieldName": "F1", "particleId": "A2",
          "localX": 40, "localY": 40, "filterX": 40, "filterY": 40 },
        { "fieldIndex": 2, "fieldName": "F3", "particleId": "C1",
          "localX": 40, "localY": -58, "filterX": 40, "filterY": 42 }
      ],
      "links": [{ "a": "A2", "b": "C1", "manhattan": 2 }]
    }
  ]
}
```

**输入不合规 `400`**：返回全部可定位问题，前端据此高亮对应录入项并保留草稿。

```json
{
  "error": {
    "message": "输入不合规，请根据定位信息修正后重新提交（草稿已保留）",
    "issues": [
      { "path": "tolerance", "message": "容差必须是 0 ~ 1000000 的整数" },
      { "path": "fields[1].particles[0].id", "message": "颗粒编号“A1”重复（首次出现于 fields[0].particles[0].id）" },
      { "path": "fields[1].particles[0].x", "message": "颗粒坐标必须是 |v| ≤ 1000000 的整数" }
    ]
  }
}
```

其他状态码：`413` 请求体过大；`422` 超出求解规模上限；`404` 接口/资源不存在。

### `POST /api/particle-retest-plans`

在**同一草稿**上发起异类近邻复测计划。请求体在去重裁决字段之外，额外要求：

| 字段 | 规则 |
| --- | --- |
| `tolerance` | 同去重裁决（服务端会先完整重算最终颗粒） |
| `radius` | 必填，复测半径，0 ~ 1000000 的非负整数（横、纵差均 ≤ 半径才算异类近邻） |
| `particles[j].retestCost` | 必填，0 ~ 1000000 的非负整数复测代价 |

其余字段（`fields`、`offset`、`id`、`x/y`、`category`）的规则与去重裁决完全一致，
同样返回可定位的 `400` issues，草稿在前端保留。

**成功响应 `200`**（节选）

```json
{
  "tolerance": 5,
  "fieldCount": 3,
  "observationCount": 7,
  "deduplicatedParticles": 5,
  "plan": {
    "radius": 3,
    "pairCount": 2,
    "participantCount": 3,
    "selectedCount": 1,
    "totalRetestCost": 1,
    "retests": [
      {
        "sequence": 1,
        "retestCost": 1,
        "observation": {
          "fieldIndex": 2, "fieldName": "F3", "particleId": "C3",
          "category": "PET", "localX": 90, "localY": -90,
          "filterX": 90, "filterY": 10, "finalParticleId": 6
        },
        "coveredPairs": [
          { "observation": { "particleId": "A3", "category": "PE", "finalParticleId": 3, "...": "..." }, "dx": 0, "dy": 0 },
          { "observation": { "particleId": "B1", "category": "PE", "finalParticleId": 3, "...": "..." }, "dx": 2, "dy": 2 }
        ]
      }
    ],
    "unselectedObservations": [
      { "particleId": "A3", "retestCost": 5, "finalParticleId": 3, "...": "..." }
    ]
  }
}
```

- `retests[].observation.finalParticleId` 与 `coveredPairs[].observation.finalParticleId`
  是被复测观测 / 对端观测所属的最终颗粒编号（异类观测必属不同最终颗粒）；
- 没有异类近邻对时 `pairCount=0`，`retests` 与 `unselectedObservations` 均为空数组（**空计划**）；
- 参与观测超过 100 个或近邻对超过 5000 对时返回 `422`，明确拒绝；
- 去重裁决本身超规模时同样返回 `422`（复测前必须先重算）。

### `GET /api/health`

返回 `200 {"status":"ok","service":"particle-deduplication"}`，用于容器健康检查。

---

## 前端使用

- 录入 3–5 个视野（可增删），每个视野填写名称（可选）、平移 X/Y 与颗粒表（编号、X、Y、类别，类别带常用聚合物候选）；
- 每个颗粒候选填写 **复测代价**（非负整数），顶部填写与容差独立的 **异类近邻复测半径**；
- 草稿实时保存在浏览器 `localStorage`，刷新或校验失败均不丢失（旧版草稿会自动补齐新字段）；
- 点击 **发起去重裁决** 调用 `POST /api/particle-deduplications`：
  - 成功：在裁决结果旁展示最终颗粒总数，以及每个颗粒的类别、代表坐标、观测明细（视野 / 编号 / 局部坐标 / 滤膜坐标）与所选关联（含曼哈顿差）；
  - 失败：列出全部可定位问题（`fields[1].particles[0].x` 形式）并高亮对应输入框，草稿保留；
- 裁决完成后点击 **发起异类近邻复测计划** 调用 `POST /api/particle-retest-plans`：
  - 在裁决结果旁并排展示最小复测总代价、复测项及其覆盖的异类近邻证据（对端观测 / 横纵差 / 最终颗粒），
    以及参与近邻对但无需复测的未选观测；没有近邻对时明确提示“本次没有需排除的异类近邻”；
  - **输入一旦修改，旧复测计划立即作废**（结果区同步清空，需重新裁决）；请求失败同样不保留旧计划；
- **载入示例** 可一键填充演示数据。

## 项目结构

```
├── Dockerfile              # 应用镜像（含 HEALTHCHECK，零依赖，非 root 运行）
├── docker-compose.yml      # app（端口可配置）+ verify（一次性验收）
├── package.json            # 无第三方依赖
├── src/
│   ├── server.js           # HTTP 服务：去重 / 复测 API 路由、静态资源、健康检查
│   ├── validation.js      # 输入校验（可定位 issues，复测模式另校验 radius / retestCost）
│   ├── dedup.js            # 去重精确求解器（分支定界 + 字典序构造）
│   └── retest.js           # 异类近邻复测计划（Nemhauser–Trotter 归约 + 分支记忆化）
├── public/                 # 录入与结果展示前端（原生 HTML/JS/CSS）
├── test/
│   ├── dedup.test.js / validation.test.js / api.test.js
│   ├── bruteforce.test.js          # 去重求解器随机暴力对拍
│   ├── retest.test.js              # 复测计划规则用例
│   ├── retest-api.test.js          # 复测接口 / 校验 / 422
│   └── retest-bruteforce.test.js   # 复测求解器随机暴力对拍
└── scripts/
    ├── verify.js           # 一次性验收：构建检查 → 测试 → API 冒烟 → 退出码
    └── smoke.js            # API 冒烟验收（可独立对运行中的服务执行）
```
