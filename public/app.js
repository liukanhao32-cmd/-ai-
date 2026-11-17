(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);

  const els = {
    members: $('#members'),
    spend: $('#spend'),
    bar: $('#bar'),
    budgetText: $('#budgetText'),
    memberCount: $('#memberCount'),
    messages: $('#messages'),
    scroll: $('#scroll'),
    empty: $('#empty'),
    input: $('#input'),
    send: $('#btn-send'),
    hint: $('#hint'),
    title: $('#chatTitle'),
    popup: $('#mentionPopup'),
    fwd: $('#fwdMenu'),
    modal: $('#modal'),
    modalTitle: $('#modalTitle'),
    modalBody: $('#modalBody'),
    toast: $('#toast'),
    fullCtx: $('#fullContext'),
  };

  const state = {
    models: [],
    settings: { monthlyBudgetCNY: 100 },
    usage: { total: 0, byModel: {} },
    messages: [],
    contexts: {},
    title: '新对话',
  };

  const refs = new Map();
  let seq = 0;
  const uid = () => 'm' + (++seq) + '-' + Math.random().toString(36).slice(2, 7);

  /* ---------------- 工具 ---------------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMarkdown(text) {
    let s = escapeHtml(text);
    s = s.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_, code) =>
      '<pre class="code"><code>' + code.replace(/\n$/, '') + '</code></pre>');
    s = s.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/\n*(<pre class="code">)/g, '$1').replace(/(<\/pre>)\n*/g, '$1');
    return s;
  }

  function money(n) {
    const v = Number(n) || 0;
    if (v === 0) return '¥0';
    return '¥' + (v >= 1 ? v.toFixed(2) : v.toFixed(4));
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  /* ---------------- 持久化（存到服务端 data/sessions/） ---------------- */

  let saveTimer = null;

  function newSessionId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }

  async function saveNow() {
    if (!state.sessionId) return;
    const payload = {
      title: state.title,
      messages: state.messages.filter((m) => !m.streaming),
      contexts: state.contexts,
    };
    try {
      await fetch('/api/sessions/' + state.sessionId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (_) { /* 保存失败下次再试 */ }
  }

  async function openSession(id) {
    const r = await fetch('/api/sessions/' + id);
    if (!r.ok) return false;
    const d = await r.json();
    state.sessionId = id;
    state.messages = (d.messages || []).map((m) => ({ ...m, streaming: false }));
    state.contexts = d.contexts || {};
    state.title = d.title || '新对话';
    renderAllMessages();
    return true;
  }

  function newSession() {
    state.sessionId = newSessionId();
    state.messages = [];
    state.contexts = {};
    state.title = '新对话';
    renderAllMessages();
    scheduleSave();
  }

  function fmtTime(ts) {    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === now.toDateString()) return hm;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  const LEGACY_KEY = 'multi-ai-chat/v1';

  // 旧版本把对话存在浏览器里，这里一次性搬到服务端，避免之前的记录丢失
  function readLegacy() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.messages) || !d.messages.length) return null;
      return d;
    } catch (_) {
      return null;
    }
  }

  /* ---------------- 渲染：侧栏 ---------------- */

  function renderBudget() {
    const total = Number(state.usage.total) || 0;
    const budget = Number(state.settings.monthlyBudgetCNY) || 0;
    const pct = budget > 0 ? Math.min(100, (total / budget) * 100) : 0;
    els.spend.textContent = '¥' + total.toFixed(total >= 1 ? 2 : 4);
    els.bar.style.width = pct + '%';
    els.bar.className = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
    els.budgetText.textContent = `预算 ¥${budget}`;
  }

  function renderMembers() {
    els.members.innerHTML = '';
    els.memberCount.textContent = state.models.length ? `${state.models.length} 个` : '';
    state.models.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'member';
      li.title = '点击查看 / 清空它的上下文';
      li.innerHTML = `
        <span class="dot ${m.hasKey ? '' : 'off'}" style="${m.hasKey ? 'background:' + m.color : ''}"></span>
        <span class="member-main">
          <span class="member-name">${escapeHtml(m.name)}</span>
          <span class="member-sub">${escapeHtml(m.model || '')}</span>
        </span>
        ${m.hasKey ? '' : '<span class="nokey">未填密钥</span>'}`;
      li.addEventListener('click', () => openContext(m));
      els.members.appendChild(li);
    });
    if (!state.models.length) {
      els.members.innerHTML = '<li class="tiny" style="padding:8px">还没有配置模型，去 config/models.json 加一个。</li>';
    }
  }

  /* ---------------- 渲染：消息 ---------------- */

  function nearBottom() {
    const el = els.scroll;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }

  function scrollToBottom(force) {
    if (force || nearBottom()) els.scroll.scrollTop = els.scroll.scrollHeight;
  }

  function refreshMessage(m) {
    const ref = refs.get(m.id);
    if (!ref) return;
    if (m.error) {
      ref.bubble.innerHTML = renderMarkdown(m.error);
      ref.wrap.classList.add('err');
    } else {
      ref.bubble.innerHTML = renderMarkdown(m.text) +
        (m.streaming ? '<span class="cursor"></span>' : '');
    }
    if (ref.cost) {
      ref.cost.textContent = m.streaming ? '生成中…' : (m.cost != null ? money(m.cost) : '');
    }
    if (ref.actions) ref.actions.style.display = m.streaming ? 'none' : '';
  }

  function addMessageEl(m) {
    refs.delete(m.id);
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
    wrap.dataset.id = m.id;

    const av = document.createElement('div');
    av.className = 'avatar';
    if (m.role === 'user') {
      av.textContent = '我';
    } else {
      av.style.background = m.color || '#4f7cff';
      av.textContent = (m.name || 'AI').slice(0, 1);
    }
    wrap.appendChild(av);

    const bw = document.createElement('div');
    bw.className = 'bubble-wrap';

    const meta = document.createElement('div');
    meta.className = 'meta';
    let costEl = null;
    if (m.role === 'user') {
      if (m.forward) meta.innerHTML = '<span class="tag">转发</span>';
    } else {
      meta.innerHTML = `<span class="name">${escapeHtml(m.name || '')}</span>` +
        (m.model ? `<span class="tag">${escapeHtml(m.model)}</span>` : '') +
        '<span class="cost"></span>';
      costEl = meta.querySelector('.cost');
    }
    if (meta.innerHTML) bw.appendChild(meta);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bw.appendChild(bubble);

    let actions = null;
    if (m.role !== 'user') {
      actions = document.createElement('div');
      actions.className = 'actions';
      actions.innerHTML = '<button data-act="forward">转发</button><button data-act="copy">复制</button>';
      bw.appendChild(actions);
    }

    wrap.appendChild(bw);
    els.messages.appendChild(wrap);
    refs.set(m.id, { wrap, bubble, cost: costEl, actions });

    if (actions) {
      actions.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.act === 'forward') openForwardMenu(m, btn);
        if (btn.dataset.act === 'copy') {
          navigator.clipboard.writeText(m.text || '').then(() => toast('已复制')).catch(() => toast('复制失败'));
        }
      });
    }

    refreshMessage(m);
    return wrap;
  }

  function addMessage(m) {
    state.messages.push(m);
    addMessageEl(m);
    els.empty.classList.add('hidden');
    if (m.role === 'user' && state.title === '新对话') {
      state.title = m.text.slice(0, 24) || '新对话';
      els.title.textContent = state.title;
    }
    scrollToBottom(m.role === 'user');
    if (m.role === 'user') scheduleSave();
  }

  function renderAllMessages() {
    els.messages.innerHTML = '';
    refs.clear();
    state.messages.forEach(addMessageEl);
    els.empty.classList.toggle('hidden', state.messages.length > 0);
    els.title.textContent = state.title;
    scrollToBottom(true);
  }

  /* ---------------- 目标解析 ---------------- */

  function resolveTargets(text) {
    const names = [...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]);
    const out = [];
    names.forEach((n) => {
      const hit = state.models.find((m) => m.name === n) ||
        state.models.find((m) => m.name.toLowerCase() === n.toLowerCase());
      if (hit && !out.includes(hit)) out.push(hit);
    });
    return out;
  }

  function stripMentions(text) {
    return text.replace(/@([^\s@]+)\s*/g, '').trim();
  }

  /* ---------------- 发送与流式 ---------------- */

  function buildBroadcastHistory() {
    if (!els.fullCtx.checked) return null;
    const out = [];
    state.messages.forEach((m) => {
      if (m.error) return;
      if (m.role === 'user') out.push({ role: 'user', content: m.text });
      else if (m.role === 'ai' && m.text) out.push({ role: 'assistant', content: m.text });
    });
    return out;
  }

  async function streamTo(model, userText, history) {
    const msg = {
      id: uid(), role: 'ai', modelId: model.id, name: model.name,
      color: model.color, model: model.model, text: '', streaming: true, cost: null,
    };
    addMessage(msg);

    let finished = false;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: model.id, messages: history }),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: `请求失败（HTTP ${res.status}）` }));
        throw new Error(j.error || `请求失败（HTTP ${res.status}）`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (ev.type === 'delta') {
            msg.text += ev.text;
          } else if (ev.type === 'error') {
            msg.error = ev.message;
            msg.streaming = false;
            finished = true;
          } else if (ev.type === 'done') {
            msg.cost = ev.cost;
            msg.usage = ev.usage;
            msg.streaming = false;
            finished = true;
            state.usage.total = ev.monthTotal;
            state.settings.monthlyBudgetCNY = ev.budget;
            renderBudget();
          }
          refreshMessage(msg);
          scrollToBottom();
        }
      }
    } catch (e) {
      msg.error = e.message || '请求异常';
      msg.streaming = false;
      finished = true;
    }

    if (!finished) {
      msg.streaming = false;
      if (!msg.text && !msg.error) msg.error = '没有收到任何内容，可能是模型名或接入点配置不对。';
      refreshMessage(msg);
    }

    if (!msg.error && msg.text) {
      const ctx = state.contexts[model.id] || (state.contexts[model.id] = []);
      ctx.push({ role: 'user', content: userText });
      ctx.push({ role: 'assistant', content: msg.text });
      if (ctx.length > 24) ctx.splice(0, ctx.length - 24);
    }
    scheduleSave();
  }

  function sendMessage() {
    const raw = els.input.value.trim();
    if (!raw) return;

    const targets = resolveTargets(raw);
    if (!targets.length) {
      toast(state.models.length ? '用 @ 指定一个 AI，例如「@' + state.models[0].name + ' 你好」' : '还没有配置模型');
      return;
    }

    const historyBase = buildBroadcastHistory();
    const clean = stripMentions(raw) || raw;

    addMessage({ id: uid(), role: 'user', text: raw });
    els.input.value = '';
    autoGrow();
    hidePopup();
    updateHint();

    targets.forEach((m) => {
      const history = historyBase
        ? [...historyBase, { role: 'user', content: clean }]
        : [...(state.contexts[m.id] || []), { role: 'user', content: clean }];
      streamTo(m, clean, history);
    });
  }

  /* ---------------- 转发 ---------------- */

  let fwdSource = null;

  function openForwardMenu(m, anchor) {
    fwdSource = m;
    els.fwd.innerHTML = '<div class="fwd-title">把这段转发给…</div>';
    const others = state.models.filter((x) => x.id !== m.modelId);
    if (!others.length) {
      els.fwd.innerHTML += '<div class="fwd-item" style="color:var(--muted)">没有其他成员</div>';
    }
    others.forEach((x) => {
      const item = document.createElement('div');
      item.className = 'fwd-item';
      item.innerHTML = `<span class="dot" style="background:${x.color}"></span><span>${escapeHtml(x.name)}</span>`;
      item.addEventListener('click', () => {
        hideForwardMenu();
        forwardTo(x, m);
      });
      els.fwd.appendChild(item);
    });

    const r = anchor.getBoundingClientRect();
    els.fwd.classList.remove('hidden');
    const w = els.fwd.offsetWidth;
    els.fwd.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
    els.fwd.style.top = (r.bottom + 6) + 'px';
  }

  function hideForwardMenu() {
    els.fwd.classList.add('hidden');
    fwdSource = null;
  }

  function forwardTo(target, source) {
    const text = `以下是 ${source.name} 的回答，请你审阅并给出你的看法：同意哪部分、不同意哪部分，都要说明理由。\n\n${source.text}`;
    const historyBase = buildBroadcastHistory();
    addMessage({ id: uid(), role: 'user', text, forward: true });
    const history = historyBase
      ? [...historyBase, { role: 'user', content: text }]
      : [...(state.contexts[target.id] || []), { role: 'user', content: text }];
    streamTo(target, text, history);
  }

  /* ---------------- @ 弹出层 ---------------- */

  let popupItems = [];
  let popupIndex = 0;
  let popupAt = -1;

  function hidePopup() {
    els.popup.classList.add('hidden');
    els.popup.innerHTML = '';
    popupItems = [];
    popupIndex = 0;
    popupAt = -1;
  }

  function updatePopup() {
    const ta = els.input;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at < 0) return hidePopup();
    const query = before.slice(at + 1);
    if (/[\s@]/.test(query)) return hidePopup();

    const items = state.models.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()));
    if (!items.length) return hidePopup();

    popupAt = at;
    popupItems = items;
    popupIndex = Math.min(popupIndex, items.length - 1);
    els.popup.innerHTML = '';
    items.forEach((m, i) => {
      const d = document.createElement('div');
      d.className = 'mention-item' + (i === popupIndex ? ' active' : '');
      d.innerHTML = `<span class="dot" style="background:${m.color}"></span><span>${escapeHtml(m.name)}</span>` +
        `<span class="tiny">${m.hasKey ? '' : '未填密钥'}</span>`;
      d.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(i); });
      els.popup.appendChild(d);
    });
    els.popup.classList.remove('hidden');
  }

  function pickMention(i) {
    const m = popupItems[i];
    if (!m) return;
    const ta = els.input;
    const pos = ta.selectionStart;
    const head = ta.value.slice(0, popupAt);
    const tail = ta.value.slice(pos);
    ta.value = head + '@' + m.name + ' ' + tail;
    const np = (head + '@' + m.name + ' ').length;
    ta.setSelectionRange(np, np);
    hidePopup();
    ta.focus();
    updateHint();
  }

  function updateHint() {
    const targets = resolveTargets(els.input.value);
    els.hint.textContent = targets.length ? '发给：' + targets.map((t) => t.name).join('、') : '';
  }

  function autoGrow() {
    const ta = els.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
  }

  /* ---------------- 弹窗：设置 ---------------- */

  function openModal(title, bodyEl) {
    els.modalTitle.textContent = title;
    els.modalBody.innerHTML = '';
    els.modalBody.appendChild(bodyEl);
    els.modal.classList.remove('hidden');
  }
  function closeModal() {
    els.modal.classList.add('hidden');
  }

  async function openSettings() {
    const box = document.createElement('div');

    state.models.forEach((m) => {
      const f = document.createElement('div');
      f.className = 'field';
      f.innerHTML = `
        <label>${escapeHtml(m.name)} 的 API Key ${m.hasKey ? '<span class="key-ok">已保存</span>' : '<span class="key-no">未填写</span>'}</label>
        <div class="key-row">
          <input type="password" data-key="${m.id}" placeholder="${m.hasKey ? '已保存，留空则不修改' : '粘贴 key'}" autocomplete="off">
        </div>
        <div class="hint">${escapeHtml(m.note || '')}</div>`;
      box.appendChild(f);
    });

    const budget = document.createElement('div');
    budget.className = 'field';
    budget.innerHTML = `
      <label>每月预算（元）</label>
      <input type="number" id="inpBudget" min="0" step="10" value="${state.settings.monthlyBudgetCNY}">
      <div class="hint">AI 互聊消耗很快，达到上限会自动停止调用。</div>`;
    box.appendChild(budget);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;align-items:center;margin-top:6px';
    actions.innerHTML = `
      <button class="primary" id="btnSaveSettings">保存</button>
      <button class="ghost" id="btnResetUsage">重置本月用量</button>`;
    box.appendChild(actions);

    openModal('设置', box);

    $('#btnSaveSettings').addEventListener('click', async () => {
      const inputs = box.querySelectorAll('input[data-key]');
      for (const inp of inputs) {
        const id = inp.dataset.key;
        const val = inp.value.trim();
        if (!val) continue;
        await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, key: val }),
        });
      }
      const b = Number($('#inpBudget').value);
      if (Number.isFinite(b)) {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthlyBudgetCNY: b }),
        });
      }
      await refreshState();
      closeModal();
      toast('已保存');
    });

    $('#btnResetUsage').addEventListener('click', async () => {
      if (!confirm('确定把本月已花金额清零吗？')) return;
      await fetch('/api/usage/reset', { method: 'POST' });
      await refreshState();
      toast('已重置');
    });
  }

  /* ---------------- 弹窗：上下文 ---------------- */

  function openContext(model) {
    const ctx = state.contexts[model.id] || [];
    const box = document.createElement('div');

    const info = document.createElement('div');
    info.className = 'field';
    info.innerHTML = `<div class="hint">${escapeHtml(model.name)} 目前记得 ${ctx.length} 条消息。默认只把它自己上下文里的内容发过去，别的 AI 说了什么它看不到。</div>`;
    box.appendChild(info);

    if (!ctx.length) {
      const p = document.createElement('div');
      p.className = 'tiny';
      p.textContent = '还没有任何上下文。';
      box.appendChild(p);
    }

    ctx.forEach((c) => {
      const d = document.createElement('div');
      d.className = 'ctx-item';
      d.innerHTML = `<div class="ctx-role">${c.role === 'user' ? '我' : model.name}</div>
        <div class="ctx-text">${escapeHtml(c.content).slice(0, 400)}</div>`;
      box.appendChild(d);
    });

    if (ctx.length) {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = '清空它的上下文';
      btn.style.marginTop = '6px';
      btn.addEventListener('click', () => {
        delete state.contexts[model.id];
        scheduleSave();
        closeModal();
        toast(model.name + ' 的上下文已清空');
      });
      box.appendChild(btn);
    }

    openModal(model.name + ' 的上下文', box);
  }

  /* ---------------- 弹窗：历史 ---------------- */

  async function openHistory() {
    const box = document.createElement('div');

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px';
    top.innerHTML = '<button class="primary" id="btnNewChat">新对话</button>' +
      '<span class="tiny">对话都存在本机 data/sessions/ 目录里</span>';
    box.appendChild(top);

    const list = document.createElement('div');
    list.innerHTML = '<div class="tiny">加载中…</div>';
    box.appendChild(list);

    openModal('对话历史', box);
    top.querySelector('#btnNewChat').addEventListener('click', () => {
      closeModal();
      newSession();
    });

    let sessions = [];
    try {
      sessions = (await (await fetch('/api/sessions')).json()).sessions || [];
    } catch (_) {
      list.innerHTML = '<div class="tiny">读取失败</div>';
      return;
    }

    if (!sessions.length) {
      list.innerHTML = '<div class="tiny">还没有历史对话。</div>';
      return;
    }

    list.innerHTML = '';
    sessions.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'hist-row' + (s.id === state.sessionId ? ' active' : '');
      row.innerHTML = `
        <div class="hist-main">
          <div class="hist-title">${escapeHtml(s.title)}</div>
          <div class="tiny">${fmtTime(s.updatedAt)} · ${s.count} 条消息</div>
        </div>
        <button class="ghost" data-del="1">删除</button>`;
      row.addEventListener('click', async () => {
        closeModal();
        await openSession(s.id);
      });
      row.querySelector('[data-del]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('删除「' + s.title + '」？删了就找不回来了。')) return;
        await fetch('/api/sessions/' + s.id, { method: 'DELETE' });
        if (s.id === state.sessionId) newSession();
        openHistory();
      });
      list.appendChild(row);
    });
  }

  /* ---------------- 弹窗：用量明细 ---------------- */

  async function openStats() {
    const box = document.createElement('div');
    box.innerHTML = '<div class="tiny">加载中…</div>';
    openModal('本月用量', box);

    let d;
    try {
      d = await (await fetch('/api/stats')).json();
    } catch (_) {
      box.innerHTML = '<div class="tiny">读取失败</div>';
      return;
    }
    const u = d.usage || {};
    const modelRows = Object.entries(u.byModel || {}).map(([id, b]) => {
      const m = state.models.find((x) => x.id === id);
      return `<tr><td>${escapeHtml(m ? m.name : id)}</td><td>${b.count}</td>` +
        `<td>${(b.input || 0).toLocaleString()}</td><td>${(b.output || 0).toLocaleString()}</td>` +
        `<td>${money(b.cost)}</td></tr>`;
    }).join('');

    const callRows = (d.calls || []).map((c) => `<tr>
        <td>${fmtTime(c.t)}</td>
        <td>${escapeHtml(c.name || c.modelId || '')}</td>
        <td>${(c.input || 0).toLocaleString()} / ${(c.output || 0).toLocaleString()}</td>
        <td>${money(c.cost)}</td>
        <td>${c.ms ? (c.ms / 1000).toFixed(1) + 's' : '-'}</td>
      </tr>`).join('');

    box.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card"><span>本月已花</span><b>${money(u.total || 0)}</b></div>
        <div class="stat-card"><span>预算</span><b>${money(d.budget || 0)}</b></div>
        <div class="stat-card"><span>调用次数</span><b>${u.count || 0}</b></div>
      </div>
      <div class="sec-title" style="margin:18px 0 8px">按模型</div>
      <table class="tbl">
        <thead><tr><th>模型</th><th>次数</th><th>输入 token</th><th>输出 token</th><th>花费</th></tr></thead>
        <tbody>${modelRows || '<tr><td colspan="5" class="tiny">这个月还没有调用</td></tr>'}</tbody>
      </table>
      <div class="sec-title" style="margin:18px 0 8px">最近调用</div>
      <table class="tbl">
        <thead><tr><th>时间</th><th>模型</th><th>in / out</th><th>花费</th><th>耗时</th></tr></thead>
        <tbody>${callRows || '<tr><td colspan="5" class="tiny">还没有记录</td></tr>'}</tbody>
      </table>`;
  }

  /* ---------------- 导出 / 清空 ---------------- */

  function exportMarkdown() {
    if (!state.messages.length) return toast('还没有内容');
    const lines = [`# ${state.title}`, `> 导出于 ${new Date().toLocaleString('zh-CN')}`, ''];
    state.messages.forEach((m) => {
      if (m.error) return;
      if (m.role === 'user') {
        lines.push(`**我**${m.forward ? '（转发）' : ''}：`, '', m.text, '');
      } else {
        lines.push(`**${m.name}**${m.model ? '（' + m.model + '）' : ''}：`, '', m.text, '');
      }
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safe = state.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '对话';
    a.download = safe + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function clearAll() {
    if (!state.messages.length) return;
    if (!confirm('清空当前对话和所有 AI 的上下文？')) return;
    state.messages = [];
    state.contexts = {};
    state.title = '新对话';
    state.sessionId = newSessionId();
    refs.clear();
    renderAllMessages();
    scheduleSave();
    toast('已清空');
  }

  /* ---------------- 状态同步 ---------------- */

  async function refreshState() {
    const res = await fetch('/api/state');
    const data = await res.json();
    state.models = data.models || [];
    state.settings = data.settings || state.settings;
    state.usage = data.usage || state.usage;
    renderMembers();
    renderBudget();
    updateHint();
  }

  /* ---------------- 事件绑定 ---------------- */

  els.input.addEventListener('input', () => {
    autoGrow();
    updatePopup();
    updateHint();
  });

  els.input.addEventListener('keydown', (e) => {
    if (!els.popup.classList.contains('hidden') && popupItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        popupIndex = (popupIndex + 1) % popupItems.length;
        updatePopup();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        popupIndex = (popupIndex - 1 + popupItems.length) % popupItems.length;
        updatePopup();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(popupIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hidePopup();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  els.input.addEventListener('blur', () => setTimeout(hidePopup, 120));
  els.send.addEventListener('click', sendMessage);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-stats').addEventListener('click', openStats);
  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-export').addEventListener('click', exportMarkdown);
  $('#btn-clear').addEventListener('click', clearAll);
  $('#modalClose').addEventListener('click', closeModal);
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });
  $('#fullContext').addEventListener('change', () => {
    toast(els.fullCtx.checked ? '已开启：每次把整段对话都发过去（更贵）' : '已关闭：每个 AI 只看自己的上下文');
  });

  document.addEventListener('click', (e) => {
    if (!els.fwd.classList.contains('hidden') && !els.fwd.contains(e.target)) hideForwardMenu();
  });
  window.addEventListener('resize', hideForwardMenu);

  /* ---------------- 启动 ---------------- */

  (async function init() {
    renderAllMessages();
    let sessions = [];
    try {
      sessions = (await (await fetch('/api/sessions')).json()).sessions || [];
    } catch (_) {
      toast('连不上本地服务，确认 server.mjs 还在运行');
    }
    if (sessions.length) {
      await openSession(sessions[0].id);
    } else {
      const legacy = readLegacy();
      if (legacy) {
        state.sessionId = newSessionId();
        state.messages = legacy.messages.map((m) => ({ ...m, streaming: false }));
        state.contexts = legacy.contexts || {};
        state.title = legacy.title || '新对话';
        renderAllMessages();
        await saveNow();
        localStorage.removeItem(LEGACY_KEY);
        toast('已把之前的对话搬到历史记录里');
      } else {
        newSession();
      }
    }
    try {
      await refreshState();
    } catch (_) { /* 上面的提示已经说明问题 */ }
  })();
})();
