(function () {
  'use strict';

  var STORAGE_KEY = 'microplastic-dedup-draft-v1';
  var MIN_FIELDS = 3;
  var MAX_FIELDS = 5;

  function newParticle() {
    return { id: '', x: '', y: '', category: '', retestCost: '0' };
  }
  function newField(name) {
    return { name: name || '', offsetX: '0', offsetY: '0', particles: [newParticle()] };
  }
  function defaultState() {
    return { tolerance: '5', radius: '3', fields: [newField('F1'), newField('F2'), newField('F3')] };
  }

  function normalizeState(s) {
    if (!s) return s;
    if (s.radius === undefined) s.radius = '3';
    (s.fields || []).forEach(function (f) {
      (f.particles || []).forEach(function (p) {
        if (p.retestCost === undefined) p.retestCost = '0';
      });
    });
    return s;
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.fields) || s.fields.length === 0) return null;
      return normalizeState(s);
    } catch (e) {
      return null;
    }
  }

  var state = loadDraft() || defaultState();

  function saveDraft() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* 存储不可用时草稿仍保留在内存中 */ }
  }

  var fieldsEl = document.getElementById('fields');
  var issuesEl = document.getElementById('issues');
  var toleranceEl = document.getElementById('tolerance');
  var radiusEl = document.getElementById('retest-radius');
  var addFieldBtn = document.getElementById('btn-add-field');
  var resultPanel = document.getElementById('result-panel');
  var resultSummary = document.getElementById('result-summary');
  var resultParticles = document.getElementById('result-particles');
  var resultJson = document.getElementById('result-json');
  var submitHint = document.getElementById('submit-hint');
  var btnRetest = document.getElementById('btn-retest');
  var retestHint = document.getElementById('retest-hint');
  var retestPanel = document.getElementById('retest-panel');
  var retestJson = document.getElementById('retest-json');
  var retestJsonWrap = document.getElementById('retest-json-wrap');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    toleranceEl.value = state.tolerance;
    radiusEl.value = state.radius;
    var html = state.fields.map(function (f, fi) {
      var rows = f.particles.map(function (p, pi) {
        return '<tr>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].id" data-field="' + fi + '" data-particle="' + pi + '" data-key="id" value="' + esc(p.id) + '" placeholder="如 A1"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].x" data-field="' + fi + '" data-particle="' + pi + '" data-key="x" type="number" step="1" value="' + esc(p.x) + '"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].y" data-field="' + fi + '" data-particle="' + pi + '" data-key="y" type="number" step="1" value="' + esc(p.y) + '"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].category" data-field="' + fi + '" data-particle="' + pi + '" data-key="category" list="categories" value="' + esc(p.category) + '" placeholder="PE / PP / …"></td>' +
          '<td class="cost-cell"><input data-path="fields[' + fi + '].particles[' + pi + '].retestCost" data-field="' + fi + '" data-particle="' + pi + '" data-key="retestCost" type="number" step="1" min="0" value="' + esc(p.retestCost) + '" title="复测代价（非负整数）"></td>' +
          '<td><button type="button" class="small" data-action="remove-particle" data-field="' + fi + '" data-particle="' + pi + '">删除</button></td>' +
          '</tr>';
      }).join('');
      return '<div class="field-card">' +
        '<div class="field-head">' +
          '<strong>视野 ' + (fi + 1) + '</strong>' +
          '<label>名称<input data-path="fields[' + fi + '].name" data-field="' + fi + '" data-key="name" value="' + esc(f.name) + '" placeholder="F' + (fi + 1) + '"></label>' +
          '<label>平移 X<input data-path="fields[' + fi + '].offset.x" data-field="' + fi + '" data-key="offsetX" type="number" step="1" value="' + esc(f.offsetX) + '"></label>' +
          '<label>平移 Y<input data-path="fields[' + fi + '].offset.y" data-field="' + fi + '" data-key="offsetY" type="number" step="1" value="' + esc(f.offsetY) + '"></label>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="small" data-action="remove-field" data-field="' + fi + '"' + (state.fields.length <= MIN_FIELDS ? ' disabled' : '') + '>删除视野</button>' +
        '</div>' +
        '<table class="particles"><thead><tr><th>颗粒编号</th><th>X（视野内）</th><th>Y（视野内）</th><th>聚合物类别</th><th title="该候选进入复测集合时的代价">复测代价</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        '<button type="button" class="ghost small" data-action="add-particle" data-field="' + fi + '">＋ 添加颗粒</button>' +
        '</div>';
    }).join('');
    fieldsEl.innerHTML = html;
    addFieldBtn.disabled = state.fields.length >= MAX_FIELDS;
  }

  // 输入变更：更新状态并保存草稿（不重渲染，避免打断输入）
  // 草稿一旦修改，旧复测计划即不再可信，必须清除（裁决面板保持原样，下次发起时重算）
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t === toleranceEl) {
      state.tolerance = t.value;
      saveDraft();
      clearRetestPlan();
      return;
    }
    if (t === radiusEl) {
      state.radius = t.value;
      saveDraft();
      clearRetestPlan();
      return;
    }
    if (!t.dataset || t.dataset.field === undefined || !t.dataset.key) return;
    var f = state.fields[Number(t.dataset.field)];
    if (!f) return;
    if (t.dataset.particle !== undefined) {
      var p = f.particles[Number(t.dataset.particle)];
      if (p) p[t.dataset.key] = t.value;
    } else {
      f[t.dataset.key] = t.value;
    }
    saveDraft();
    clearRetestPlan();
  });

  // 增删视野 / 颗粒
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var fi = Number(btn.dataset.field);
    var action = btn.dataset.action;
    if (action === 'add-particle') {
      state.fields[fi].particles.push(newParticle());
    } else if (action === 'remove-particle') {
      state.fields[fi].particles.splice(Number(btn.dataset.particle), 1);
    } else if (action === 'remove-field') {
      if (state.fields.length > MIN_FIELDS) state.fields.splice(fi, 1);
    } else {
      return;
    }
    saveDraft();
    clearRetestPlan();
    render();
  });

  addFieldBtn.addEventListener('click', function () {
    if (state.fields.length < MAX_FIELDS) {
      state.fields.push(newField());
      saveDraft();
      render();
    }
  });

  document.getElementById('btn-clear').addEventListener('click', function () {
    if (!window.confirm('确定清空当前草稿？')) return;
    state = defaultState();
    saveDraft();
    clearIssues();
    hideResult();
    render();
  });

  document.getElementById('btn-sample').addEventListener('click', function () {
    state = {
      tolerance: '5',
      radius: '3',
      fields: [
        {
          name: 'F1', offsetX: '0', offsetY: '0',
          particles: [
            { id: 'A1', x: '10', y: '10', category: 'PE', retestCost: '2' },
            { id: 'A2', x: '40', y: '40', category: 'PP', retestCost: '5' },
            { id: 'A3', x: '90', y: '10', category: 'PE', retestCost: '3' },
          ],
        },
        {
          name: 'F2', offsetX: '100', offsetY: '0',
          particles: [
            { id: 'B1', x: '-8', y: '12', category: 'PE', retestCost: '4' },
            { id: 'B2', x: '-6', y: '9', category: 'PE', retestCost: '1' },
          ],
        },
        {
          name: 'F3', offsetX: '0', offsetY: '100',
          particles: [
            { id: 'C1', x: '40', y: '-58', category: 'PP', retestCost: '6' },
            { id: 'C2', x: '5', y: '5', category: 'PET', retestCost: '2' },
          ],
        },
      ],
    };
    saveDraft();
    clearIssues();
    hideResult();
    render();
    submitHint.textContent = '已载入示例，可直接发起去重裁决。';
  });

  function clearIssues() {
    issuesEl.classList.add('hidden');
    issuesEl.innerHTML = '';
    document.querySelectorAll('input.invalid').forEach(function (el) {
      el.classList.remove('invalid');
    });
  }

  function showIssues(issues, heading) {
    var items = issues.map(function (it) {
      var where = it.path ? '<code>' + esc(it.path) + '</code> ' : '';
      return '<li>' + where + esc(it.message) + '</li>';
    }).join('');
    issuesEl.innerHTML = '<h3>' + esc(heading || '输入不合规，请修正后重新提交（草稿已保留）') + '</h3><ul>' + items + '</ul>';
    issuesEl.classList.remove('hidden');
    var firstInput = null;
    issues.forEach(function (it) {
      if (!it.path) return;
      var el = document.querySelector('[data-path="' + it.path.replace(/"/g, '\\"') + '"]');
      if (el) {
        el.classList.add('invalid');
        if (!firstInput) firstInput = el;
      }
    });
    issuesEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (firstInput) firstInput.focus({ preventScroll: true });
  }

  function hideResult() {
    resultPanel.classList.add('hidden');
  }

  // 仅清除复测计划（半径或复测代价修改时）
  function clearRetestPlan() {
    retestPanel.classList.add('hidden');
    retestPanel.innerHTML = '';
    retestJsonWrap.classList.add('hidden');
    retestJson.textContent = '';
    retestHint.textContent = '';
  }

  // 草稿实质修改后：裁决与复测计划同时失效（当前仅“清空草稿”使用）
  function invalidateResults() {
    clearRetestPlan();
    hideResult();
  }

  function renderResult(result) {
    resultSummary.innerHTML =
      '最终颗粒总数：<span class="ok">' + result.totalParticles + '</span>' +
      '（共 ' + result.observationCount + ' 个观测，选中关联 ' + result.linkCount + ' 条，容差 ' + result.tolerance + '）';

    resultParticles.innerHTML = result.particles.map(function (p) {
      var obsRows = p.observations.map(function (o) {
        return '<tr><td>' + esc(o.fieldName) + '</td><td>' + esc(o.particleId) + '</td>' +
          '<td>(' + o.localX + ', ' + o.localY + ')</td><td>(' + o.filterX + ', ' + o.filterY + ')</td></tr>';
      }).join('');
      var links = p.links.length === 0
        ? '<span class="none">无关联（独立颗粒）</span>'
        : p.links.map(function (l) {
            return '<span class="link-chip">' + esc(l.a) + ' ↔ ' + esc(l.b) + '（曼哈顿差 ' + l.manhattan + '）</span>';
          }).join('');
      return '<div class="particle-card">' +
        '<header><span class="pid">颗粒 #' + p.id + '</span>' +
        '<span class="badge">类别 ' + esc(p.category) + '</span>' +
        '<span>代表坐标：(' + p.representative.x + ', ' + p.representative.y + ')</span>' +
        '<span>观测数：' + p.observations.length + '</span></header>' +
        '<table><thead><tr><th>视野</th><th>颗粒编号</th><th>局部坐标</th><th>滤膜坐标</th></tr></thead>' +
        '<tbody>' + obsRows + '</tbody></table>' +
        '<div class="links">' + links + '</div>' +
        '</div>';
    }).join('');

    resultJson.textContent = JSON.stringify(result, null, 2);
    resultPanel.classList.remove('hidden');
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function obsLabel(o) {
    return esc(o.fieldName) + ' / ' + esc(o.particleId) +
      '（类别 ' + esc(o.category) + '，滤膜 (' + o.filterX + ', ' + o.filterY + ')，最终颗粒 #' + o.particle + '）';
  }

  function renderRetestPlan(plan) {
    if (plan.neighborPairCount === 0) {
      retestPanel.innerHTML =
        '<div class="retest-empty">本次没有需排除的异类近邻：半径 ' + plan.radius +
        ' 内不存在跨视野且聚合物类别不同的观测对，无需复测。</div>';
      retestPanel.classList.remove('hidden');
      return;
    }

    var selectedRows = plan.selected.map(function (s) {
      var evidence = s.covers.map(function (c) {
        return '<li><code>' + esc(c.pairKey) + '</code> 与 ' + obsLabel(c.other) +
          '（横差 ' + c.dx + '、纵差 ' + c.dy + '，曼哈顿差 ' + c.manhattan + '）</li>';
      }).join('');
      return '<div class="retest-item">' +
        '<header><span class="pid">复测 #' + s.seq + '</span> ' + obsLabel(s) +
        '<span class="badge">代价 ' + s.cost + '</span>' +
        '<span>覆盖近邻证据 ' + s.covers.length + ' 条</span></header>' +
        '<ul class="evidence">' + evidence + '</ul>' +
        '</div>';
    }).join('');

    var unselectedRows = plan.unselected.length === 0
      ? '<span class="none">无（参与近邻对的观测全部入选）</span>'
      : plan.unselected.map(function (u) {
          return '<span class="link-chip">' + obsLabel(u) + '（代价 ' + u.cost + '）</span>';
        }).join('');

    var pairRows = plan.pairs.map(function (pr) {
      return '<tr><td><code>' + esc(pr.key) + '</code></td>' +
        '<td>' + obsLabel(pr.a) + '</td>' +
        '<td>' + obsLabel(pr.b) + '</td>' +
        '<td>' + pr.dx + ' / ' + pr.dy + '</td>' +
        '<td>' + esc(pr.coveredBy) + '</td></tr>';
    }).join('');

    retestPanel.innerHTML =
      '<div class="retest-summary">近邻证据 ' + plan.neighborPairCount + ' 对、参与观测 ' +
        plan.involvedObservationCount + ' 个；复测集合 <span class="ok">' + plan.retestCount +
        '</span> 项，最小总代价 <span class="ok">' + plan.totalRetestCost + '</span>' +
        '（统一半径 ' + plan.radius + '）。</div>' +
      '<h4>复测清单（每项含其覆盖的近邻证据与对应最终颗粒）</h4>' +
      selectedRows +
      '<h4>未选观测（参与近邻对但不在复测集合中）</h4>' +
      '<div class="links">' + unselectedRows + '</div>' +
      '<details class="pair-details"><summary>全部近邻证据（' + plan.neighborPairCount + ' 对）</summary>' +
      '<table class="pair-table"><thead><tr><th>证据</th><th>观测 A</th><th>观测 B</th><th>横差 / 纵差</th><th>覆盖端</th></tr></thead>' +
      '<tbody>' + pairRows + '</tbody></table></details>';
    retestPanel.classList.remove('hidden');
  }

  // 数值转换：空串 → null、非数字 → 原样字符串，交由服务端给出可定位反馈
  function num(v) {
    var s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    var n = Number(s);
    return Number.isNaN(n) ? s : n;
  }

  function buildPayload(includeRetest) {
    return {
      tolerance: num(state.tolerance),
      fields: state.fields.map(function (f, fi) {
        return {
          name: String(f.name || '').trim() || ('F' + (fi + 1)),
          offset: { x: num(f.offsetX), y: num(f.offsetY) },
          particles: f.particles.map(function (p) {
            var row = {
              id: String(p.id == null ? '' : p.id),
              x: num(p.x),
              y: num(p.y),
              category: String(p.category == null ? '' : p.category),
            };
            if (includeRetest) row.retestCost = num(p.retestCost == null ? '0' : p.retestCost);
            return row;
          }),
        };
      }),
    };
  }

  document.getElementById('btn-submit').addEventListener('click', function () {
    clearIssues();
    hideResult();
    clearRetestPlan();
    var payload = buildPayload(false);

    submitHint.textContent = '裁决中…';
    fetch('/api/particle-deduplications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        if (!r.res.ok) {
          var err = (r.body && r.body.error) || {};
          var issues = Array.isArray(err.issues) && err.issues.length > 0
            ? err.issues
            : [{ path: '', message: err.message || ('请求失败（HTTP ' + r.res.status + '）') }];
          showIssues(issues, err.message);
          submitHint.textContent = '';
          return;
        }
        submitHint.textContent = '裁决完成。';
        renderResult(r.body);
      })
      .catch(function () {
        showIssues([{ path: '', message: '网络或服务器错误，请稍后重试（草稿已保留）' }]);
        submitHint.textContent = '';
      });
  });

  btnRetest.addEventListener('click', function () {
    // 服务端会基于同一草稿重算最终颗粒；发起前先清除旧计划，失败也不保留旧计划
    clearRetestPlan();
    clearIssues();
    var payload = buildPayload(true);
    payload.radius = num(state.radius);

    retestHint.textContent = '复测计划计算中…';
    fetch('/api/neighbor-retest-plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        if (!r.res.ok) {
          var err = (r.body && r.body.error) || {};
          var issues = Array.isArray(err.issues) && err.issues.length > 0
            ? err.issues
            : [{ path: '', message: err.message || ('请求失败（HTTP ' + r.res.status + '）') }];
          showIssues(issues, err.message);
          retestHint.textContent = '';
          return;
        }
        retestHint.textContent = '复测计划已按唯一最小代价清单生成。';
        renderRetestPlan(r.body);
        retestJson.textContent = JSON.stringify(r.body, null, 2);
        retestJsonWrap.classList.remove('hidden');
      })
      .catch(function () {
        showIssues([{ path: '', message: '网络或服务器错误，复测计划未生成（草稿已保留）' }]);
        retestHint.textContent = '';
      });
  });

  render();
})();
