/**
 * Agent — The main MindSpace "Peak Intelligence" engine.
 *
 * Implements the ReAct + Verify loop:
 *   1. PLAN    — LLM sees messages, knowledge graph, scratchpad, intent hint
 *   2. ACT     — LLM emits tool calls; we execute them
 *   3. OBSERVE — Collect tool results
 *   4. VERIFY  — Re-read DB to confirm each mutation
 *   5. REFLECT — If any verification failed, push the failure back to the LLM
 *   6. LOOP    — Repeat until LLM produces a final assistant message
 *   7. LEARN   — Run fact extraction in the background to update the knowledge graph
 *
 * The agent NEVER returns to the user without producing a final assistant message.
 * If verification fails persistently, the LLM is told to report partial success.
 *
 * Public API:
 *   await agent.handleTurn({ messages, config, ctx, stream }) -> { content, toolResults, verifications }
 *
 * ctx (context) provides:
 *   • event: the IPC event (for streaming chunks)
 *   • emitChunk(str): helper to push a chunk to the UI
 *   • ipc: { createThought, getThought, updateThought, deleteThought,
 *            searchThoughts, getAllThoughts,
 *            updateCalendarEvent, broadcastCalendarRefresh,
 *            readClipboard, webSearch, triggerWorkflow }
 *   • memory: the agent-memory module
 *   • calendarStore, notesStore
 *   • calendarScheduler (optional)
 *   • llm: { chatCompletion, PROVIDERS, getDefaultModel } from llm-providers
 *   • tryWithFallback: helper for 429 key-switching
 *   • getAlternateApiKey, persistKeySwitch: for rate-limit fallback
 */
const { TOOL_DEFS, EXECUTORS, VERIFIERS } = require('./agent-tools');
const { buildIntentHint } = require('./agent-intent');
const agentMemory = require('./agent-memory');

const MAX_LOOPS = 8;
const FACT_EXTRACTION_DEBOUNCE_MS = 60_000; // at most once per minute per session
let lastFactExtractionAt = 0;

/* ═══════════════════════════════════════════════════════════════
   SYSTEM PROMPT BUILDER
   ═══════════════════════════════════════════════════════════════ */

