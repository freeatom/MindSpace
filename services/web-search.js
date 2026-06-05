const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${options.hostname}${res.headers.location}`;
        const url = new URL(loc);
        httpsRequest({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'GET',
          headers: options.headers,
        }).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Search request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

function fetchDuckDuckGoHtml(query) {
  const postBody = `q=${encodeURIComponent(query)}&b=`;
  return httpsRequest({
    hostname: 'html.duckduckgo.com',
    path: '/html/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postBody),
      'User-Agent': UA,
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }, postBody).then((res) => res.body);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function resolveDuckDuckGoUrl(href) {
  if (!href) return '';
  let url = href;
  if (url.startsWith('//')) url = `https:${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('duckduckgo.com') && parsed.searchParams.has('uddg')) {
      return decodeURIComponent(parsed.searchParams.get('uddg'));
    }
    return url;
  } catch (_) {
    return url;
  }
}

function parseDuckDuckGoHtml(html) {
  const results = [];
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let sm;
  while ((sm = snippetRegex.exec(html)) !== null) {
    snippets.push(decodeHtml(sm[1].replace(/<[^>]+>/g, '').trim()));
  }

  let match;
  let i = 0;
  const seen = new Set();
  while ((match = linkRegex.exec(html)) !== null && results.length < 12) {
    const url = resolveDuckDuckGoUrl(match[1]);
    const title = decodeHtml(match[2].replace(/<[^>]+>/g, '').trim());
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: snippets[i] || '',
    });
    i++;
  }
  return results;
}

async function getInstantAnswer(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const json = await fetchJson(url);
    const sources = [];

    if (json.AbstractURL && json.Abstract) {
      sources.push({ title: json.Heading || query, url: json.AbstractURL });
    }
    (json.RelatedTopics || []).slice(0, 5).forEach((topic) => {
      if (topic.FirstURL && topic.Text) {
        sources.push({ title: topic.Text.split(' - ')[0] || topic.Text, url: topic.FirstURL });
      } else if (topic.Topics) {
        topic.Topics.slice(0, 3).forEach((sub) => {
          if (sub.FirstURL && sub.Text) {
            sources.push({ title: sub.Text.split(' - ')[0] || sub.Text, url: sub.FirstURL });
          }
        });
      }
    });

    const answerText = json.Answer || json.Abstract || json.Definition || '';

    return {
      text: answerText,
      heading: json.Heading || query,
      source: json.AbstractSource || 'DuckDuckGo',
      sourceUrl: json.AbstractURL || null,
      answerType: json.AnswerType || json.Type || '',
      sources,
    };
  } catch (_) {
    return { text: '', heading: query, source: '', sourceUrl: null, sources: [] };
  }
}

function mergeResults(htmlResults, instantAnswer, query) {
  const seen = new Set();
  const merged = [];

  const add = (item) => {
    if (!item.url || !item.title || seen.has(item.url)) return;
    seen.add(item.url);
    merged.push(item);
  };

  htmlResults.forEach(add);

  if (instantAnswer.sourceUrl && instantAnswer.text) {
    add({
      title: instantAnswer.heading || query,
      url: instantAnswer.sourceUrl,
      snippet: instantAnswer.text,
    });
  }
  (instantAnswer.sources || []).forEach((s) => {
    add({ title: s.title, url: s.url, snippet: s.title });
  });

  return merged.slice(0, 12);
}

async function searchWeb(query) {
  if (!query || !query.trim()) {
    return { results: [], aiAnswer: null, query: '' };
  }

  const q = query.trim();
  const [htmlResult, instantAnswer] = await Promise.all([
    fetchDuckDuckGoHtml(q).catch(() => ''),
    getInstantAnswer(q),
  ]);

  const htmlResults = htmlResult ? parseDuckDuckGoHtml(htmlResult) : [];
  const results = mergeResults(htmlResults, instantAnswer, q);

  const aiAnswer = instantAnswer.text ? {
    text: instantAnswer.text,
    heading: instantAnswer.heading,
    source: instantAnswer.source,
    sourceUrl: instantAnswer.sourceUrl,
    sources: instantAnswer.sources,
  } : null;

  return { results, aiAnswer, query: q };
}

module.exports = { searchWeb, getInstantAnswer };
