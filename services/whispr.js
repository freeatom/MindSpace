/**
 * Whispr — Speech-to-Text service using Groq's Whisper API
 * Model: whisper-large-v3-turbo
 */
const https = require('https');
const { URL } = require('url');

const TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const TRANSLATION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/translations';

/**
 * Transcribe audio buffer to text using Groq Whisper API
 * @param {Buffer} audioBuffer - Audio data (webm, wav, mp3, etc.)
 * @param {string} apiKey - Groq API key
 * @param {object} [options]
 * @param {string} [options.model] - Whisper model to use (default: 'whisper-large-v3-turbo')
 * @param {string} [options.language] - ISO 639-1 language code (e.g. 'en')
 * @param {string} [options.filename] - Filename hint (default: 'audio.webm')
 * @param {boolean} [options.translate] - If true, use translation endpoint
 * @returns {Promise<{text: string}>}
 */
function transcribe(audioBuffer, apiKey, options = {}) {
  const endpoint = options.translate ? TRANSLATION_ENDPOINT : TRANSCRIPTION_ENDPOINT;
  const filename = options.filename || 'audio.webm';
  const mimeType = filename.endsWith('.wav') ? 'audio/wav' : 'audio/webm';
  const modelToUse = options.model || 'whisper-large-v3-turbo';

  return new Promise((resolve, reject) => {
    const boundary = '----WhisprBoundary' + Date.now().toString(36);
    const parts = [];

    // File part
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );
    parts.push(audioBuffer);
    parts.push('\r\n');

    // Model part
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${modelToUse}\r\n`
    );

    // Language part (optional, only for transcription)
    if (options.language && !options.translate) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${options.language}\r\n`
      );
    }

    // Response format
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `json\r\n`
    );

    parts.push(`--${boundary}--\r\n`);

    // Build the body as a Buffer
    const bodyParts = parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8')));
    const body = Buffer.concat(bodyParts);

    const url = new URL(endpoint);
    const reqOptions = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(raw);
            resolve({ text: data.text || '' });
          } catch (e) {
            reject(new Error(`Failed to parse Whisper response: ${raw.substring(0, 200)}`));
          }
        } else {
          let errMsg = `Whisper API error ${res.statusCode}`;
          try {
            const errData = JSON.parse(raw);
            errMsg = errData.error?.message || errMsg;
          } catch (_) {}
          reject(new Error(errMsg));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Whisper request failed: ${err.message}`)));
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Whisper request timed out'));
    });

    req.write(body);
    req.end();
  });
}

module.exports = { transcribe };
