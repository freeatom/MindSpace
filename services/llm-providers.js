const https = require('https');

const DEFAULT_MODELS = {
  openrouter: 'google/gemini-2.0-flash-001',
  groq: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-20241022',
};

const PROVIDERS = {
  openrouter: {
    host: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    authHeader: (key) => `Bearer ${key}`,
    supportsStream: true,
  },
  groq: {
    host: 'api.groq.com',
    path: '/openai/v1/chat/completions',
    authHeader: (key) => `Bearer ${key}`,
    supportsStream: true,
  },
  openai: {
    host: 'api.openai.com',
    path: '/v1/chat/completions',
    authHeader: (key) => `Bearer ${key}`,
    supportsStream: true,
  },
};

function getDefaultModel(provider) {
  return DEFAULT_MODELS[provider] || 'gpt-3.5-turbo';
}

function httpsRequest({ hostname, path: urlPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function chatCompletion({ provider, apiKey, model, messages }) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const resolvedModel = model || getDefaultModel(provider);

  if (provider === 'gemini') {
    const body = JSON.stringify({
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    });
    const urlPath = `/v1beta/models/${resolvedModel}:generateContent?key=${apiKey}`;
    const { statusCode, body: raw } = await httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    const parsed = JSON.parse(raw);
    if (statusCode >= 400) {
      throw new Error(parsed.error?.message || raw.substring(0, 200));
    }
    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { content: text, raw: parsed };
  }

  const payload = {
    model: resolvedModel,
    messages,
    temperature: 0.4,
    stream: false,
  };
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: config.authHeader(apiKey),
  };

  const { statusCode, body: raw } = await httpsRequest({
    hostname: config.host,
    path: config.path,
    method: 'POST',
    headers,
    body,
  });
  const parsed = JSON.parse(raw);
  if (statusCode >= 400) {
    throw new Error(parsed.error?.message || parsed.message || raw.substring(0, 200));
  }
  const content = parsed.choices?.[0]?.message?.content || '';
  return { content, raw: parsed };
}

function streamChatCompletion({ provider, apiKey, model, messages, onChunk, onDone, onError }) {
  const config = PROVIDERS[provider];
  if (!config || !config.supportsStream) {
    onError(new Error(`Streaming not supported for provider: ${provider}`));
    return;
  }

  const resolvedModel = model || getDefaultModel(provider);
  const body = JSON.stringify({
    model: resolvedModel,
    messages,
    temperature: 0.4,
    stream: true,
  });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: config.authHeader(apiKey),
  };

  const req = https.request(
    { hostname: config.host, path: config.path, method: 'POST', headers },
    (res) => {
      if (res.statusCode >= 400) {
        let errData = '';
        res.on('data', (c) => { errData += c; });
        res.on('end', () => onError(new Error(errData.substring(0, 300))));
        return;
      }

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) onChunk(delta);
          } catch (_) { /* partial */ }
        }
      });
      res.on('end', () => onDone());
    }
  );
  req.on('error', onError);
  req.write(body);
  req.end();
}

async function validateApiKey({ provider, apiKey, model }) {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, error: 'API key is required' };
  }
  try {
    const result = await chatCompletion({
      provider: provider || 'groq',
      apiKey: apiKey.trim(),
      model: model || getDefaultModel(provider || 'groq'),
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    if (result.content) return { ok: true };
    return { ok: false, error: 'Empty response from provider' };
  } catch (err) {
    return { ok: false, error: err.message || 'Connection failed' };
  }
}

module.exports = {
  PROVIDERS,
  DEFAULT_MODELS,
  getDefaultModel,
  chatCompletion,
  streamChatCompletion,
  validateApiKey,
};
