/**
 * MindSpace Spotlight — full thought capture, AI search, embedded browser
 */
(function () {
  const MODES = ['thought', 'chat', 'search', 'notes'];

  const thoughtInput = document.getElementById('thought-input');
  const thoughtGhost = document.getElementById('thought-ghost');
  const thoughtType = document.getElementById('thought-type');
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
  const notesArea = document.getElementById('notes-textarea');
  const notesNameInput = document.getElementById('notes-name-input');
  const notesSaveBtn = document.getElementById('notes-save-btn');
  const notesStatus = document.getElementById('notes-status');

  const modelLabel = document.getElementById('model-label');
  const apiDot = document.getElementById('api-dot');

  // Thought form controls
  const thoughtSaveBtn = document.getElementById('thought-save');
  const thoughtClearBtn = document.getElementById('thought-clear');
  const thoughtStatus = document.getElementById('thought-status');
  const slDateRow = document.getElementById('sl-date-row');
  const slExpiresInput = document.getElementById('sl-expires-input');
  const slCalendarHint = document.getElementById('sl-calendar-hint');
  const slTagList = document.getElementById('sl-tag-list');

  let currentMode = 'thought';
  let pastedImage = null;
  let loadedWorkflows = [];
  let currentWorkflowMatch = null;
  let localFileResults = [];
  let selectedFileIndex = -1;
  let searchTimeout = null;
  let notesSaveTimeout = null;
  let recentSearches = [];
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

  // Chat session management
  let currentSessionId = null;
  let sessionCreatedAt = null;
  const chatSessionTitle = document.getElementById('chat-session-title');
  const chatHistoryPanel = document.getElementById('chat-history-panel');
  const chatHistoryList = document.getElementById('chat-history-list');
  const chatNewBtn = document.getElementById('chat-new-btn');
  const chatHistoryBtn = document.getElementById('chat-history-btn');
  const chatHistoryClose = document.getElementById('chat-history-close');

  // Thought form state
  let selectedPriority = 'medium';
  let selectedPersistence = 'persistent';
  let selectedTags = [];
  let allTags = [];
  let tagsLoaded = false;

  const CHAT_SYSTEM = `You are MindSpace, a helpful AI assistant. Be concise and clear.`;

  // Generate a unique session ID — works in non-secure contexts (file:// protocol)
  function generateSessionId() {
    const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
  }

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

  async function loadTagsLazy() {
    if (tagsLoaded) return;
    tagsLoaded = true;
    try {
      allTags = await window.spotlightAPI.getTags();
      renderTagSelector();
    } catch (e) {
      allTags = [];
      renderTagSelector();
    }
  }

  function renderTagSelector() {
    if (!slTagList) return;
    if (!allTags.length) {
      slTagList.innerHTML = '<span style="font-size:10px;color:var(--text-muted)">No tags yet</span>';
      return;
    }
    slTagList.innerHTML = allTags.map((tag) => {
      const isSelected = selectedTags.includes(tag.name);
      const bgColor = tag.color?.bg || 'var(--bg-surface)';
      const textColor = tag.color?.text || 'var(--text-sub)';
      return `<button type="button" class="sl-tag-pill ${isSelected ? 'selected' : ''}"
        data-name="${escapeAttr(tag.name)}"
        style="${isSelected ? '' : `background:${bgColor};color:${textColor}`}"
        >${escapeHtml(tag.name)}</button>`;
    }).join('');

    slTagList.querySelectorAll('.sl-tag-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const name = pill.dataset.name;
        if (selectedTags.includes(name)) {
          selectedTags = selectedTags.filter((t) => t !== name);
        } else {
          selectedTags.push(name);
        }
        renderTagSelector();
      });
    });
  }

  const spotlightShell = document.querySelector('.spotlight-shell');

  function onSpotlightShown() {
    loadBackgroundData();
    // Trigger the entrance transition: shell starts at opacity:0/translateX(8px)
    // and transitions to visible state
    if (spotlightShell) {
      // Force a reflow so the transition always fires (even on re-show)
      spotlightShell.classList.remove('visible');
      void spotlightShell.offsetWidth;
      spotlightShell.classList.add('visible');
    }
    // Always update window size for the current mode
    updateWindowSize();
    if (currentMode === 'thought') {
      loadTagsLazy();
      thoughtInput?.focus();
    } else if (currentMode === 'chat') chatInput?.focus();
    else if (currentMode === 'search') searchInput?.focus();
    else if (currentMode === 'notes') {
      loadNotesLazy();
      notesArea?.focus();
    }
  }

  function onSpotlightHidden() {
    // Remove visible class so next show triggers the entrance transition
    if (spotlightShell) spotlightShell.classList.remove('visible');
    closeBrowser();
  }

  updateWindowSize();
  window.spotlightAPI.getLayout().then((layout) => {
    screenLayout = layout;
    updateWindowSize();
  });
  window.spotlightAPI.onShown(() => onSpotlightShown());
  window.spotlightAPI.onHidden(() => onSpotlightHidden());
  window.spotlightAPI.onChatChunk(({ chunk }) => appendStreamingChunk(chunk));

  // ─── Whispr (Speech-to-Text) ───
  const whisprBtn = document.getElementById('whispr-btn');
  let whisprMediaRecorder = null;
  let whisprChunks = [];
  let whisprStream = null;

  function getActiveInput() {
    if (currentMode === 'thought') return thoughtInput;
    if (currentMode === 'chat') return chatInput;
    if (currentMode === 'search') return searchInput;
    if (currentMode === 'notes') return notesArea;
    return null;
  }

  async function startWhisprRecording() {
    try {
      whisprStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      whisprChunks = [];

      // Use webm/opus which Groq Whisper API accepts
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      whisprMediaRecorder = new MediaRecorder(whisprStream, { mimeType });
      whisprMediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) whisprChunks.push(e.data);
      };
      whisprMediaRecorder.start(250); // Collect chunks every 250ms
      whisprBtn?.classList.add('recording');
    } catch (err) {
      console.error('Whispr mic access failed:', err);
      whisprBtn?.classList.remove('recording');
    }
  }

  async function stopWhisprRecording() {
    if (!whisprMediaRecorder || whisprMediaRecorder.state === 'inactive') {
      whisprBtn?.classList.remove('recording');
      return;
    }

    return new Promise((resolve) => {
      whisprMediaRecorder.onstop = async () => {
        whisprBtn?.classList.remove('recording');

        // Stop mic stream
        if (whisprStream) {
          whisprStream.getTracks().forEach((t) => t.stop());
          whisprStream = null;
        }

        if (whisprChunks.length === 0) {
          resolve();
          return;
        }

        const blob = new Blob(whisprChunks, { type: 'audio/webm' });
        whisprChunks = [];

        // Send audio to main process for transcription
        // Main.js handles routing the result to the correct target
        const arrayBuffer = await blob.arrayBuffer();
        const result = await window.spotlightAPI.whisprTranscribe(arrayBuffer);

        if (result?.error) {
          console.error('Whispr error:', result.error);
        }

        resolve();
      };

      whisprMediaRecorder.stop();
    });
  }

  function insertTranscription(text) {
    const input = getActiveInput();
    if (!input) return;

    // Insert at cursor position or append
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.substring(0, start);
    const after = input.value.substring(end);
    const spacer = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : '';
    input.value = before + spacer + text + after;
    input.focus();

    // Move cursor to end of inserted text
    const newPos = start + spacer.length + text.length;
    input.selectionStart = newPos;
    input.selectionEnd = newPos;

    // Trigger input event so UI updates (e.g. thought type detection)
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Listen for toggle from main process (Alt+` shortcut)
  window.spotlightAPI.onWhisprToggle(async (recording) => {
    if (recording) {
      await startWhisprRecording();
    } else {
      await stopWhisprRecording();
    }
  });

  // Listen for transcription results routed by main.js
  window.spotlightAPI.onWhisprResult((result) => {
    if (result?.text) {
      insertTranscription(result.text);
    }
  });

  // Button click in spotlight
  whisprBtn?.addEventListener('click', () => {
    window.spotlightAPI.whisprToggleFromRenderer();
  });

  // Preload workflows while window is hidden
  setTimeout(loadBackgroundData, 0);

  modeTabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

  // ─── Thought form controls ───
  thoughtClearBtn?.addEventListener('click', () => {
    thoughtInput.value = '';
    pastedImage = null;
    thoughtType.textContent = 'Thought';
    selectedPriority = 'medium';
    selectedPersistence = 'persistent';
    selectedTags = [];

    // Reset priority buttons
    document.querySelectorAll('.sl-priority-btn').forEach((b) => b.classList.remove('active'));
    document.querySelector('.sl-priority-btn[data-priority="medium"]')?.classList.add('active');

    // Reset persistence buttons
    document.querySelectorAll('.sl-persist-btn').forEach((b) => b.classList.remove('active'));
    document.querySelector('.sl-persist-btn[data-persist="persistent"]')?.classList.add('active');
    slDateRow.style.display = 'none';
    slExpiresInput.value = '';
    slCalendarHint?.classList.remove('visible');

    renderTagSelector();
    if (thoughtStatus) thoughtStatus.textContent = '';
  });

  // Priority buttons
  document.querySelectorAll('.sl-priority-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sl-priority-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPriority = btn.dataset.priority;
    });
  });

  // Persistence buttons
  document.querySelectorAll('.sl-persist-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sl-persist-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPersistence = btn.dataset.persist;
      slDateRow.style.display = btn.dataset.persist === 'until_date' ? 'flex' : 'none';
      // Show calendar hint for time-bound thoughts
      const showCal = btn.dataset.persist === 'today' || btn.dataset.persist === 'until_date';
      slCalendarHint?.classList.toggle('visible', showCal);
    });
  });

  // Save thought button
  thoughtSaveBtn?.addEventListener('click', () => saveThought());

  // Ctrl+Enter to save
  thoughtInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveThought();
      return;
    }
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
  });

  thoughtInput?.addEventListener('input', handleThoughtInput);

  async function saveThought() {
    const val = thoughtInput.value.trim();
    if (!val && !pastedImage) {
      if (thoughtStatus) thoughtStatus.textContent = 'Enter a thought first';
      thoughtInput?.focus();
      return;
    }

    thoughtSaveBtn.disabled = true;
    if (thoughtStatus) thoughtStatus.textContent = 'Saving…';

    try {
      // Check for calendar-like commands
      if (isCalendarLike(val)) {
        const prefill = await window.spotlightAPI.parseCalendarCommand(val);
        window.spotlightAPI.openCalendar(prefill || {});
        window.spotlightAPI.close();
        return;
      }

      // Check for URL — archive it
      const isUrl = /^https?:\/\//i.test(val);
      if (pastedImage || isUrl) {
        window.spotlightAPI.saveArchive({
          title: val || 'Quick Capture',
          content: val,
          images: pastedImage ? [pastedImage] : [],
          tags: selectedTags.length ? selectedTags : ['spotlight'],
        });
        window.spotlightAPI.close();
        return;
      }

      // Build expiry
      let expiresAt = null;
      if (selectedPersistence === 'until_date') {
        const dateVal = slExpiresInput.value;
        if (dateVal) {
          expiresAt = new Date(dateVal).toISOString();
        }
      }

      // Save thought
      const thoughtData = {
        content: val,
        priority: selectedPriority,
        persistence: selectedPersistence,
        expiresAt,
        tags: selectedTags.length ? selectedTags : ['spotlight'],
      };

      // Create calendar event for time-bound thoughts
      if (selectedPersistence === 'today' || selectedPersistence === 'until_date') {
        try {
          const result = await window.spotlightAPI.createCalendarFromThought({
            content: val,
            priority: selectedPriority,
            persistence: selectedPersistence,
            expiresAt,
          });
          if (result?.calendarEventId) {
            thoughtData.calendarEventId = result.calendarEventId;
          }
        } catch (calErr) {
          console.error('Calendar linking failed:', calErr);
        }
      }

      window.spotlightAPI.saveThought(thoughtData);
      window.spotlightAPI.close();
    } catch (err) {
      if (thoughtStatus) thoughtStatus.textContent = 'Error: ' + err.message;
      console.error(err);
    } finally {
      thoughtSaveBtn.disabled = false;
    }
  }

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
          thoughtInput.placeholder = 'Image captured — add a note or press Ctrl+Enter';
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

    // All modes are now full-height panels
    window.spotlightAPI.setPanelOpen(true);
    updateWindowSize();

    if (mode === 'thought') {
      loadTagsLazy();
      thoughtInput.focus();
    }
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
    // All modes are now full height
    const height = maxH;
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

    if (!val) {
      thoughtType.textContent = 'Thought';
      fileResults.classList.remove('visible');
      fileResults.innerHTML = '';
      return;
    }

    if (val.toLowerCase().startsWith('find: ')) {
      thoughtType.textContent = 'File';
      const query = val.substring(6).trim();
      clearTimeout(searchTimeout);
      if (!query) {
        fileResults.classList.remove('visible');
        return;
      }
      fileResults.innerHTML = '<div class="panel-status">Searching…</div>';
      fileResults.classList.add('visible');
      searchTimeout = setTimeout(async () => {
        localFileResults = await window.spotlightAPI.searchLocalFiles(query);
        selectedFileIndex = -1;
        renderFileResults();
      }, 400);
      return;
    }

    fileResults.classList.remove('visible');

    if (trimVal.length > 0) {
      const match = loadedWorkflows.find((w) => w.name.toLowerCase().startsWith(trimVal.toLowerCase()));
      if (match) {
        currentWorkflowMatch = match;
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

    // Create a new session if none exists
    if (!currentSessionId) {
      currentSessionId = generateSessionId();
      sessionCreatedAt = new Date().toISOString();
    }

    chatHistory.push({ role: 'user', content: text });
    appendUserMessage(text);
    chatInput.value = '';
    chatChips.classList.add('hidden');
    chatStreaming = true;
    chatSend.disabled = true;

    // Update title from first user message
    if (chatHistory.filter((m) => m.role === 'user').length === 1) {
      const title = text.length > 40 ? text.substring(0, 40) + '…' : text;
      if (chatSessionTitle) chatSessionTitle.textContent = title;
    }

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

      // Auto-save session after each successful exchange
      autoSaveSession();
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

  // ─── Chat session management ───
  function autoSaveSession() {
    if (!currentSessionId || chatHistory.length === 0) return;
    const firstUserMsg = chatHistory.find((m) => m.role === 'user');
    const preview = firstUserMsg ? firstUserMsg.content.substring(0, 60) : 'Empty chat';
    window.spotlightAPI.saveChatSession({
      _id: currentSessionId,
      messages: chatHistory.filter((m) => m.role !== 'system'),
      preview,
      createdAt: sessionCreatedAt,
    }).catch((err) => console.error('Chat save failed:', err));
  }

  function startNewChat() {
    // Save current session first if it has messages
    if (currentSessionId && chatHistory.length > 0) {
      autoSaveSession();
    }
    currentSessionId = null;
    sessionCreatedAt = null;
    chatHistory = [];
    chatMessages.innerHTML = '';
    if (chatSessionTitle) chatSessionTitle.textContent = 'New chat';
    updateChatChipsVisibility();
    chatInput.value = '';
    chatInput.focus();
    closeChatHistory();
  }

  async function loadChatSession(sessionId) {
    try {
      const sessions = await window.spotlightAPI.getChatSessions();
      const session = sessions.find((s) => s._id === sessionId);
      if (!session) return;

      currentSessionId = session._id;
      sessionCreatedAt = session.createdAt;
      chatHistory = session.messages || [];

      // Re-render messages
      chatMessages.innerHTML = '';
      chatHistory.forEach((msg) => {
        if (msg.role === 'user') {
          appendUserMessage(msg.content);
        } else if (msg.role === 'assistant') {
          appendAssistantMessage(msg.content);
        }
      });

      if (chatSessionTitle) chatSessionTitle.textContent = session.preview || 'Chat';
      updateChatChipsVisibility();
      closeChatHistory();
      scrollChat();
    } catch (err) {
      console.error('Failed to load chat session:', err);
    }
  }

  async function deleteChatSession(sessionId) {
    try {
      await window.spotlightAPI.deleteChatSession(sessionId);
      // If we deleted the active session, start a new chat
      if (currentSessionId === sessionId) {
        startNewChat();
      }
      await renderChatHistoryList();
    } catch (err) {
      console.error('Failed to delete chat session:', err);
    }
  }

  async function renderChatHistoryList() {
    if (!chatHistoryList) return;
    try {
      const sessions = await window.spotlightAPI.getChatSessions();
      if (!sessions.length) {
        chatHistoryList.innerHTML = '<span class="chat-history-empty">No saved chats yet</span>';
        return;
      }
      chatHistoryList.innerHTML = sessions.map((s) => {
        const isActive = s._id === currentSessionId;
        const date = new Date(s.updatedAt || s.createdAt);
        const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
          + ' ' + date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return `<div class="chat-history-item ${isActive ? 'active' : ''}" data-id="${escapeAttr(s._id)}">
          <div class="chat-history-item-info">
            <div class="chat-history-item-preview">${escapeHtml(s.preview || 'Untitled')}</div>
            <div class="chat-history-item-date">${escapeHtml(dateStr)} · ${(s.messages || []).length} msgs</div>
          </div>
          <button type="button" class="chat-history-item-delete" data-delete="${escapeAttr(s._id)}" title="Delete">✕</button>
        </div>`;
      }).join('');

      // Bind click to load, delete to remove
      chatHistoryList.querySelectorAll('.chat-history-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          if (e.target.closest('.chat-history-item-delete')) return;
          loadChatSession(item.dataset.id);
        });
      });
      chatHistoryList.querySelectorAll('.chat-history-item-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteChatSession(btn.dataset.delete);
        });
      });
    } catch (err) {
      chatHistoryList.innerHTML = '<span class="chat-history-empty">Failed to load</span>';
    }
  }

  function toggleChatHistory() {
    const isOpen = chatHistoryPanel?.classList.contains('open');
    if (isOpen) {
      closeChatHistory();
    } else {
      chatHistoryPanel?.classList.add('open');
      renderChatHistoryList();
    }
  }

  function closeChatHistory() {
    chatHistoryPanel?.classList.remove('open');
  }

  // Wire up chat toolbar buttons
  chatNewBtn?.addEventListener('click', startNewChat);
  chatHistoryBtn?.addEventListener('click', toggleChatHistory);
  chatHistoryClose?.addEventListener('click', closeChatHistory);

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
    // Escape always works regardless of mode or focus
    if (e.key === 'Escape') {
      if (currentMode === 'search' && browserLayoutMode === 'fullscreen' && browserSection?.classList.contains('visible')) {
        setBrowserLayout('expanded');
        return;
      }
      window.spotlightAPI.close();
      return;
    }
    // Ctrl+number shortcuts work in all modes
    if (e.ctrlKey && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      setMode(MODES[parseInt(e.key, 10) - 1]);
      return;
    }
    // Tab to cycle modes — skip when thought textarea is focused to not interfere with typing
    if (e.key === 'Tab' && !e.shiftKey) {
      if (currentMode === 'thought' && document.activeElement === thoughtInput) return;
      e.preventDefault();
      const idx = MODES.indexOf(currentMode);
      setMode(MODES[(idx + 1) % MODES.length]);
    }
  });

  // Ensure clicking ANYWHERE in the spotlight gives the window keyboard focus
  // so Escape and shortcuts always work — even on non-interactive areas
  document.body.tabIndex = -1;
  document.addEventListener('mousedown', () => {
    // If nothing focusable was clicked, focus the body so keydown events fire
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.documentElement) {
        document.body.focus({ preventScroll: true });
      }
    });
  });

  renderRecent();
  setMode('thought');
})();