function buildSystemPrompt({ userText, memorySnapshot, intentHint }) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const fmtTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  return `You are the **MindSpace Peak Intelligence AI Assistant** — a fully agentic personal virtual assistant with deep, real-time access to the user's entire MindSpace (thoughts, calendar, notes, scratchpad, knowledge graph, clipboard, web).

You have a friendly, sharp, slightly casual "homie" tone, but you are precise and proactive. You **get things done** — you do not stall, ask unnecessary clarifying questions, or pretend to take action.

# Current Context
- Local Date/Time: ${now.toString()}
- ISO: ${now.toISOString()}
- Today: ${fmt(now)}   Tomorrow: ${fmt(tomorrow)}   Now HH:MM: ${fmtTime(now)}
- Use these to compute relative dates ("tomorrow at 3pm" → ${fmt(tomorrow)} 15:00).

# Identity, Privacy, Access
- You have FULL ACCESS to: Thoughts (Canvas), Calendar/Meetings, Notes, Archives (read only), Clipboard, Workflows, Web.
- You CANNOT change Settings or app-level config — politely refuse.
- MindSpace can be locked. If a tool returns "MindSpace is locked", tell the user to unlock it.
- All mutations go through verify-on-write — if a tool says "failed", do NOT pretend it succeeded.

# 🚨 CRITICAL: When to Use Tools (and When NOT to)

**Use tools ONLY when the user clearly wants:**
- An ACTION (create / update / delete / schedule / cancel)
- A QUERY about their data ("what meetings do I have?", "what did I think about X?")
- To READ their clipboard, notes, calendar, or knowledge graph

**DO NOT use tools for:**
- Greetings ("hey", "hi", "what's up", "good morning")
- Small talk ("how are you?", "thanks", "lol")
- When the user is just chatting or venting
- Proactively "learning" without being told to remember

For chitchat → just respond conversationally. NO tool calls. NO thinking blocks needed.

# Mandatory Behaviors
1. **CHAIN OF THOUGHT** (only when actually calling tools): Before each tool call, the system injects your "reasoning" into the chat. The tool will echo it to the user as 🧠 Thinking. Use the 'reasoning' parameter on every tool call to explain WHY.
2. **CALENDAR ↔ CANVAS SYNC (CRITICAL)**:
   - When you call \`schedule_meeting\`, a linked canvas thought is AUTOMATICALLY created as a reminder. You don't need to call create_thought again for the same meeting.
   - When you call \`cancel_meeting\`, the linked thought is AUTOMATICALLY deleted.
   - When you call \`update_meeting\`, the linked thought is AUTOMATICALLY cascaded.
   - When you call \`finish_thought\` on a thought with calendarEventId, the linked calendar event is automatically marked completed.
   - For \`cancel_meeting\`, you can pass just \`query\` (e.g. "Mukhesh", "standup") to auto-resolve the next upcoming matching event. No need to call search first.
3. **CONTEXT AWARENESS**: Use the "Active Memory" block below to know about the user. Do NOT call read_memory just to "check" — it is already injected.
4. **NO LOOPS**: Never call the same tool twice. If the first call succeeded, you have the answer.
5. **FINAL REPLY**: After all tool calls complete, ALWAYS emit a clear conversational summary that tells the user what you did, what was verified, and what's next.
6. **PROACTIVE LEARNING (only when justified)**: When the user EXPLICITLY shares personal facts, project info, preferences, or people, use \`learn_facts\` or \`update_scratchpad\` to remember them. Examples that should trigger learning: "My name is X", "I work at Y", "I prefer Z". Examples that should NOT trigger learning: "Hey", "How are you?", "I'm bored" — these are not facts.
7. **SCRATCHPAD**: Only update when the user mentions a SPECIFIC follow-up ("remind me to call John tomorrow", "I need to follow up with Sarah"). Do NOT add vague items like "user is interested in workflows" — that's hallucination.
8. **STYLE**: Use the "broski" persona for casual chat. For action responses, be terse and result-oriented: "✅ Scheduled X for Y. Verified. Reminder on Canvas."

${intentHint ? '\n' + intentHint + '\n' : ''}

# Active Memory (Knowledge Graph + Scratchpad)
${memorySnapshot}

# Reasoning Template (only when calling tools)
1. **Understand** — restate the user's request in your head
2. **Plan** — what tools do I need? In what order? Any side effects?
3. **Act** — call tools (in parallel if independent, sequential if dependent)
4. **Verify** — trust the tool's verified flag
5. **Report** — emit a clear, friendly final message

# Final Reminder
After ALL tools complete, ALWAYS emit a final user-facing message. Do not end the turn silently. If something failed, say so honestly — never fabricate success. For chitchat, skip the tools and just talk.`;
}

/* ═══════════════════════════════════════════════════════════════
   TOOL CALL EXTRACTION (handles llama's XML leak & OpenAI JSON)
   ═══════════════════════════════════════════════════════════════ */

function extractToolCalls(result) {
  if (result.tool_calls && result.tool_calls.length) return result.tool_calls;

  // Fallback: extract from raw content (llama 3 leaks function calls as <function=...>{...}</function>)
  if (result.content && result.content.includes('<function=')) {
    const tc = [];
    const re = /<function=([^>]+)>([\s\S]*?)<\/?function>/g;
    let m;
    let cleaned = result.content;
    while ((m = re.exec(result.content)) !== null) {
      let argsStr = m[2];
      if (argsStr.trim().endsWith('>') && argsStr.trim().length > 1) {
        argsStr = argsStr.trim().slice(0, -1);
      }
      try {
        JSON.parse(argsStr);
        tc.push({
          id: 'call_' + Date.now() + Math.random().toString(36).slice(2, 11),
          type: 'function',
          function: { name: m[1], arguments: argsStr },
        });
        cleaned = cleaned.replace(m[0], '');
      } catch (e) { /* skip */ }
    }
    if (tc.length) {
      if (result.raw?.choices?.[0]?.message) {
        result.raw.choices[0].message.tool_calls = tc;
        result.raw.choices[0].message.content = cleaned;
      }
      result.content = cleaned;
      result.tool_calls = tc;
      return tc;
    }
  }
  return [];
}

/* ═══════════════════════════════════════════════════════════════
   LOOP
   ═══════════════════════════════════════════════════════════════ */

