/* miniGPT renderer. Privileged work is available only through the preload bridge. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {
    settings: {}, connection: { account: null, models: [] }, conversations: [],
    conversation: null, attachments: [], streaming: false, sending: false,
    connecting: false, panel: null, expanded: true, composing: false,
    model: '', effort: '', autoScroll: true, toastTimer: null, generation: 0, pendingGeneration: null,
    detachedConversations: new Set(),
  };
  const api = window.mini;
  const effortNames = { none: '不思考', minimal: '极低', low: '低', medium: '中等', high: '高', xhigh: '超高', max: '最高', ultra: '极致' };
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const messageNodes = new Map();

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  function button(label, className, action, iconName) {
    const node = document.createElement('button');
    node.className = className;
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    if (iconName) node.append(icon(iconName)); else node.textContent = label;
    node.addEventListener('click', action);
    return node;
  }
  function errorMessage(error) { return error?.message || String(error || '操作未完成，请稍后重试。'); }
  function showError(error) { $('error-text').textContent = errorMessage(error); $('error-bar').hidden = false; }
  function clearError() { $('error-bar').hidden = true; }
  function toast(text) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = text;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
  }
  async function invoke(action, payload) {
    if (!api?.invoke) throw new Error('请从 miniGPT 桌面程序打开此窗口。');
    return api.invoke(action, payload);
  }
  async function safely(action) { try { return await action(); } catch (error) { showError(error); return undefined; } }
  function isConnected() { return Boolean(state.connection.status === 'connected' && !state.connecting && state.connection.account?.type === 'chatgpt' && state.connection.models?.length && !state.connection.error); }
  function needsReconnect() { return state.connection.status !== 'connected' || state.connection.account?.type === 'chatgpt'; }
  function modelId(model) { return model.model || model.id; }
  function currentModel() { return (state.connection.models || []).find((model) => modelId(model) === state.model); }
  function resizePrompt() {
    const prompt = $('prompt');
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, state.expanded ? 130 : 66)}px`;
  }
  function updateSend() {
    const stop = state.streaming;
    $('send-message').disabled = stop ? false : (state.sending || !isConnected() || (!$('prompt').value.trim() && !state.attachments.length));
    $('send-message').title = stop ? '停止生成' : !isConnected() ? needsReconnect() ? '重新连接后发送' : '登录 ChatGPT 账号后发送' : '发送 · Enter';
    $('send-message').setAttribute('aria-label', stop ? '停止生成' : '发送消息');
    $('send-message').querySelector('.icon').hidden = stop;
    $('send-message').querySelector('.stop-square').hidden = !stop;
    $('model-select').disabled = !isConnected() || state.streaming || state.sending;
    $('effort-select').disabled = !isConnected() || state.streaming || state.sending || !(currentModel()?.supportedReasoningEfforts?.length);
    $('login-button').disabled = state.connecting || state.streaming || state.sending;
    $('reconnect-button').disabled = state.connecting || state.streaming || state.sending;
    $('save-codex-path').disabled = state.connecting || state.streaming || state.sending;
  }
  function renderModels() {
    const models = state.connection.models || [];
    const select = $('model-select');
    select.replaceChildren();
    if (!models.length) {
      const option = new Option('连接后选择模型', '');
      select.append(option);
      state.model = '';
    } else {
      if (!models.some((model) => modelId(model) === state.model)) {
        const preferred = models.find((model) => modelId(model) === state.settings.model) || models.find((model) => model.isDefault) || models[0];
        state.model = modelId(preferred);
      }
      models.forEach((model) => select.append(new Option(model.displayName || modelId(model), modelId(model))));
      select.value = state.model;
    }
    renderEfforts();
  }
  function renderEfforts() {
    const select = $('effort-select');
    const model = currentModel();
    const efforts = model?.supportedReasoningEfforts || [];
    select.replaceChildren();
    if (!efforts.length) {
      state.effort = '';
      select.append(new Option('默认', ''));
    } else {
      const values = efforts.map((item) => typeof item === 'string' ? item : item.reasoningEffort);
      if (!values.includes(state.effort)) state.effort = values.includes(state.settings.effort) ? state.settings.effort : model.defaultReasoningEffort || values[0];
      if (!values.includes(state.effort)) state.effort = values[0];
      efforts.forEach((item) => {
        const value = typeof item === 'string' ? item : item.reasoningEffort;
        const option = new Option(`思考 · ${effortNames[value] || value}`, value);
        if (item.description) option.title = item.description;
        select.append(option);
      });
      select.value = state.effort;
    }
    select.title = state.effort ? `思考强度：${effortNames[state.effort] || state.effort}` : '使用模型默认思考强度';
    updateSend();
  }
  function renderConnection() {
    const account = state.connection.account;
    const knownAccount = account?.type === 'chatgpt';
    const connected = isConnected();
    $('account-dot').classList.toggle('connected', connected);
    $('account-dot').classList.toggle('connecting', state.connecting);
    const plan = account?.planType || account?.plan || '';
    const accountName = account?.email || account?.name || account?.displayName || 'ChatGPT 账号';
    $('account-label').textContent = connected ? `ChatGPT${plan ? ` ${plan}` : ''} · 已连接` : state.connecting ? '正在连接订阅…' : knownAccount ? '连接已断开 · 点击重新连接' : '连接 ChatGPT 订阅';
    $('settings-account-name').textContent = knownAccount ? accountName : '尚未连接';
    $('settings-account-detail').textContent = connected ? `已连接${plan ? ` · ${plan}` : ''} · Codex 权益` : state.connecting ? '正在检查登录状态…' : knownAccount ? '连接已断开，请点击“重新连接”' : '使用你的 ChatGPT 账号登录';
    $('login-button').textContent = knownAccount ? '重新登录' : '登录 ChatGPT';
    $('login-button').disabled = state.connecting;
    $('reconnect-button').disabled = state.connecting;
    $('connection-banner').hidden = connected;
    $('connection-banner-text').textContent = state.connecting ? '正在连接本机 Codex…' : state.connection.error ? errorMessage(state.connection.error) : needsReconnect() ? '连接已断开，请重新连接后继续对话。' : account && account.type !== 'chatgpt' ? '当前为 API 登录，请切换到 ChatGPT 账号以使用订阅。' : '登录 ChatGPT，使用订阅中的 Codex 权益';
    $('connection-banner-action').textContent = state.connecting ? '连接中' : needsReconnect() ? '重新连接' : '登录';
    $('connection-banner-action').disabled = state.connecting;
    const rawLimits = state.connection.rateLimits;
    const limits = rawLimits?.rateLimits || rawLimits;
    $('rate-limit-copy').hidden = !limits;
    if (limits) {
      const windows = [limits.primary, limits.secondary].filter(Boolean);
      const details = windows.filter((item) => typeof item.usedPercent === 'number').map((item) => `${item.windowDurationMins >= 10080 ? '每周' : item.windowDurationMins ? `${Math.round(item.windowDurationMins / 60)} 小时` : '当前'}额度剩余 ${Math.max(0, Math.round(100 - item.usedPercent))}%`);
      $('rate-limit-copy').textContent = details.length ? details.join(' · ') : '额度由 ChatGPT 订阅管理，实际可用量以官方服务为准。';
    }
    renderModels();
  }
  function setConnection(connection) {
    const next = connection || { status: 'disconnected' };
    const status = next.error ? 'disconnected' : next.status || 'disconnected';
    // Transport failures do not establish that the official account logged out.
    // Keep its last model selection until a successful account refresh replaces it.
    state.connection = status === 'connected' ? { ...next, status } : {
      ...state.connection, ...next, status,
      account: state.connection.account || next.account || null,
      models: state.connection.models?.length ? state.connection.models : next.models || [],
    };
    state.connecting = state.connection.status === 'connecting';
    renderConnection();
  }
  async function connect() {
    clearError();
    setConnection({ status: 'connecting', error: null });
    try { setConnection(await invoke('connect')); }
    catch (error) { setConnection({ status: 'disconnected', error: errorMessage(error) }); showError(error); }
  }
  async function login() {
    $('login-button').disabled = true;
    try {
      const result = await invoke('login');
      if (result?.authUrl) {
        toast('请在浏览器完成登录，随后点击“重新连接”。');
      } else if (result?.account) setConnection(result);
      else toast('登录已启动，请完成登录后重新连接。');
    } catch (error) { showError(error); }
    finally { $('login-button').disabled = false; }
  }
  function applyTheme() {
    const theme = state.settings.theme || 'system';
    document.body.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
  }
  function applySettings(settings, hotkeyStatus) {
    state.settings = settings || state.settings;
    $('setting-hotkey').value = state.settings.hotkey || 'Alt+Space';
    $('setting-pin').checked = Boolean(state.settings.alwaysOnTop);
    $('pin-toggle').setAttribute('aria-pressed', String(Boolean(state.settings.alwaysOnTop)));
    $('pin-toggle').title = state.settings.alwaysOnTop ? '取消窗口置顶' : '置顶窗口';
    $('setting-hide-blur').checked = Boolean(state.settings.hideOnBlur);
    $('setting-follow-mouse').checked = state.settings.followCursor !== false;
    $('setting-autostart').checked = Boolean(state.settings.launchAtLogin);
    $('setting-theme').value = state.settings.theme || 'system';
    $('setting-codex-path').value = state.settings.codexPath || '';
    if (hotkeyStatus !== undefined) {
      const failed = hotkeyStatus === false || hotkeyStatus?.registered === false || hotkeyStatus?.success === false;
      $('hotkey-status').textContent = failed ? '快捷键未注册成功，可能已被其他应用占用。请更换快捷键。' : `${state.settings.hotkey || 'Alt+Space'} 唤起或隐藏窗口`;
      $('hotkey-status').classList.toggle('hotkey-error', failed);
    }
    applyTheme();
  }
  async function saveSettings(patch) {
    try {
      const result = await invoke('settings:update', patch);
      applySettings(result.settings || result, result.hotkeyStatus);
      return result;
    } catch (error) { applySettings(state.settings); throw error; }
  }
  async function setExpanded(expanded) {
    await invoke('window:expand', { expanded });
    state.expanded = expanded;
    $('app').classList.toggle('compact', !expanded);
    $('expand-window').title = expanded ? '切换紧凑窗口' : '展开对话窗口';
    resizePrompt();
  }
  async function openPanel(panel) {
    if (state.panel === panel) { closePanel(); return; }
    await setExpanded(true);
    state.panel = panel;
    $('history-panel').hidden = panel !== 'history';
    $('settings-panel').hidden = panel !== 'settings';
    $('panel-backdrop').hidden = false;
    $('history-toggle').setAttribute('aria-expanded', String(panel === 'history'));
    $('settings-toggle').setAttribute('aria-expanded', String(panel === 'settings'));
    if (panel === 'history') { await refreshHistory(); $('history-search').focus(); }
    else $('settings-panel').querySelector('.panel-close').focus();
  }
  function closePanel() {
    state.panel = null;
    $('history-panel').hidden = true;
    $('settings-panel').hidden = true;
    $('panel-backdrop').hidden = true;
    $('history-toggle').setAttribute('aria-expanded', 'false');
    $('settings-toggle').setAttribute('aria-expanded', 'false');
    $('prompt').focus();
  }
  function safeMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      return window.DOMPurify.sanitize(window.marked.parse(text || '', { breaks: true, gfm: true }), { FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'video', 'audio'], FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false });
    }
    return null;
  }
  function fillContent(element, text, markdown) {
    const html = markdown ? safeMarkdown(text) : null;
    if (html !== null) element.innerHTML = html; else element.textContent = text || '';
  }
  function newMessageNode(message) {
    const wrapper = document.createElement('article');
    wrapper.className = `message message-${message.role === 'user' ? 'user' : 'assistant'}`;
    wrapper.dataset.messageId = message.id;
    if (message.role !== 'user') {
      const heading = document.createElement('div'); heading.className = 'assistant-heading'; heading.append(icon('spark'));
      const label = document.createElement('span'); label.textContent = 'miniGPT'; heading.append(label); wrapper.append(heading);
    }
    if (message.attachments?.length) {
      const attachments = document.createElement('div'); attachments.className = 'message-attachments';
      message.attachments.forEach((file) => {
        const item = document.createElement('div'); item.className = 'message-attachment'; item.append(icon((file.kind || file.type) === 'image' ? 'image' : 'file'));
        const name = document.createElement('span'); name.textContent = file.name; item.append(name); attachments.append(item);
      });
      wrapper.append(attachments);
    }
    const content = document.createElement('div'); content.className = 'message-content'; wrapper.append(content);
    if (message.role !== 'user') {
      const actions = document.createElement('div'); actions.className = 'message-actions';
      actions.append(button('复制回答', 'icon-button', () => safely(async () => {
        const current = state.conversation?.messages.find((item) => item.id === message.id);
        await invoke('clipboard:write', { text: current?.content || message.content || '' }); toast('已复制回答');
      }), 'copy'));
      wrapper.append(actions);
    }
    messageNodes.set(message.id, wrapper);
    return wrapper;
  }
  function renderMessage(message, isStreaming) {
    let node = messageNodes.get(message.id);
    if (!node) { node = newMessageNode(message); $('messages').append(node); }
    node.classList.toggle('streaming', isStreaming);
    node.classList.toggle('has-content', Boolean(message.content));
    const content = node.querySelector('.message-content');
    if (!message.content && isStreaming) {
      content.replaceChildren();
      const dots = document.createElement('span'); dots.className = 'thinking-dots'; dots.setAttribute('aria-label', '正在思考');
      for (let i = 0; i < 3; i++) dots.append(document.createElement('span'));
      content.append(dots);
    } else if (!message.content && message.status === 'interrupted') {
      content.textContent = '已停止生成';
    } else if (!message.content && message.status === 'failed') {
      content.textContent = message.error || '本次回答未完成，请重试。';
    } else fillContent(content, message.content, message.role !== 'user');
    const actions = node.querySelector('.message-actions');
    if (actions) actions.hidden = isStreaming || !message.content;
  }
  function renderConversation() {
    const messages = state.conversation?.messages || [];
    const welcome = !messages.length;
    $('welcome').hidden = !welcome;
    $('app').dataset.view = welcome ? 'welcome' : 'conversation';
    const ids = new Set(messages.map((message) => message.id));
    for (const [id, node] of messageNodes) if (!ids.has(id)) { node.remove(); messageNodes.delete(id); }
    messages.forEach((message, index) => renderMessage(message, state.streaming && message.role !== 'user' && index === messages.length - 1));
    if (state.autoScroll) scrollToBottom();
    updateSend();
  }
  function scrollToBottom() { const area = $('conversation-area'); area.scrollTop = area.scrollHeight; $('scroll-bottom').hidden = true; }
  function upsertConversation(conversation) {
    const existing = state.conversations.findIndex((item) => item.id === conversation.id);
    if (existing >= 0) state.conversations[existing] = conversation; else state.conversations.unshift(conversation);
    renderHistory();
  }
  function setConversation(conversation) {
    state.conversation = conversation;
    if (conversation) {
      if (conversation.status) state.streaming = ['generating', 'streaming', 'running'].includes(conversation.status);
      upsertConversation(conversation);
      if (conversation.model) state.model = conversation.model;
      if (conversation.effort) state.effort = conversation.effort;
      renderModels();
    }
    renderConversation();
  }
  async function newConversation() {
    const oldId = state.conversation?.id;
    const shouldStop = (state.streaming || state.sending) && oldId;
    if (oldId) state.detachedConversations.add(oldId);
    state.generation += 1;
    state.conversation = null;
    state.streaming = false;
    state.sending = state.pendingGeneration !== null;
    state.attachments = [];
    state.autoScroll = true;
    $('prompt').value = '';
    resizePrompt(); renderAttachments(); renderConversation(); closePanel(); clearError();
    $('prompt').focus();
    if (shouldStop) await invoke('chat:stop', { conversationId: oldId });
  }
  async function refreshHistory() {
    const result = await invoke('conversations:list');
    state.conversations = Array.isArray(result) ? result : result?.conversations || [];
    renderHistory();
  }
  function renderHistory() {
    const list = $('history-list'); list.replaceChildren();
    const query = $('history-search').value.trim().toLowerCase();
    const conversations = state.conversations.filter((item) => !query || (item.title || '').toLowerCase().includes(query)).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    if (!conversations.length) {
      const empty = document.createElement('div'); empty.className = 'history-empty'; empty.textContent = query ? '没有找到相关对话' : '还没有对话。\n从一个小问题开始吧。'; list.append(empty); return;
    }
    let lastGroup = '';
    conversations.forEach((conversation) => {
      const date = new Date(conversation.updatedAt || Date.now());
      const group = date.toDateString() === new Date().toDateString() ? '今天' : date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
      if (group !== lastGroup) { const label = document.createElement('div'); label.className = 'history-group-label'; label.textContent = group; list.append(label); lastGroup = group; }
      const row = document.createElement('div'); row.className = `history-item${state.conversation?.id === conversation.id ? ' active' : ''}`;
      const open = button(conversation.title || '新对话', 'history-open', () => safely(async () => {
        if (state.streaming || state.sending) { toast('请先停止当前回答，再切换对话。'); return; }
        const result = await invoke('conversations:get', { id: conversation.id });
        if (!result) throw new Error('这段对话已不存在。');
        state.autoScroll = true; state.detachedConversations.delete(conversation.id); setConversation(result.conversation || result); closePanel();
      }));
      open.replaceChildren();
      const title = document.createElement('span'); title.className = 'history-title'; title.textContent = conversation.title || '新对话';
      const detail = document.createElement('span'); detail.className = 'history-date'; detail.textContent = `${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${conversation.model ? ` · ${conversation.model}` : ''}`;
      open.append(title, detail); row.append(open);
      const remove = button('删除此对话', 'icon-button history-delete', () => safely(async () => {
        if ((state.streaming || state.sending) && state.conversation?.id === conversation.id) { toast('请先停止当前回答。'); return; }
        if (remove.dataset.confirm !== 'true') {
          remove.dataset.confirm = 'true'; remove.replaceChildren(icon('check')); remove.title = '再次点击确认删除';
          setTimeout(() => { if (remove.isConnected) { remove.dataset.confirm = 'false'; remove.replaceChildren(icon('trash')); remove.title = '删除此对话'; } }, 3500); return;
        }
        await invoke('conversations:delete', { id: conversation.id });
        state.conversations = state.conversations.filter((item) => item.id !== conversation.id);
        if (state.conversation?.id === conversation.id) { state.conversation = null; renderConversation(); }
        renderHistory(); toast('对话已删除');
      }), 'trash'); row.append(remove); list.append(row);
    });
  }
  function renderAttachments() {
    const container = $('attachments'); container.replaceChildren(); container.hidden = !state.attachments.length;
    state.attachments.forEach((file) => {
      const chip = document.createElement('div'); chip.className = 'attachment-chip'; chip.append(icon(file.kind === 'image' ? 'image' : 'file'));
      const name = document.createElement('span'); name.textContent = file.name || '附件'; name.title = file.name || '附件'; chip.append(name);
      chip.append(button(`移除 ${file.name || '附件'}`, 'icon-button', () => { state.attachments = state.attachments.filter((item) => item.id !== file.id); renderAttachments(); }, 'close'));
      container.append(chip);
    });
    updateSend();
  }
  async function addAttachments(action) {
    const result = await invoke(action);
    const files = Array.isArray(result) ? result : result?.attachments || [];
    if (action === 'attachments:clipboard' && !files.length && !result?.text) toast('剪贴板中没有图片，请先复制图片。');
    if (result?.text) {
      $('prompt').value += ($('prompt').value ? '\n' : '') + result.text;
      resizePrompt();
    }
    files.forEach((file) => { if (!state.attachments.some((item) => item.id === file.id)) state.attachments.push(file); });
    renderAttachments(); $('prompt').focus();
  }
  async function sendMessage() {
    if (state.streaming) {
      await invoke('chat:stop', { conversationId: state.conversation?.id });
      return;
    }
    const text = $('prompt').value.trim();
    const draftText = $('prompt').value;
    if (state.sending || (!text && !state.attachments.length) || !isConnected()) return;
    clearError();
    const originalAttachments = state.attachments.slice();
    const conversationBefore = state.conversation?.id;
    const generation = state.generation;
    state.pendingGeneration = generation;
    state.sending = true; updateSend(); state.autoScroll = true;
    try {
      if (!state.expanded || !state.conversation) await setExpanded(true);
      if (generation !== state.generation) return;
      const result = await invoke('chat:send', {
        conversationId: conversationBefore || undefined, text, model: state.model,
        effort: state.effort || undefined,
        attachments: originalAttachments.map(({ id, name, kind }) => ({ id, name, kind })),
      });
      if (generation !== state.generation) return;
      if ($('prompt').value === draftText) $('prompt').value = '';
      const sentIds = new Set(originalAttachments.map((file) => file.id));
      state.attachments = state.attachments.filter((file) => !sentIds.has(file.id));
      resizePrompt(); renderAttachments();
      if (result?.conversation) setConversation(result.conversation);
      else if (result?.conversationId && state.conversation?.id !== result.conversationId) {
        const saved = await invoke('conversations:get', { id: result.conversationId });
        if (saved) setConversation(saved.conversation || saved);
      }
    } catch (error) {
      if (generation === state.generation) showError(error);
    } finally {
      if (state.pendingGeneration === generation) { state.pendingGeneration = null; state.sending = false; updateSend(); }
      if (generation === state.generation) $('prompt').focus();
    }
  }
  function onEvent(event) {
    try {
      if (!event || !event.type) return;
      if (event.type === 'connection') setConnection(event.connection);
      else if (event.type === 'settings') applySettings(event.settings, event.hotkeyStatus);
      else if (event.type === 'focus') $('prompt').focus();
      else if (event.type === 'new-conversation') safely(newConversation);
      else if (event.type === 'conversation' && event.conversation) {
        const conversation = event.conversation;
        upsertConversation(conversation);
        if (state.pendingGeneration !== null && state.pendingGeneration !== state.generation) {
          state.detachedConversations.add(conversation.id);
          safely(() => invoke('chat:stop', { conversationId: conversation.id }));
          return;
        }
        if (state.detachedConversations.has(conversation.id)) return;
        if (!state.conversation || state.conversation.id === conversation.id || state.sending) {
          state.streaming = ['generating', 'streaming', 'running'].includes(conversation.status) || state.sending;
          setConversation(conversation);
        }
      } else if (event.type === 'delta') {
        if (!state.conversation || state.conversation.id !== event.conversationId) return;
        state.streaming = true;
        let message = state.conversation.messages.find((item) => item.id === event.messageId);
        if (!message) { message = { id: event.messageId, role: 'assistant', content: '' }; state.conversation.messages.push(message); }
        message.content += event.delta || '';
        renderMessage(message, true); updateSend();
        if (state.autoScroll) scrollToBottom();
      } else if (event.type === 'complete') {
        if (event.conversation) upsertConversation(event.conversation);
        if (state.detachedConversations.has(event.conversation?.id)) return;
        if (!event.conversation || state.conversation?.id === event.conversation.id || !state.conversation) {
          state.streaming = false;
          if (event.conversation) setConversation(event.conversation); else renderConversation();
        }
      } else if (event.type === 'error') {
        if (state.detachedConversations.has(event.conversationId)) return;
        if (!event.conversationId || state.conversation?.id === event.conversationId) { state.streaming = false; state.sending = state.pendingGeneration !== null; renderConversation(); showError(event.message); }
      }
    } catch (error) { showError(error); }
  }

  $('new-chat').addEventListener('click', () => safely(newConversation));
  $('history-toggle').addEventListener('click', () => safely(() => openPanel('history')));
  $('settings-toggle').addEventListener('click', () => safely(() => openPanel('settings')));
  $('account-status').addEventListener('click', () => safely(() => openPanel('settings')));
  $('panel-backdrop').addEventListener('click', closePanel);
  document.querySelectorAll('.panel-close').forEach((element) => element.addEventListener('click', closePanel));
  $('history-search').addEventListener('input', renderHistory);
  $('pin-toggle').addEventListener('click', () => safely(async () => {
    const pinned = !state.settings.alwaysOnTop;
    const result = await invoke('window:pin', { pinned });
    applySettings(result?.settings || { ...state.settings, alwaysOnTop: pinned }, result?.hotkeyStatus);
  }));
  $('hide-window').addEventListener('click', () => safely(() => invoke('window:hide')));
  $('expand-window').addEventListener('click', () => safely(() => setExpanded(!state.expanded)));
  $('error-dismiss').addEventListener('click', clearError);
  $('connection-banner-action').addEventListener('click', () => needsReconnect() ? connect() : login());
  $('login-button').addEventListener('click', login);
  $('reconnect-button').addEventListener('click', connect);
  $('send-message').addEventListener('click', () => safely(sendMessage));
  $('prompt').addEventListener('input', () => { resizePrompt(); updateSend(); });
  $('prompt').addEventListener('compositionstart', () => { state.composing = true; });
  $('prompt').addEventListener('compositionend', () => { state.composing = false; updateSend(); });
  $('prompt').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !state.composing && event.keyCode !== 229) {
      event.preventDefault(); if (!state.streaming) safely(sendMessage);
    }
  });
  $('prompt').addEventListener('paste', (event) => {
    if (Array.from(event.clipboardData?.items || []).some((item) => item.type.startsWith('image/'))) {
      event.preventDefault(); safely(() => addAttachments('attachments:clipboard'));
    }
  });
  $('model-select').addEventListener('change', () => { state.model = $('model-select').value; state.effort = ''; renderEfforts(); });
  $('effort-select').addEventListener('change', () => { state.effort = $('effort-select').value; renderEfforts(); });
  $('attach-clipboard').addEventListener('click', () => safely(() => addAttachments('attachments:clipboard')));
  $('save-hotkey').addEventListener('click', () => safely(async () => { await saveSettings({ hotkey: $('setting-hotkey').value.trim() }); toast('快捷键设置已更新'); }));
  $('setting-pin').addEventListener('change', () => safely(() => saveSettings({ alwaysOnTop: $('setting-pin').checked })));
  $('setting-hide-blur').addEventListener('change', () => safely(() => saveSettings({ hideOnBlur: $('setting-hide-blur').checked })));
  $('setting-follow-mouse').addEventListener('change', () => safely(() => saveSettings({ followCursor: $('setting-follow-mouse').checked })));
  $('setting-autostart').addEventListener('change', () => safely(() => saveSettings({ launchAtLogin: $('setting-autostart').checked })));
  $('setting-theme').addEventListener('change', () => safely(() => saveSettings({ theme: $('setting-theme').value })));
  $('save-codex-path').addEventListener('click', () => safely(async () => { await saveSettings({ codexPath: $('setting-codex-path').value.trim() }); await connect(); }));
  $('quit-app').addEventListener('click', () => safely(() => invoke('app:quit')));
  $('scroll-bottom').addEventListener('click', () => { state.autoScroll = true; scrollToBottom(); });
  $('conversation-area').addEventListener('scroll', () => {
    const area = $('conversation-area');
    state.autoScroll = area.scrollHeight - area.scrollTop - area.clientHeight < 65;
    $('scroll-bottom').hidden = state.autoScroll || !(state.conversation?.messages.length);
  }, { passive: true });
  $('messages').addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (link) { event.preventDefault(); const url = link.getAttribute('href'); if (url && /^https?:\/\//i.test(url)) safely(() => invoke('link:open', { url })); else toast('仅支持打开 http 或 https 链接。'); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || state.composing) return;
    if (event.key === 'Escape') { event.preventDefault(); if (state.panel) closePanel(); else safely(() => invoke('window:hide')); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); safely(newConversation); }
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => { event.preventDefault(); toast('请复制图片后按 Ctrl+V 粘贴。'); });
  systemTheme.addEventListener('change', applyTheme);
  window.addEventListener('resize', resizePrompt);

  async function bootstrap() {
    state.connecting = true; renderConnection();
    if (api?.onEvent) api.onEvent(onEvent);
    try {
      const result = await invoke('bootstrap');
      applySettings(result.settings, result.hotkeyStatus);
      state.conversations = result.conversations || [];
      setConnection(result.connection);
      renderHistory(); renderConversation(); resizePrompt();
      $('prompt').focus();
    } catch (error) {
      state.connecting = false; state.connection.error = errorMessage(error); renderConnection(); showError(error);
    }
  }
  bootstrap();
})();
