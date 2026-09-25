(function () {
  'use strict';

  var STORAGE_KEY = 'microplastic-dedup-draft-v1';
  var MIN_FIELDS = 3;
  var MAX_FIELDS = 5;

  function newParticle() {
    return { id: '', x: '', y: '', category: '', retestCost: '' };
  }
  function newField(name) {
    return { name: name || '', offsetX: '0', offsetY: '0', particles: [newParticle()] };
  }
  function defaultState() {
    return { tolerance: '5', radius: '5', fields: [newField('F1'), newField('F2'), newField('F3')] };
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.fields) || s.fields.length === 0) return null;
      // 兼容旧版草稿：补齐复测半径与每候选复测代价字段
      if (s.radius === undefined) s.radius = '';
      s.fields.forEach(function (f) {
        if (f.offsetX === undefined) f.offsetX = '0';
        if (f.offsetY === undefined) f.offsetY = '0';
        (f.particles || []).forEach(function (p) {
          if (p.retestCost === undefined) p.retestCost = '';
        });
      });
      return s;
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
  var radiusEl = document.getElementById('radius');
  var addFieldBtn = document.getElementById('btn-add-field');
  var resultPanel = document.getElementById('result-panel');
  var resultSummary = document.getElementById('result-summary');
  var resultParticles = document.getElementById('result-particles');
  var resultJson = document.getElementById('result-json');
  var submitHint = document.getElementById('submit-hint');
  var planRetestsEl = document.getElementById('plan-retests');
  var planUnselectedEl = document.getElementById('plan-unselected');
  var planSummaryEl = document.getElementById('plan-summary');
  var planHintEl = document.getElementById('plan-hint');
  var planJsonEl = document.getElementById('plan-json');
  var planJsonWrap = document.getElementById('plan-json-wrap');
  var planButton = document.getElementById('btn-retest');

  // 去重裁决结果与复测计划均只对应“最后一次成功请求时的草稿”；
  // 草稿的任何修改都立即作废旧计划（与裁决结果一并清除），绝不展示陈旧内容。
  var lastResult = null;
  var lastPlan = null;
  var planRequestId = 0;
  var verdictStale = false;

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
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].retestCost" data-field="' + fi + '" data-particle="' + pi + '" data-key="retestCost" type="number" step="1" min="0" value="' + esc(p.retestCost) + '" placeholder="0" class="cost-input"></td>' +
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
        '<table class="particles"><thead><tr><th>颗粒编号</th><th>X（视野内）</th><th>Y（视野内）</th><th>聚合物类别</th><th>复测代价</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        '<button type="button" class="ghost small" data-action="add-particle" data-field="' + fi + '">＋ 添加颗粒</button>' +
        '</div>';
    }).join('');
    fieldsEl.innerHTML = html;
    addFieldBtn.disabled = state.fields.length >= MAX_FIELDS;
  }

  // 草稿被修改：令在途复测响应失效
  function invalidateDerived() {
    lastPlan = null;
    verdictStale = true;
    planRequestId += 1;
    renderPlan(null);
  }

  // 输入变更：更新状态并保存草稿（不重渲染，避免打断输入）
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t === toleranceEl) {
      state.tolerance = t.value;
      saveDraft();
      invalidateDerived();
      return;
    }
    if (t === radiusEl) {
      state.radius = t.value;
      saveDraft();
      invalidateDerived();
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
    invalidateDerived();
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
    invalidateDerived();
    render();
  });

  addFieldBtn.addEventListener('click', function () {
    if (state.fields.length < MAX_FIELDS) {
      state.fields.push(newField());
      saveDraft();
      invalidateDerived();
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
            { id: 'A1', x: '10', y: '10', category: 'PE', retestCost: '4' },
            { id: 'A2', x: '40', y: '40', category: 'PP', retestCost: '2' },
            { id: 'A3', x: '90', y: '10', category: 'PE', retestCost: '5' },
          ],
        },
        {
          name: 'F2', offsetX: '100', offsetY: '0',
          particles: [
            { id: 'B1', x: '-8', y: '12', category: 'PE', retestCost: '3' },
            { id: 'B2', x: '-6', y: '9', category: 'PE', retestCost: '6' },
          ],
        },
        {
          name: 'F3', offsetX: '0', offsetY: '100',
          particles: [
            { id: 'C1', x: '40', y: '-58', category: 'PP', retestCost: '3' },
            { id: 'C2', x: '5', y: '5', category: 'PET', retestCost: '1' },
            { id: 'C3', x: '90', y: '-90', category: 'PET', retestCost: '1' },
          ],
        },
      ],
    };
    saveDraft();
    clearIssues();
    hideResult();
    render();
    submitHint.textContent = '已载入示例，可先发起去重裁决，再发起异类近邻复测计划。';
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
    lastResult = null;
    lastPlan = null;
    verdictStale = false;
    planRequestId += 1;
    renderPlan(null);
  }

  function obsChip(o) {
    return esc(o.fieldName) + ' / ' + esc(o.particleId) +
      '（' + esc(o.category) + '，滤膜 (' + o.filterX + ', ' + o.filterY + ')' +
      '，最终颗粒 #' + o.finalParticleId + '）';
  }

  function renderPlan(plan) {
    planSummaryEl.innerHTML = '';
    planRetestsEl.innerHTML = '';
    planUnselectedEl.innerHTML = '';
    planJsonEl.textContent = '';
    planJsonWrap.hidden = true;
    if (!plan) {
      planHintEl.textContent = !lastResult
        ? ''
        : verdictStale
          ? '草稿在裁决后已修改，旧计划已作废；请重新发起去重裁决后再发起复测计划。'
          : '裁决已完成，可发起异类近邻复测计划。';
      planButton.disabled = !lastResult || verdictStale;
      return;
    }
    planButton.disabled = false;

    if (plan.pairCount === 0) {
      planSummaryEl.innerHTML =
        '<span class="plan-ok">本次没有需排除的异类近邻：</span>' +
        '在复测半径 ' + plan.radius + ' 内不存在“不同视野、类别不同且横纵差均不超过半径”的观测对。';
      planHintEl.textContent = '';
      return;
    }

    planSummaryEl.innerHTML =
      '异类近邻对 <span class="ok">' + plan.pairCount + '</span> 对，' +
      '参与观测 ' + plan.participantCount + ' 个；' +
      '需复测 <span class="ok">' + plan.selectedCount + '</span> 项，' +
      '最小复测总代价 <span class="ok">' + plan.totalRetestCost + '</span>（复测半径 ' + plan.radius + '）。';

    planRetestsEl.innerHTML = plan.retests.map(function (r) {
      var evidence = r.coveredPairs.map(function (ev) {
        return '<li>' + obsChip(ev.observation) +
          '<span class="dx-badge">横差 ' + ev.dx + ' / 纵差 ' + ev.dy + '</span></li>';
      }).join('');
      return '<div class="retest-card">' +
        '<header><span class="pid">复测 #' + r.sequence + '</span>' +
        '<span class="badge">' + obsChip(r.observation) + '</span>' +
        '<span>复测代价：<strong>' + r.retestCost + '</strong></span></header>' +
        '<div class="evidence-title">覆盖的异类近邻证据（' + r.coveredPairs.length + ' 对）：</div>' +
        '<ul class="evidence-list">' + evidence + '</ul>' +
        '</div>';
    }).join('');

    if (plan.unselectedObservations.length > 0) {
      planUnselectedEl.innerHTML =
        '<div class="unselected-title">参与近邻对但本次无需复测的观测（' +
        plan.unselectedObservations.length + ' 个，其近邻证据已由复测项覆盖）：</div>' +
        '<div class="unselected-list">' +
        plan.unselectedObservations.map(function (o) {
          return '<span class="unselected-chip">' + obsChip(o) + '（代价 ' + o.retestCost + '）</span>';
        }).join('') + '</div>';
    }
    planHintEl.textContent = '';
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
    lastResult = result;
    verdictStale = false;
    lastPlan = null;
    renderPlan(null);
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 数值转换：空串 → null、非数字 → 原样字符串，交由服务端给出可定位反馈
  function num(v) {
    var s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    var n = Number(s);
    return Number.isNaN(n) ? s : n;
  }

  // 同一草稿：两个接口共用这份录入（复测接口额外携带 radius 与每候选 retestCost）
  function buildPayload(withRetest) {
    return {
      tolerance: num(state.tolerance),
      radius: withRetest ? num(state.radius) : undefined,
      fields: state.fields.map(function (f, fi) {
        var field = {
          name: String(f.name || '').trim() || ('F' + (fi + 1)),
          offset: { x: num(f.offsetX), y: num(f.offsetY) },
          particles: f.particles.map(function (p) {
            var particle = {
              id: String(p.id == null ? '' : p.id),
              x: num(p.x),
              y: num(p.y),
              category: String(p.category == null ? '' : p.category),
            };
            if (withRetest) particle.retestCost = num(p.retestCost);
            return particle;
          }),
        };
        return field;
      }),
    };
  }

  document.getElementById('btn-submit').addEventListener('click', function () {
    clearIssues();
    hideResult();
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

  planButton.addEventListener('click', function () {
    if (!lastResult || verdictStale) return;
    clearIssues();
    var myRequest = ++planRequestId;
    // 请求开始即清空旧计划：失败、输入变化或新请求都不得保留旧内容
    lastPlan = null;
    renderPlan(null);
    planButton.disabled = true;
    planHintEl.textContent = '复测计划求解中…';

    fetch('/api/particle-retest-plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(true)),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        if (myRequest !== planRequestId) return; // 已被更新的请求或草稿修改取代
        if (!r.res.ok) {
          var err = (r.body && r.body.error) || {};
          var issues = Array.isArray(err.issues) && err.issues.length > 0
            ? err.issues
            : [{ path: '', message: err.message || ('请求失败（HTTP ' + r.res.status + '）') }];
          showIssues(issues, err.message);
          planHintEl.textContent = '复测计划请求失败，旧计划已清除（草稿已保留）。';
          planButton.disabled = false;
          return;
        }
        lastPlan = r.body.plan;
        renderPlan(lastPlan);
        planJsonEl.textContent = JSON.stringify(r.body, null, 2);
        planJsonWrap.hidden = false;
      })
      .catch(function () {
        if (myRequest !== planRequestId) return;
        showIssues([{ path: '', message: '网络或服务器错误，复测计划未生成（草稿已保留，旧计划已清除）' }]);
        planHintEl.textContent = '复测计划请求失败，旧计划已清除。';
        planButton.disabled = false;
      });
  });

  // 草稿被取代（重新裁决 / 清空 / 载入示例）时 hideResult 已清空计划区。

  render();
  renderPlan(null);
})();