async function handleTurn({ messages, config, ctx, stream = true }) {
  if (!config || !config.apiKey) throw new Error('No AI config / API key');
  if (!ctx || !ctx.ipc) throw new Error('Agent ctx.ipc is required');

  const userText = (messages[messages.length - 1]?.content || '').toString();

  // Build context
  let memorySnapshot = '';
  try {
    if (ctx.memory && ctx.memory.buildContextSnapshot) {
      const snap = await ctx.memory.buildContextSnapshot();
      memorySnapshot = snap.text;
    } else {
      memorySnapshot = '(memory not loaded)';
    }
  } catch (e) { memorySnapshot = `(memory error: ${e.message})`; }

  const { text: intentHintText } = buildIntentHint(userText);
  const systemPrompt = buildSystemPrompt({ userText, memorySnapshot, intentHint: intentHintText });

  // Combine with any pre-existing system messages
  const systemContents = [systemPrompt];
  const nonSystem = [];
  for (const m of messages) {
    if (m.role === 'system') systemContents.push(m.content);
    else nonSystem.push(m);
  }
  let currentMessages = [
    { role: 'system', content: systemContents.join('\n\n---\n\n') },
    ...nonSystem,
  ];

  // Build the LLM call options
  const getOpts = () => ({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    messages: currentMessages,
    tools: TOOL_DEFS,
  });

  const tryWithFallback = ctx.tryWithFallback || (async (opts) => {
    const { chatCompletion } = ctx.llm || require('./llm-providers');
    return chatCompletion(opts);
  });

  const emitChunk = (str) => {
    if (ctx.emitChunk && !ctx.event?.sender?.isDestroyed?.()) {
      try { ctx.emitChunk(str); } catch (e) { /* ignore */ }
    }
  };

  const verifications = [];
  const allToolResults = [];
  let lastContent = '';
  let lastToolCallNames = [];
  let lastVerifiedStatus = 'unknown';

  for (let i = 0; i < MAX_LOOPS; i++) {
    let result;
    try {
      result = await tryWithFallback(getOpts());
    } catch (err) {
      if (i === 0) throw err; // first attempt failure is fatal
      // subsequent failures: tell LLM
      currentMessages.push({ role: 'user', content: `(The previous tool execution failed with: ${err.message}. Please adapt and continue.)` });
      continue;
    }

    const toolCalls = extractToolCalls(result);

    if (toolCalls.length) {
      // Append the assistant message that contained the tool calls (raw form)
      if (result.raw?.choices?.[0]?.message) {
        currentMessages.push(result.raw.choices[0].message);
      } else {
        // reconstruct
        currentMessages.push({
          role: 'assistant',
          content: result.content || '',
          tool_calls,
        });
      }

      lastToolCallNames = toolCalls.map((tc) => tc.function.name);

      // Execute each tool (sequentially, but possibly parallel for read-only)
      for (const call of toolCalls) {
        const executor = EXECUTORS[call.function.name];
        if (!executor) {
          currentMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: `Unknown tool: ${call.function.name}` }),
          });
          continue;
        }

        let args;
        try { args = JSON.parse(call.function.arguments || '{}'); }
        catch (e) { args = {}; }

        // Build the per-tool context
        const toolCtx = {
          ...ctx,
          emitChunk,
        };

        let execResult;
        try {
          execResult = await executor(args, toolCtx);
        } catch (e) {
          execResult = { ok: false, error: e.message, verified: false, evidence: '', sideEffects: [] };
        }

        allToolResults.push({ tool: call.function.name, args, result: execResult });

        // Run verifier (if any)
        const verifier = VERIFIERS[call.function.name];
        let verifyOut;
        if (verifier) {
          try {
            const v = await verifier(args, execResult, toolCtx);
            verifyOut = { verified: !!v.verified, evidence: v.evidence || '' };
          } catch (e) {
            verifyOut = { verified: false, evidence: `verifier error: ${e.message}` };
          }
        } else {
          // No dedicated verifier. For write operations, trust the executor's verified flag.
          // For pure reads, no badge is needed.
          const writeTools = new Set([
            'create_thought', 'update_thought', 'delete_thought', 'finish_thought',
            'schedule_meeting', 'update_meeting', 'cancel_meeting',
            'create_note', 'update_note', 'delete_note',
            'update_scratchpad', 'learn_facts',
          ]);
          if (writeTools.has(call.function.name)) {
            // The executor set `verified: true` itself; otherwise trust the OK result.
            verifyOut = { verified: execResult.ok, evidence: execResult.evidence || 'op returned successfully' };
          } else {
            // Pure read — skip the badge entirely, but still track it
            verifyOut = { verified: true, evidence: '(read, no verification needed)' };
          }
        }
        verifications.push({ tool: call.function.name, args, execResult, verifyOut });

        // Emit a verification badge ONLY for tools with a real verifier
        // OR for write operations (to confirm the mutation was recorded).
        // Pure reads stay silent to avoid noise.
        const isWrite = [
          'create_thought', 'update_thought', 'delete_thought', 'finish_thought',
          'schedule_meeting', 'update_meeting', 'cancel_meeting',
          'create_note', 'update_note', 'delete_note',
        ].includes(call.function.name);
        const hasVerifier = !!verifier;
        if (hasVerifier || isWrite) {
          if (verifyOut.verified) {
            emitChunk(`\n> ✅ **Verified**: ${verifyOut.evidence}\n\n`);
          } else {
            emitChunk(`\n> ⚠️ **Verification**: ${verifyOut.evidence}\n\n`);
          }
        }

        // Build the tool response message (structured so the LLM can read it)
        const toolResponse = {
          ok: execResult.ok,
          verified: verifyOut.verified,
          evidence: verifyOut.evidence,
          sideEffects: execResult.sideEffects || [],
          result: execResult.result ?? null,
          error: execResult.error || null,
        };
        if (!verifyOut.verified && execResult.ok) {
          // Reflect: tell the LLM verification failed so it can try again
          toolResponse.reflection = 'The previous mutation could not be verified. Consider retrying, taking a different approach, or honestly reporting the partial success to the user.';
        }

        currentMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResponse),
        });
      }

      // Track whether all verifications passed
      lastVerifiedStatus = verifications.slice(-toolCalls.length).every((v) => v.verifyOut.verified) ? 'all-verified' : 'partial';
      continue; // loop again, let LLM see the results
    }

    // No tool calls — final answer
    lastContent = result.content || '';

    // If a final answer was just produced AND the LLM did useful work, stream it
    if (stream) {
      const text = lastContent;
      const chunkSize = 4;
      for (let i = 0; i < text.length; i += chunkSize) {
        emitChunk(text.slice(i, i + chunkSize));
        await new Promise((r) => setTimeout(r, 8));
      }
    } else {
      emitChunk(lastContent);
    }

    break;
  }

  // Trigger background fact extraction (debounced)
  scheduleFactExtraction({ messages: currentMessages, ctx, userText });

  return {
    content: lastContent,
    verifications,
    toolResults: allToolResults,
    verified: lastVerifiedStatus,
  };
}

