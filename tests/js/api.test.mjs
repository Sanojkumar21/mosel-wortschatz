// Tests for web/js/api.js in direct (own-key) and server modes, with a fake fetch. Run: node --test tests/js
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../web/js/api.js', import.meta.url), 'utf8');

function load({replies = [], health = null} = {}){
  const calls = [];
  const storage = new Map();
  const respond = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
  const fetch = async (url, opts = {}) => {
    calls.push({url, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {}});
    if(url === 'api/health') return health ? respond(200, health) : new Response('not found', {status: 404, headers: {'content-type': 'text/html'}});
    const next = replies.shift() || [200, 'ok'];
    const [status, content] = next;
    return status === 200
      ? respond(200, {choices: [{message: {content}}]})
      : respond(status, {error: {message: content, code: content}});
  };
  const window = {prompt: () => null};
  const ctx = {window, fetch, Response, location: {protocol: 'http:'}, console,
    document: {documentElement: {classList: {toggle(){}}}},
    localStorage: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k)}};
  vm.runInNewContext(SOURCE, ctx);
  return {ai: window.MoselAI, data: window.MoselData, calls};
}

const body = (model = 'llama-3.3-70b-versatile', extra = {}) => ({model, messages: [{role: 'user', content: 'Hallo'}], max_tokens: 500, ...extra});

test('direct mode maps the old Llama names onto current models and adds the key', async () => {
  const {ai, calls} = load();
  await ai.init();
  const res = await ai.chat(body(), 'gsk_test');
  assert.equal(res.status, 200);
  assert.equal(calls[1].body.model, 'openai/gpt-oss-120b');
  assert.equal(calls[1].headers.Authorization, 'Bearer gsk_test');
  assert.equal(calls[1].body.max_tokens, 500 + 1024);
});

test('the fast Llama model maps to the fast tier', async () => {
  const {ai, calls} = load();
  await ai.init();
  await ai.chat(body('llama-3.1-8b-instant'), 'gsk_test');
  assert.equal(calls[1].body.model, 'openai/gpt-oss-20b');
});

test('a retired or rate-limited model hands over to the next', async () => {
  const {ai, calls} = load({replies: [[404, 'model_not_found'], [429, 'rate limit'], [200, 'ok']]});
  await ai.init();
  await ai.chat(body(), 'gsk_test');
  assert.deepEqual(calls.slice(1).map(c => c.body.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
});

test('a reply in Chinese script or an empty reply is skipped', async () => {
  const {ai, calls} = load({replies: [[200, 'Am Sonntag想去 wir'], [200, ''], [200, 'Am Sonntag wandern wir.']]});
  await ai.init();
  const res = await ai.chat(body(), 'gsk_test');
  assert.equal((await res.json()).choices[0].message.content, 'Am Sonntag wandern wir.');
  assert.equal(calls.length, 4);
});

test('strict JSON rejection retries the same model without JSON mode', async () => {
  const {ai, calls} = load({replies: [[400, 'json_validate_failed'], [200, '{"ok":1}']]});
  await ai.init();
  await ai.chat(body(undefined, {response_format: {type: 'json_object'}}), 'gsk_test');
  assert.equal(calls[1].body.model, calls[2].body.model);
  assert.ok('response_format' in calls[1].body && !('response_format' in calls[2].body));
});

test('server mode sends no key and no model, only the tier', async () => {
  const {ai, calls} = load({health: {ok: true, ai: true}});
  await ai.init();
  assert.equal(ai.serverAI, true);
  await ai.chat(body('llama-3.1-8b-instant'), ai.SERVER);
  const sent = calls[1];
  assert.equal(sent.url, 'api/ai/chat');
  assert.equal(sent.body.tier, 'fast');
  assert.ok(!('model' in sent.body) && !('Authorization' in sent.headers));
});

test('without a server or a key, AI asks for a key', async () => {
  const {ai} = load();
  await ai.init();
  await assert.rejects(ai.chat(body(), ''), /Groq API key/);
});

test('imported word lists are validated', () => {
  const {data} = load();
  assert.equal(data.importWords(JSON.stringify([{title: 'A', words: [{id: 1, term: 'das Haus', translation: 'house'}]}])), 1);
  assert.throws(() => data.importWords('[{"title": "A", "words": [{"id": 1}]}]'), /id, term and translation/);
});
