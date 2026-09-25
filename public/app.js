(function () {
  'use strict';

  var STORAGE_KEY = 'microplastic-dedup-draft-v1';
  var MIN_FIELDS = 3;
  var MAX_FIELDS = 5;

  function newParticle() {
    return { id: '', x: '', y: '', category: '' };
  }
  function newField(name) {
    return { name: name || '', offsetX: '0', offsetY: '0', particles: [newParticle()] };
  }
  function defaultState() {
    return { tolerance: '5', fields: [newField('F1'), newField('F2'), newField('F3')] };
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.fields) || s.fields.length === 0) return null;
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
  var addFieldBtn = document.getElementById('btn-add-field');
  var resultPanel = document.getElementById('result-panel');
  var resultSummary = document.getElementById('result-summary');
  var resultParticles = document.getElementById('result-particles');
  var resultJson = document.getElementById('result-json');
  var submitHint = document.getElementById('submit-hint');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    toleranceEl.value = state.tolerance;
    var html = state.fields.map(function (f, fi) {
      var rows = f.particles.map(function (p, pi) {
        return '<tr>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].id" data-field="' + fi + '" data-particle="' + pi + '" data-key="id" value="' + esc(p.id) + '" placeholder="如 A1"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].x" data-field="' + fi + '" data-particle="' + pi + '" data-key="x" type="number" step="1" value="' + esc(p.x) + '"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].y" data-field="' + fi + '" data-particle="' + pi + '" data-key="y" type="number" step="1" value="' + esc(p.y) + '"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].category" data-field="' + fi + '" data-particle="' + pi + '" data-key="category" list="categories" value="' + esc(p.category) + '" placeholder="PE / PP / …"></td>' +
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
        '<table class="particles"><thead><tr><th>颗粒编号</th><th>X（视野内）</th><th>Y（视野内）</th><th>聚合物类别</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        '<button type="button" class="ghost small" data-action="add-particle" data-field="' + fi + '">＋ 添加颗粒</button>' +
        '</div>';
    }).join('');
    fieldsEl.innerHTML = html;
    addFieldBtn.disabled = state.fields.length >= MAX_FIELDS;
  }

  // 输入变更：更新状态并保存草稿（不重渲染，避免打断输入）
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t === toleranceEl) {
      state.tolerance = t.value;
      saveDraft();
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
      fields: [
        {
          name: 'F1', offsetX: '0', offsetY: '0',
          particles: [
            { id: 'A1', x: '10', y: '10', category: 'PE' },
            { id: 'A2', x: '40', y: '40', category: 'PP' },
            { id: 'A3', x: '90', y: '10', category: 'PE' },
          ],
        },
        {
          name: 'F2', offsetX: '100', offsetY: '0',
          particles: [
            { id: 'B1', x: '-8', y: '12', category: 'PE' },
            { id: 'B2', x: '-6', y: '9', category: 'PE' },
          ],
        },
        {
          name: 'F3', offsetX: '0', offsetY: '100',
          particles: [
            { id: 'C1', x: '40', y: '-58', category: 'PP' },
            { id: 'C2', x: '5', y: '5', category: 'PET' },
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

  // 数值转换：空串 → null、非数字 → 原样字符串，交由服务端给出可定位反馈
  function num(v) {
    var s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    var n = Number(s);
    return Number.isNaN(n) ? s : n;
  }

  document.getElementById('btn-submit').addEventListener('click', function () {
    clearIssues();
    hideResult();
    var payload = {
      tolerance: num(state.tolerance),
      fields: state.fields.map(function (f, fi) {
        return {
          name: String(f.name || '').trim() || ('F' + (fi + 1)),
          offset: { x: num(f.offsetX), y: num(f.offsetY) },
          particles: f.particles.map(function (p) {
            return { id: String(p.id == null ? '' : p.id), x: num(p.x), y: num(p.y), category: String(p.category == null ? '' : p.category) };
          }),
        };
      }),
    };

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

  render();
})();
