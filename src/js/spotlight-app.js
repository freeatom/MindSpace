/**
 * MindSpace Spotlight — compact thought capture, AI search, embedded browser
 */
(function () {
  const MODES = ['thought', 'chat', 'search', 'notes'];

  const thoughtInput = document.getElementById('thought-input');
  const thoughtGhost = document.getElementById('thought-ghost');
  const thoughtType = document.getElementById('thought-type');
  const thoughtArea = document.getElementById('thought-area');
  const fileResults = document.getElementById('file-results');
  const modeTabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  const chatMessages = document.getElementById('chat-messages');
  const chatChips = document.getElementById('chat-chips');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');

  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const searchBody = document.getElementById('search-body');
  const searchSplitContainer = document.getElementById('search-split-container');
  const searchResultsWrap = document.getElementById('search-results-wrap');
  const panelDivider = document.getElementById('panel-divider');
  const restorePanelsBtn = document.getElementById('restore-panels-btn');
  const aiAnswerContainer = document.getElementById('ai-answer-container');
  const recentList = document.getElementById('recent-list');
  const browserSection = document.getElementById('browser-section');
  const searchWebview = document.getElementById('search-webview');
  const browserUrl = document.getElementById('browser-url');
  const thoughtExpandBtn = document.getElementById('thought-expand');
  const notesArea = document.getElementById('notes-textarea');
  const notesNameInput = document.getElementById('notes-name-input');
  const notesSaveBtn = document.getElementById('notes-save-btn');
  const notesStatus = document.getElementById('notes-status');

  const modelLabel = document.getElementById('model-label');
  const apiDot = document.getElementById('api-dot');

  let currentMode = 'thought';
  let pastedImage = null;
  let loadedWorkflows = [];
  let currentWorkflowMatch = null;
  let localFileResults = [];
  let selectedFileIndex = -1;
  let searchTimeout = null;
  let notesSaveTimeout = null;
  let recentSearches = [];
  let thoughtNotesExpanded = false;
  let currentBrowserUrl = '';
  let browserLayoutMode = 'stacked';
  let panelRatio = 0.30;
  let panelResizeBound = false;
  const LAYOUT_WIDTHS = { stacked: 380, split: 760, expanded: 420, fullscreen: 920 };

  let chatHistory = [];
  let chatStreaming = false;
  let streamingBubble = null;
  let aiConfig = { hasKey: false, supportsStream: true, model: 'Groq' };
  let screenLayout = { width: 380, maxHeight: 720 };

  const CHAT_SYSTEM = `You are MindSpace, a helpful AI assistant. Be concise and clear.`;

  const CALENDAR_TRIGGERS = [
    /^cal$/i, /^calendar$/i,
    /schedule\s+(a\s+)?meeting/i, /create\s+(a\s+)?reminder/i,
    /add\s+(an?\s+)?event/i, /set\s+(a\s+)?reminder/i, /book\s+(an?\s+)?appointment/i,
  ];

  function isCalendarLike(text) {
    const t = (text || '').trim();
    return t && CALENDAR_TRIGGERS.some((re) => re.test(t));
  }

  // ─── Init (deferred — window is pre-warmed, don't block first paint) ───
  let notesLoaded = false;
  let backgroundDataReady = false;

  function loadBackgroundData() {
    if (backgroundDataReady) return;
    backgroundDataReady = true;
    window.spotlightAPI.getWorkflows().then((wfs) => { loadedWorkflows = wfs || []; });
    window.spotlightAPI.getAiConfig().then((cfg) => {
      aiConfig = cfg;
      updateModelPill();
    });
  }

  function loadNotesLazy() {
    if (notesLoaded) return;
    notesLoaded = true;
    window.spotlightAPI.getNotes().then((text) => {
      if (notesArea) notesArea.value = text || '';
    });
  }

  function onSpotlightShown() {
    loadBackgroundData();
    if (currentMode === 'thought') {
      thoughtInput?.focus();
      updateWindowSize();
    } else if (currentMode === 'chat') chatInput?.focus();
    else if (currentMode === 'search') searchInput?.focus();
    else if (currentMode === 'notes') {
      loadNotesLazy();
      notesArea?.focus();
    }
  }

  updateWindowSize();
  window.spotlightAPI.getLayout().then((layout) => {
    screenLayout = layout;
    updateWindowSize();
  });
  window.spotlightAPI.onShown(() => onSpotlightShown());
  window.spotlightAPI.onHidden(() => closeBrowser());
  window.spotlightAPI.onChatChunk(({ chunk }) => appendStreamingChunk(chunk));

  // Preload workflows while window is hidden
  setTimeout(loadBackgroundData, 0);

  modeTabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

  document.getElementById('thought-clear')?.addEventListener('click', () => {
    thoughtInput.value = '';
    thoughtArea.value = '';
    thoughtGhost.textContent = '';
    thoughtGhost.classList.remove('visible');
    pastedImage = null;
    thoughtType.textContent = 'Thought';
    thoughtNotesExpanded = false;
    thoughtArea?.classList.remove('visible');
    if (thoughtExpandBtn) thoughtExpandBtn.textContent = '+ Add notes (optional)';
    updateWindowSize();
  });

  thoughtExpandBtn?.addEventListener('click', () => {
    thoughtNotesExpanded = !thoughtNotesExpanded;
    thoughtArea?.classList.toggle('visible', thoughtNotesExpanded);
    thoughtExpandBtn.textContent = thoughtNotesExpanded ? '− Hide notes' : '+ Add notes (optional)';
    if (thoughtNotesExpanded) thoughtArea?.focus();
    updateWindowSize();
  });

  notesArea?.addEventListener('input', () => {
    clearTimeout(notesSaveTimeout);
    notesSaveTimeout = setTimeout(async () => {
      await window.spotlightAPI.saveNotes(notesArea.value);
      if (notesStatus) notesStatus.textContent = 'Draft saved';
    }, 400);
  });

  notesSaveBtn?.addEventListener('click', saveNamedNote);
  notesNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveNamedNote();
    }
  });

  async function saveNamedNote() {
    const name = notesNameInput?.value.trim();
    const content = notesArea?.value || '';
    if (!name) {
      notesNameInput?.focus();
      if (notesStatus) notesStatus.textContent = 'Enter a note name to save';
      return;
    }
    if (!content.trim()) {
      if (notesStatus) notesStatus.textContent = 'Note content is empty';
      return;
    }
    notesSaveBtn.disabled = true;
    try {
      await window.spotlightAPI.createNote({ name, content });
      if (notesStatus) notesStatus.textContent = `Saved "${name}"`;
      notesNameInput.value = '';
      notesArea.value = '';
      await window.spotlightAPI.saveNotes('');
    } catch (err) {
      if (notesStatus) notesStatus.textContent = 'Save failed';
      console.error(err);
    } finally {
      notesSaveBtn.disabled = false;
    }
  }

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      chatInput.value = chip.dataset.prompt;
      chatInput.focus();
    });
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  chatSend.addEventListener('click', sendChatMessage);

  document.getElementById('search-submit').addEventListener('click', runWebSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runWebSearch();
  });

  thoughtInput.addEventListener('input', handleThoughtInput);
  thoughtInput.addEventListener('keydown', handleThoughtKeydown);

  document.addEventListener('paste', (e) => {
    if (currentMode !== 'thought') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          pastedImage = reader.result;
          thoughtType.textContent = 'Image';
          thoughtInput.placeholder = 'Image captured — add a note or press Enter';
        };
        reader.readAsDataURL(item.getAsFile());
        return;
      }
    }
  });

  // ─── Mode switching ───
  function setMode(mode) {
    if (!MODES.includes(mode)) return;
    if (mode !== 'search') closeBrowser();
    currentMode = mode;

    modeTabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    panels.forEach((p) => p.classList.toggle('active', p.dataset.mode === mode));

    const panelOpen = mode !== 'thought';
    window.spotlightAPI.setPanelOpen(panelOpen);
    updateWindowSize();

    if (mode === 'thought') thoughtInput.focus();
    else if (mode === 'chat') chatInput.focus();
    else if (mode === 'search') {
      searchInput.focus();
      initBrowser();
    }
    else if (mode === 'notes') {
      loadNotesLazy();
      notesArea?.focus();
    }

    if (mode === 'chat') updateChatChipsVisibility();
  }

  function updateWindowSize() {
    const width = screenLayout.width || 380;
    const maxH = screenLayout.maxHeight || 720;
    let height;

    if (currentMode !== 'thought') {
      height = maxH;
    } else {
      let compactH = 118;
      if (thoughtNotesExpanded) compactH += 68;
      if (fileResults.classList.contains('visible')) compactH += 140;
      height = Math.min(compactH, maxH * 0.4);
    }

    window.spotlightAPI.resize({ width, height });
  }

  function updateModelPill() {
    const name = aiConfig.model || 'llama-3.3-70b-versatile';
    const short = name.includes('llama') ? 'Groq' : name.split('/').pop().substring(0, 14);
    modelLabel.textContent = short;
    apiDot.classList.toggle('offline', !aiConfig.hasKey);
  }

  // ─── Thought mode ───
  function handleThoughtInput() {
    const val = thoughtInput.value;
    const trimVal = val.trim();
    currentWorkflowMatch = null;
    thoughtGhost.textContent = '';
    thoughtGhost.classList.remove('visible');

    if (!val) {
      thoughtType.textContent = 'Thought';
      fileResults.classList.remove('visible');
      fileResults.innerHTML = '';
      updateWindowSize();
      return;
    }

    if (val.toLowerCase().startsWith('find: ')) {
      thoughtType.textContent = 'File';
      const query = val.substring(6).trim();
      clearTimeout(searchTimeout);
      if (!query) {
        fileResults.classList.remove('visible');
        updateWindowSize();
        return;
      }
      fileResults.innerHTML = '<div class="panel-status">Searching…</div>';
      fileResults.classList.add('visible');
      updateWindowSize();
      searchTimeout = setTimeout(async () => {
        localFileResults = await window.spotlightAPI.searchLocalFiles(query);
        selectedFileIndex = -1;
        renderFileResults();
      }, 400);
      return;
    }

    fileResults.classList.remove('visible');
    updateWindowSize();

    if (trimVal.length > 0) {
      const match = loadedWorkflows.find((w) => w.name.toLowerCase().startsWith(trimVal.toLowerCase()));
      if (match) {
        currentWorkflowMatch = match;
        thoughtGhost.textContent = val + match.name.substring(val.length);
        thoughtGhost.classList.add('visible');
        thoughtType.textContent = 'Workflow';
        return;
      }
    }

    if (isCalendarLike(trimVal)) thoughtType.textContent = 'Calendar';
    else if (val.startsWith('/')) thoughtType.textContent = 'Workflow';
    else if (/^https?:\/\//i.test(trimVal)) thoughtType.textContent = 'Archive';
    else thoughtType.textContent = 'Thought';
  }

  function renderFileResults() {
    if (!localFileResults?.length) {
      fileResults.innerHTML = '<div class="panel-status">No files found.</div>';
      updateWindowSize();
      return;
    }
    fileResults.innerHTML = localFileResults.map((f, i) => `
      <div class="result-item ${i === selectedFileIndex ? 'selected' : ''}" data-index="${i}">
        <div class="result-name">${escapeHtml(f.Name)}</div>
        <div class="result-path">${escapeHtml(f.Path)}</div>
      </div>
    `).join('');
    fileResults.querySelectorAll('.result-item').forEach((el) => {
      el.addEventListener('click', () => {
        window.spotlightAPI.openFile(localFileResults[parseInt(el.dataset.index, 10)].Path);
        window.spotlightAPI.close();
      });
    });
    updateWindowSize();
  }

  function handleThoughtKeydown(e) {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const idx = MODES.indexOf(currentMode);
      setMode(MODES[(idx + 1) % MODES.length]);
      return;
    }
    if (e.ctrlKey && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      setMode(MODES[parseInt(e.key, 10) - 1]);
      return;
    }
    if (e.key === 'Escape') {
      window.spotlightAPI.close();
      return;
    }

    if (fileResults.classList.contains('visible') && localFileResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedFileIndex = Math.min(selectedFileIndex + 1, localFileResults.length - 1);
        renderFileResults();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedFileIndex = Math.max(selectedFileIndex - 1, -1);
        renderFileResults();
        return;
      }
    }

    if (e.key !== 'Enter') return;
    e.preventDefault();
    const val = thoughtInput.value.trim();

    if (isCalendarLike(val)) {
      window.spotlightAPI.parseCalendarCommand(val).then((prefill) => {
        window.spotlightAPI.openCalendar(prefill || {});
      });
      return;
    }

    if (fileResults.classList.contains('visible') && selectedFileIndex >= 0) {
      window.spotlightAPI.openFile(localFileResults[selectedFileIndex].Path);
      window.spotlightAPI.close();
      return;
    }
    if (currentWorkflowMatch) {
      window.spotlightAPI.executeWorkflow(currentWorkflowMatch.name);
      window.spotlightAPI.close();
      return;
    }
    if (!val && !pastedImage) return;

    if (val.startsWith('/')) {
      window.spotlightAPI.executeWorkflow(val.substring(1).trim());
    } else {
      const isUrl = /^https?:\/\//i.test(val);
      if (pastedImage || isUrl) {
        window.spotlightAPI.saveArchive({
          title: val || 'Quick Capture',
          content: val,
          images: pastedImage ? [pastedImage] : [],
          tags: ['spotlight'],
        });
      } else {
        const content = thoughtArea.value.trim()
          ? thoughtArea.value.trim() + '\n\n' + val
          : val;
        window.spotlightAPI.saveThought({
          content,
          priority: 'medium',
          persistence: 'persistent',
          tags: ['spotlight'],
        });
      }
    }
    window.spotlightAPI.close();
  }

  // ─── AI Chat ───
  function formatTime() {
    return 'just now';
  }

  function updateChatChipsVisibility() {
    chatChips.classList.toggle('hidden', chatHistory.length > 0);
  }

  async function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || chatStreaming) return;

    aiConfig = await window.spotlightAPI.getAiConfig();
    updateModelPill();
    if (!aiConfig.hasKey) {
      appendAssistantMessage('Add your API key in MindSpace → Settings → AI Assistant.');
      chatInput.value = '';
      return;
    }

    chatHistory.push({ role: 'user', content: text });
    appendUserMessage(text);
    chatInput.value = '';
    chatChips.classList.add('hidden');
    chatStreaming = true;
    chatSend.disabled = true;

    const wrap = document.createElement('div');
    wrap.className = 'msg-ai-wrap';
    wrap.innerHTML = `
      <div class="msg-meta">
        <div class="model-icon">G</div>
        <span>${escapeHtml(modelLabel.textContent)}</span>
        <span style="margin-left:auto">${formatTime()}</span>
      </div>
      <div class="msg-ai streaming" id="streaming-bubble"></div>
      <div class="msg-actions">
        <button type="button" class="act-copy" title="Copy">${iconCopy()}</button>
        <button type="button" class="act-regen" title="Regenerate">${iconRefresh()}</button>
      </div>
    `;
    chatMessages.appendChild(wrap);
    streamingBubble = document.getElementById('streaming-bubble');
    scrollChat();

    const messages = [
      { role: 'system', content: CHAT_SYSTEM },
      ...chatHistory.slice(-20),
    ];

    let assistantText = '';
    try {
      if (aiConfig.supportsStream) {
        await window.spotlightAPI.chat({ messages, stream: true });
        assistantText = streamingBubble?.textContent || '';
      } else {
        const res = await window.spotlightAPI.chat({ messages, stream: false });
        assistantText = res.content || '';
        if (streamingBubble) streamingBubble.textContent = assistantText;
      }
      if (!assistantText) assistantText = '(No response)';
      streamingBubble?.classList.remove('streaming');
      streamingBubble?.removeAttribute('id');
      chatHistory.push({ role: 'assistant', content: assistantText });

      wrap.querySelector('.act-copy')?.addEventListener('click', () => {
        navigator.clipboard.writeText(assistantText);
      });
      wrap.querySelector('.act-regen')?.addEventListener('click', async () => {
        chatHistory = chatHistory.slice(0, -2);
        chatMessages.removeChild(wrap);
        chatInput.value = text;
        await sendChatMessage();
      });
    } catch (err) {
      wrap.remove();
      chatHistory.pop();
      appendAssistantMessage('Error: ' + (err.message || 'Request failed'));
    } finally {
      chatStreaming = false;
      chatSend.disabled = false;
      streamingBubble = null;
      scrollChat();
    }
  }

  function appendStreamingChunk(chunk) {
    if (streamingBubble) {
      streamingBubble.textContent += chunk;
      scrollChat();
    }
  }

  function appendUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg-user';
    el.textContent = text;
    chatMessages.appendChild(el);
    scrollChat();
  }

  function appendAssistantMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-ai-wrap';
    wrap.innerHTML = `
      <div class="msg-meta">
        <div class="model-icon">G</div>
        <span>${escapeHtml(modelLabel.textContent)}</span>
        <span style="margin-left:auto">${formatTime()}</span>
      </div>
      <div class="msg-ai">${escapeHtml(text)}</div>
    `;
    chatMessages.appendChild(wrap);
    scrollChat();
  }

  function scrollChat() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ─── Browser layout modes & resizable panels ───
  function applyPanelRatio(ratio) {
    panelRatio = Math.min(0.65, Math.max(0.15, ratio));
    if (searchSplitContainer) {
      searchSplitContainer.style.setProperty('--results-size', `${Math.round(panelRatio * 100)}%`);
    }
  }

  function resizeForSearchLayout() {
    const maxH = screenLayout.maxHeight || 720;
    let width = LAYOUT_WIDTHS[browserLayoutMode] || 380;
    if (screenLayout.workArea?.width) {
      width = Math.min(width, screenLayout.workArea.width - 24);
    }
    window.spotlightAPI.resize({ width, height: maxH });
  }

  function setBrowserLayout(mode) {
    if (!searchSplitContainer) return;
    browserLayoutMode = mode;

    searchSplitContainer.classList.remove('layout-stacked', 'layout-split', 'layout-expanded', 'layout-fullscreen');
    searchSplitContainer.classList.add(`layout-${mode}`);

    document.querySelectorAll('.layout-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.layout === mode);
    });

    searchBody?.classList.toggle('show-restore', mode === 'fullscreen');

    if (mode === 'expanded') applyPanelRatio(0.18);
    else if (mode === 'stacked') applyPanelRatio(panelRatio || 0.30);
    else if (mode === 'split') applyPanelRatio(0.36);
    else if (mode === 'fullscreen') applyPanelRatio(0);

    if (browserSection?.classList.contains('visible')) {
      resizeForSearchLayout();
    }
  }

  function initPanelResize() {
    if (panelResizeBound || !panelDivider) return;
    panelResizeBound = true;

    let dragging = false;

    const onMove = (e) => {
      if (!dragging || !searchSplitContainer) return;
      const rect = searchSplitContainer.getBoundingClientRect();
      if (browserLayoutMode === 'split') {
        const ratio = (e.clientX - rect.left) / rect.width;
        applyPanelRatio(ratio);
      } else {
        const ratio = (e.clientY - rect.top) / rect.height;
        applyPanelRatio(ratio);
      }
    };

    const onUp = () => {
      dragging = false;
      panelDivider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    panelDivider.addEventListener('mousedown', (e) => {
      if (browserLayoutMode === 'fullscreen') return;
      e.preventDefault();
      dragging = true;
      panelDivider.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    document.querySelectorAll('.layout-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => setBrowserLayout(btn.dataset.layout));
    });

    restorePanelsBtn?.addEventListener('click', () => setBrowserLayout('expanded'));
  }

  // ─── DuckDuckGo search + AI answers + embedded browser ───
  function initBrowser() {
    initPanelResize();
    if (!searchWebview || searchWebview._bound) return;
    searchWebview._bound = true;

    searchWebview.addEventListener('did-start-loading', updateBrowserNav);
    searchWebview.addEventListener('did-stop-loading', () => {
      updateBrowserNav();
      if (searchWebview.getURL) {
        currentBrowserUrl = searchWebview.getURL();
        if (browserUrl) browserUrl.textContent = currentBrowserUrl;
      }
    });
    searchWebview.addEventListener('did-navigate', (e) => {
      currentBrowserUrl = e.url;
      if (browserUrl) browserUrl.textContent = e.url;
      updateBrowserNav();
    });
    searchWebview.addEventListener('did-navigate-in-page', (e) => {
      currentBrowserUrl = e.url;
      if (browserUrl) browserUrl.textContent = e.url;
      updateBrowserNav();
    });
    searchWebview.addEventListener('new-window', (e) => {
      e.preventDefault();
      openInBrowser(e.url);
    });
    searchWebview.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3 || e.validatedURL === 'about:blank') return;
      if (browserUrl) browserUrl.textContent = `Failed to load — ${e.errorDescription || 'error'}`;
    });

    document.getElementById('browser-back')?.addEventListener('click', () => {
      if (searchWebview.canGoBack()) searchWebview.goBack();
    });
    document.getElementById('browser-forward')?.addEventListener('click', () => {
      if (searchWebview.canGoForward()) searchWebview.goForward();
    });
    document.getElementById('browser-reload')?.addEventListener('click', () => searchWebview.reload());
    document.getElementById('browser-external')?.addEventListener('click', () => {
      if (currentBrowserUrl) window.spotlightAPI.openResultUrl(currentBrowserUrl);
    });
    document.getElementById('browser-close')?.addEventListener('click', closeBrowser);
  }

  function updateBrowserNav() {
    const back = document.getElementById('browser-back');
    const fwd = document.getElementById('browser-forward');
    if (back) back.disabled = !searchWebview?.canGoBack?.();
    if (fwd) fwd.disabled = !searchWebview?.canGoForward?.();
  }

  function openInBrowser(url) {
    if (!url || !searchWebview) return;
    initBrowser();
    browserSection?.classList.add('visible');
    searchSplitContainer?.classList.add('browser-open');
    setBrowserLayout(browserLayoutMode === 'stacked' ? 'expanded' : browserLayoutMode);

    currentBrowserUrl = url;
    if (browserUrl) browserUrl.textContent = url;
    if (typeof searchWebview.loadURL === 'function') {
      searchWebview.loadURL(url);
    } else {
      searchWebview.src = url;
    }
    searchResults.querySelectorAll('.search-result').forEach((el) => {
      el.classList.toggle('active', el.dataset.url === url);
    });
  }

  function closeBrowser() {
    browserSection?.classList.remove('visible');
    searchSplitContainer?.classList.remove('browser-open');
    searchBody?.classList.remove('show-restore');
    searchResults.querySelectorAll('.search-result.active').forEach((el) => el.classList.remove('active'));
    if (searchWebview) {
      if (typeof searchWebview.loadURL === 'function') searchWebview.loadURL('about:blank');
      else searchWebview.src = 'about:blank';
    }
    currentBrowserUrl = '';
    if (browserUrl) browserUrl.textContent = '';
    browserLayoutMode = 'stacked';
    searchSplitContainer?.classList.remove('layout-stacked', 'layout-split', 'layout-expanded', 'layout-fullscreen');
    document.querySelectorAll('.layout-mode-btn').forEach((btn) => btn.classList.remove('active'));
    if (currentMode === 'search') {
      window.spotlightAPI.resize({ width: screenLayout.width || 380, height: screenLayout.maxHeight || 720 });
    }
  }

  function renderAiAnswer(data) {
    if (!aiAnswerContainer) return;
    const answerText = data.aiSummary || data.aiAnswer?.text;
    if (!answerText) {
      aiAnswerContainer.innerHTML = '';
      return;
    }

    const sources = data.aiAnswer?.sources || [];
    const sourceUrl = data.aiAnswer?.sourceUrl;
    const label = data.aiSummary ? 'AI Summary' : 'Instant Answer';

    aiAnswerContainer.innerHTML = `
      <div class="ai-answer-card">
        <div class="ai-answer-label"><span class="ai-dot"></span>${escapeHtml(label)}</div>
        <div class="ai-answer-text collapsed" id="ai-answer-text">${escapeHtml(answerText)}</div>
        <div class="ai-answer-sources" id="ai-answer-sources">
          ${sourceUrl ? `<button type="button" class="ai-source-link" data-url="${escapeAttr(sourceUrl)}">${escapeHtml(data.aiAnswer?.source || 'Source')}</button>` : ''}
          ${sources.map((s) => `<button type="button" class="ai-source-link" data-url="${escapeAttr(s.url)}">${escapeHtml(s.title)}</button>`).join('')}
        </div>
        <button type="button" class="ai-answer-toggle" id="ai-answer-toggle">Show more &amp; sources</button>
      </div>`;

    const textEl = document.getElementById('ai-answer-text');
    const sourcesEl = document.getElementById('ai-answer-sources');
    const toggle = document.getElementById('ai-answer-toggle');
    let expanded = false;

    toggle?.addEventListener('click', () => {
      expanded = !expanded;
      textEl?.classList.toggle('collapsed', !expanded);
      sourcesEl?.classList.toggle('visible', expanded);
      toggle.textContent = expanded ? 'Show less' : 'Show more & sources';
    });

    aiAnswerContainer.querySelectorAll('.ai-source-link').forEach((btn) => {
      btn.addEventListener('click', () => openInBrowser(btn.dataset.url));
    });
  }

  async function runWebSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    recentSearches = [query, ...recentSearches.filter((q) => q !== query)].slice(0, 8);
    renderRecent();
    closeBrowser();

    if (aiAnswerContainer) aiAnswerContainer.innerHTML = '';
    searchResults.innerHTML = '<div class="panel-status">Searching…</div>';

    const data = await window.spotlightAPI.webSearch(query);
    const results = Array.isArray(data) ? data : (data.results || []);

    renderAiAnswer(data);

    if (!results.length) {
      searchResults.innerHTML = '<div class="panel-status">No web results found. Try different keywords.</div>';
      return;
    }

    searchResults.innerHTML = `<div class="section-label">Web Results</div>` + results.map((r, i) => `
      <button type="button" class="search-result" data-url="${escapeAttr(r.url)}" data-idx="${i}">
        <div class="search-result-title">${escapeHtml(r.title)}</div>
        <div class="search-result-snippet">${escapeHtml(r.snippet || '')}</div>
        <div class="search-result-url">${escapeHtml(r.url)}</div>
      </button>
    `).join('');

    searchResults.querySelectorAll('.search-result').forEach((btn) => {
      btn.addEventListener('click', () => openInBrowser(btn.dataset.url));
    });
  }

  function renderRecent() {
    if (!recentSearches.length) {
      recentList.innerHTML = '<p style="font-size:11px;color:var(--text-muted);padding:4px 0">No recent searches</p>';
      return;
    }
    recentList.innerHTML = recentSearches.map((q, i) => `
      <button type="button" class="recent-item" data-idx="${i}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        ${escapeHtml(q)}
      </button>
    `).join('');
    recentList.querySelectorAll('.recent-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        searchInput.value = recentSearches[parseInt(btn.dataset.idx, 10)];
        runWebSearch();
      });
    });
  }

  function iconCopy() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  }
  function iconRefresh() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
  }

  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  document.addEventListener('keydown', (e) => {
    if (currentMode === 'thought') return;
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const idx = MODES.indexOf(currentMode);
      setMode(MODES[(idx + 1) % MODES.length]);
    }
    if (e.ctrlKey && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      setMode(MODES[parseInt(e.key, 10) - 1]);
    }
    if (e.key === 'Escape') {
      if (currentMode === 'search' && browserLayoutMode === 'fullscreen' && browserSection?.classList.contains('visible')) {
        setBrowserLayout('expanded');
        return;
      }
      window.spotlightAPI.close();
    }
  });

  renderRecent();
  setMode('thought');
})();
