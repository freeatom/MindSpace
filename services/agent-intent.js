/**
 * Agent Intent Detection — multi-stage pipeline for figuring out what the
 * user actually wants and which tools the agent should consider.
 *
 * Stage 1 — REGEX  : fast classification of obvious intents
 * Stage 2 — HEURISTIC: small pattern checks (question vs command vs chat)
 * Stage 3 — PLAN HINT: produce a "hints" object that gets injected into the
 *                       system prompt so the LLM knows which tools to prefer.
 *
 * This is NOT meant to hard-route the LLM — it's a context-augmenter.
 * The LLM still has full tool access; we just steer it.
 */

const CALENDAR_TRIGGERS = [
  /\b(schedule|book|add|set up|setup|create)\b.*\b(meeting|meet|call|event|appointment|reminder)\b/i,
  /\bcalendar\b/i,
  /\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/i,
  /\b(tomorrow|today|tonight|next\s+(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week))\b/i,
];

const CANCEL_TRIGGERS = [
  /\b(cancel|delete|remove|drop|kill)\b.*\b(meeting|event|appointment|call|reminder)\b/i,
  /\bcancel\s+my\b/i,
];

const THOUGHT_TRIGGERS = [
  /\bremind me\b/i,
  /\bremember\b/i,
  /\bnote to self\b/i,
  /\bcapture\b/i,
  /\bsave this thought\b/i,
];

const SEARCH_TRIGGERS = [
  /^what('s| is)\s+on\s+my\s+(calendar|schedule|agenda)/i,
  /\b(show|list|find|search)\b.*\b(thoughts|notes|events|meetings)\b/i,
  /\bdo i have\b/i,
];

const NOTE_TRIGGERS = [
  /\b(create|write|save|start)\b.*\b(note|doc|document)\b/i,
];

const FINISH_TRIGGERS = [
  /\b(mark|set)\b.*\b(done|finished|complete|completed)\b/i,
  /\bi('m| am) done with\b/i,
  /\bfinish\b/i,
];

const PROFILE_LEARN_TRIGGERS = [
  /\bi('m| am)\s+([a-z][a-z\s'.-]{1,40})/i,
  /\bi work (on|at|for)\b/i,
  /\bmy (name|company|team|project|role)\b/i,
  /\bi (like|prefer|hate|love|use)\b/i,
];

/**
 * Analyze a user message and return a structured intent profile.
 * Returned object is fed to the LLM as a "steering hint".
 */
function analyzeIntent(text) {
  const t = (text || '').trim();
  if (!t) return { primary: 'chat', confidence: 0, hints: { tools: [], style: 'conversational' } };

  const lower = t.toLowerCase();
  const scores = {
    calendar: 0,
    cancel: 0,
    thought: 0,
    search: 0,
    note: 0,
    finish: 0,
    learn: 0,
    web: 0,
    chat: 1, // baseline
  };

  for (const re of CALENDAR_TRIGGERS) if (re.test(t)) scores.calendar += 2;
  for (const re of CANCEL_TRIGGERS) if (re.test(t)) scores.cancel += 3;
  for (const re of THOUGHT_TRIGGERS) if (re.test(t)) scores.thought += 2;
  for (const re of SEARCH_TRIGGERS) if (re.test(t)) scores.search += 3;
  for (const re of NOTE_TRIGGERS) if (re.test(t)) scores.note += 3;
  for (const re of FINISH_TRIGGERS) if (re.test(t)) scores.finish += 2;
  for (const re of PROFILE_LEARN_TRIGGERS) if (re.test(t)) scores.learn += 2;
  if (/\b(search|google|look up|what is|who is|how to)\b/i.test(t)) scores.web += 2;
  if (/\?$/.test(t) && scores.search < 2 && scores.calendar < 2) scores.search += 1;

  // Pick top intent (excluding baseline chat)
  const entries = Object.entries(scores).filter(([k]) => k !== 'chat');
  entries.sort((a, b) => b[1] - a[1]);
  const [topKey, topScore] = entries[0] || ['chat', 0];

  let primary = 'chat';
  if (topScore >= 2) primary = topKey;

  // Build tool hints
  const hints = { tools: [], style: 'conversational', reasoning: '' };

  if (primary === 'calendar') {
    hints.tools = ['schedule_meeting', 'create_thought', 'get_calendar_events'];
    hints.style = 'action';
    hints.reasoning = 'User wants to schedule a meeting. Remember to ALSO create a canvas thought reminder.';
  } else if (primary === 'cancel') {
    hints.tools = ['search_calendar_events', 'cancel_meeting'];
    hints.style = 'action';
    hints.reasoning = 'User wants to cancel. Find the right event first, then cancel (which auto-deletes the linked thought).';
  } else if (primary === 'thought') {
    hints.tools = ['create_thought'];
    hints.style = 'action';
    hints.reasoning = 'User wants to capture a thought/reminder.';
  } else if (primary === 'search') {
    hints.tools = ['get_calendar_events', 'search_thoughts', 'read_notes'];
    hints.style = 'answer';
    hints.reasoning = 'User is asking about their data. Query the relevant tool(s) and answer concisely.';
  } else if (primary === 'note') {
    hints.tools = ['create_note'];
    hints.style = 'action';
    hints.reasoning = 'User wants to save something as a long-form note.';
  } else if (primary === 'finish') {
    hints.tools = ['search_thoughts', 'finish_thought', 'update_thought'];
    hints.style = 'action';
    hints.reasoning = 'User wants to mark something as done. If it\'s linked to a calendar event, the event will cascade to completed.';
  } else if (primary === 'learn') {
    hints.tools = ['learn_facts', 'update_scratchpad'];
    hints.style = 'action+memory';
    hints.reasoning = 'User is sharing info about themselves. Use learn_facts to store it in the knowledge graph.';
  } else if (primary === 'web') {
    hints.tools = ['web_search'];
    hints.style = 'answer';
    hints.reasoning = 'User wants a web search.';
  }

  return {
    primary,
    confidence: Math.min(1, topScore / 4),
    hints,
    scores,
  };
}

/**
 * Build the "intent hint" block that gets prepended to the system prompt.
 * Tells the LLM what we think the user wants and which tools to prefer.
 */
function buildIntentHint(text) {
  const intent = analyzeIntent(text);
  if (intent.primary === 'chat') return { text: '', intent };

  return {
    text: [
      '--- INTENT HINTS (soft steering, not hard rules) ---',
      `Detected primary intent: ${intent.primary} (confidence ${intent.confidence.toFixed(2)})`,
      intent.hints.reasoning ? `Hint: ${intent.hints.reasoning}` : '',
      intent.hints.tools.length ? `Preferred tools for this turn: ${intent.hints.tools.join(', ')}` : '',
      `Style: ${intent.hints.style}`,
      '(You may still use other tools if needed; this is just a steer.)',
    ].filter(Boolean).join('\n'),
    intent,
  };
}

module.exports = {
  analyzeIntent,
  buildIntentHint,
  CALENDAR_TRIGGERS,
  CANCEL_TRIGGERS,
  THOUGHT_TRIGGERS,
  SEARCH_TRIGGERS,
  NOTE_TRIGGERS,
  FINISH_TRIGGERS,
};