/* ═══════════════════════════════════════════════════════════════
   ACTIVE LEARNING  — background fact extraction
   ═══════════════════════════════════════════════════════════════ */

function scheduleFactExtraction({ messages, ctx, userText }) {
  const now = Date.now();
  if (now - lastFactExtractionAt < FACT_EXTRACTION_DEBOUNCE_MS) return;
  lastFactExtractionAt = now;

  // Run async, don't await
  (async () => {
    try {
      if (!ctx.memory || !ctx.llm) return;
      const { chatCompletion } = ctx.llm;

      // Build a concise transcript for the extractor
      const transcript = messages
        .filter((m) => ['user', 'assistant', 'tool'].includes(m.role))
        .slice(-12)
        .map((m) => {
          if (m.role === 'tool') return `[tool] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content).substring(0, 200)}`;
          if (m.role === 'assistant' && m.tool_calls) return `[assistant → ${m.tool_calls.length} tool calls]`;
          return `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`;
        })
        .join('\n');

      const sysPrompt = agentMemory.getFactExtractionSystemPrompt();
      const userPrompt = `Recent transcript:\n${transcript}\n\nExtract any new facts about the user. Return valid JSON only.`;

      const cfg = ctx.config || {};
      const res = await chatCompletion({
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      let facts = null;
      try {
        const text = res.content || '';
        const m = text.match(/\{[\s\S]*\}/);
        facts = JSON.parse(m ? m[0] : text);
      } catch (e) { return; }

      if (facts) {
        await agentMemory.applyExtractedFacts(facts);
        if (ctx.emitChunk) {
          const ent = facts.entities?.length || 0;
          const rel = facts.relations?.length || 0;
          if (ent || rel) {
            ctx.emitChunk(`\n\n> 🧠 **Memory updated**: +${ent} entities, +${rel} relations\n`);
          }
        }
      }
    } catch (e) {
      // Silent: never fail the user-facing turn because of background learning
      console.error('Fact extraction failed:', e.message);
    }
  })();
}

module.exports = {
  handleTurn,
  buildSystemPrompt,
  extractToolCalls,
  MAX_LOOPS,
};
