/* vscode-ai-pillar-intellisense - dependency-free VS Code extension.
 * Talks to the local Python bridge (ai_bridge.py) over loopback HTTP.
 * No npm dependencies: uses only Node's built-in http/fs/path modules.
 *
 * v0.2.2 changes: shared-secret bridge authentication, http-only endpoint,
 * true debounce with per-document single-flight cancellation, content-hashed
 * cache keys, cancellation-listener cleanup on all paths, and automatic
 * re-validation/scan after edits.
 *
 * v0.3.0 changes: offline keyword/function/snippet completions for many
 * languages from schemas/language-completions.json, Salt pillar schema kept as
 * the highest-priority source for YAML/SLS/Jinja, all-file vulnerability
 * diagnostics, and YAML validation limited to YAML-like documents.
 *
 * v0.3.1 changes: portable runtime paths. The token, event log and health
 * result are configurable via saltAiPillar.* settings and default to paths
 * under os.homedir(), so no username is hardcoded in the shipped extension.
 *
 * v0.3.2 changes: schema hover explanations, visible completion-source badges,
 * a source-aware status bar, and explicit token/setup commands. No model is
 * downloaded, and no secret file is written unless the user runs the command.
 */
const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECTION = 'saltAiPillar';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000';
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), 'ai-notes', 'bridge-token');
const DEFAULT_EVENT_LOG = path.join(os.homedir(), 'ai-notes', 'vscode-extension-events.log');
const DEFAULT_HEALTH_RESULT = path.join(os.homedir(), 'ai-notes', 'vscode-health-result.json');
const TOKEN_HEADER = 'X-Salt-AI-Token';
const SCHEMA_PATH = path.join(__dirname, 'schemas', 'salt-pillar.schema.json');
const LANGUAGE_DATA_PATH = path.join(__dirname, 'schemas', 'language-completions.json');
const MAX_LOG_BYTES = 1000000;
const MAX_RESPONSE_BYTES = 1000000;
const AUTO_DIAG_MS = 600;

let statusBar;
let output;
let diagnostics;
let securityDiagnostics;
let cache = new Map();
let pending = new Map();       // document URI -> in-flight/scheduled completion
let diagTimers = new Map();    // document URI -> auto-diagnostics timer
let logChain = Promise.resolve();
let localSchema = null;
let languageData = null;
const languageByAlias = new Map();
const languageByExt = new Map();
let endpointWarned = false;
let bridgeToken = null;
let runtimePaths = {
  token: DEFAULT_TOKEN_PATH,
  eventLog: DEFAULT_EVENT_LOG,
  healthResult: DEFAULT_HEALTH_RESULT,
};

// Settings may use "~/..." so a public install does not need to know the
// absolute home directory. Anything else is passed through unchanged.
function resolveHomePath(raw, fallback) {
  const value = String(raw || '').trim();
  if (!value) return fallback;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function configurePaths() {
  const c = vscode.workspace.getConfiguration(SECTION);
  runtimePaths = {
    token: resolveHomePath(c.get('tokenPath', DEFAULT_TOKEN_PATH), DEFAULT_TOKEN_PATH),
    eventLog: resolveHomePath(c.get('eventLogPath', DEFAULT_EVENT_LOG), DEFAULT_EVENT_LOG),
    healthResult: resolveHomePath(
      c.get('healthResultPath', DEFAULT_HEALTH_RESULT), DEFAULT_HEALTH_RESULT),
  };
}

function ensureParentDir(filePath) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch (_) { /* best effort */ }
}

// Loopback alone is not access control: any local process could bind port
// 8000 while the bridge is down and collect document text. Both sides read
// the same 0600 token file; refuse to send anything if it is unavailable.
function loadToken() {
  try {
    const value = fs.readFileSync(runtimePaths.token, 'utf8').trim();
    if (value.length < 32) throw new Error('token too short');
    bridgeToken = value;
    log('bridge token loaded');
    return true;
  } catch (err) {
    bridgeToken = null;
    log(`bridge token unavailable: ${err.message}; refusing to send document text`);
    return false;
  }
}

// Only plain HTTP is supported by the bridge. Accepting https here would pass
// validation and then fail inside http.request with ERR_INVALID_PROTOCOL.
function safeEndpoint(raw) {
  try {
    const u = new URL(String(raw || DEFAULT_ENDPOINT));
    if (u.protocol !== 'http:') throw new Error('scheme');
    if (u.username || u.password) throw new Error('credentials');
    if (!LOOPBACK.has(u.hostname)) throw new Error('host');
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return DEFAULT_ENDPOINT;
  }
}

function cfg() {
  configurePaths();
  const c = vscode.workspace.getConfiguration(SECTION);
  const raw = c.get('endpoint', DEFAULT_ENDPOINT);
  const endpoint = safeEndpoint(raw);
  if (endpoint !== String(raw).replace(/\/$/, '') && !endpointWarned) {
    endpointWarned = true;
    log('rejected invalid/non-loopback endpoint; using ' + DEFAULT_ENDPOINT);
  }
  return {
    endpoint,
    enabled: c.get('enabled', true),
    useAI: c.get('useAI', false),
    languageCompletions: c.get('languageCompletions', true),
    debounceMs: c.get('debounceMs', 300),
    timeoutMs: c.get('timeoutMs', 3000),
    maxTokens: c.get('maxTokens', 24),
  };
}

// The bridge clamps the AI timeout to [5,180] s. Send it the same effective
// value the client waits for, otherwise useAI completions are cut off early.
function requestTimeout(s) {
  return s.useAI ? Math.max(s.timeoutMs, 180000) : s.timeoutMs;
}

// Cheap content hash (FNV-1a) so cache keys cannot collide for equal-length
// but different prefixes.
function hashPrefix(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function log(line) {
  const stamp = new Date().toISOString();
  if (output) output.appendLine(`[${stamp}] ${line}`);
  const logPath = runtimePaths.eventLog;
  const uri = vscode.Uri.file(logPath);
  // Serialised append avoids read-modify-write races between concurrent
  // completions; the cap stops the file growing without bound.
  logChain = logChain.then(async () => {
    ensureParentDir(logPath);
    let existing = Buffer.alloc(0);
    try { existing = await vscode.workspace.fs.readFile(uri); } catch (_) { /* new file */ }
    const entry = Buffer.from(`[${stamp}] ${line}\n`);
    const data = existing.length + entry.length > MAX_LOG_BYTES
      ? entry : Buffer.concat([existing, entry]);
    await vscode.workspace.fs.writeFile(uri, data);
  }).catch(() => { /* ignore filesystem errors */ });
}

function writeHealthResult(value) {
  const resultPath = runtimePaths.healthResult;
  ensureParentDir(resultPath);
  vscode.workspace.fs.writeFile(
    vscode.Uri.file(resultPath),
    Buffer.from(JSON.stringify(value, null, 2)),
  ).then(undefined, () => { /* ignore filesystem errors */ });
}

function request(method, urlString, body, timeoutMs, token) {
  return new Promise((resolve, reject) => {
    if (!bridgeToken) return reject(new Error('bridge token unavailable'));
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      return reject(new Error(`bad endpoint: ${err.message}`));
    }
    const payload = body ? JSON.stringify(body) : null;
    let settled = false;
    let cancellation;
    const settle = (fn, value) => {
      if (settled) return;
      if (cancellation && cancellation.dispose) cancellation.dispose();
      settled = true;
      fn(value);
    };
    const fail = (err) => settle(reject, err);
    const done = (value) => settle(resolve, value);
    const headers = { [TOKEN_HEADER]: bridgeToken };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('bridge response too large'));
        }
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return fail(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 160)}`));
        }
        try {
          done(raw ? JSON.parse(raw) : {});
        } catch (err) {
          fail(new Error(`invalid JSON from bridge: ${err.message}`));
        }
      });
    });
    if (token && typeof token.onCancellationRequested === 'function') {
      cancellation = token.onCancellationRequested(() => req.destroy(new Error('cancelled')));
    }
    req.on('timeout', () => req.destroy(new Error('bridge timeout')));
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}

// Combine VS Code's completion token with our own cancel handle so a newer
// keystroke can abort the previous in-flight bridge request.
function makeCancelToken(external) {
  const listeners = new Set();
  let externalSub = null;
  let disposed = false;
  const state = {
    isCancellationRequested: false,
    onCancellationRequested(fn) {
      if (disposed) return { dispose() {} };
      listeners.add(fn);
      if (state.isCancellationRequested) {
        try { fn(); } catch (_) { /* ignore */ }
      }
      return { dispose() { listeners.delete(fn); } };
    },
  };
  if (external && typeof external.onCancellationRequested === 'function') {
    externalSub = external.onCancellationRequested(() => state.cancel());
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (externalSub && externalSub.dispose) externalSub.dispose();
    listeners.clear();
  };
  return {
    token: state,
    cancel() {
      if (state.isCancellationRequested) return;
      state.isCancellationRequested = true;
      for (const fn of Array.from(listeners)) {
        try { fn(); } catch (_) { /* ignore */ }
      }
      dispose();
    },
    dispose,
  };
}

function updateStatus(text, detail) {
  if (!statusBar) return;
  statusBar.text = text;
  const s = cfg();
  const tokenState = bridgeToken ? 'token loaded' : 'token unavailable';
  statusBar.tooltip = `Salt AI Pillar • ${detail ? detail + ' • ' : ''}${tokenState} • ${s.endpoint} • click for health`;
}

function setIdleStatus() {
  const s = cfg();
  updateStatus(s.enabled ? '$(database) schema ready' : '$(circle-slash) completions off');
}

// Human-readable provenance for completion details and the status bar. Users
// should always be able to tell whether a suggestion came from the schema,
// the offline dataset, local rules, or the optional model.
function sourceLabel(source, kind) {
  if (kind === 'ai') return 'AI model';
  switch (String(source || '')) {
    case 'local-schema':
    case 'schema':
      return 'schema';
    case 'local-language':
      return 'offline dataset';
    case 'local-rules':
    case 'local-rules+schema-if-yaml':
      return 'local rules';
    case 'ai':
      return 'AI model';
    default:
      return String(source || 'Salt AI Pillar');
  }
}

const KINDS = {
  property: vscode.CompletionItemKind.Property,
  value: vscode.CompletionItemKind.Value,
  snippet: vscode.CompletionItemKind.Snippet,
  keyword: vscode.CompletionItemKind.Keyword,
  function: vscode.CompletionItemKind.Function,
  method: vscode.CompletionItemKind.Method,
  module: vscode.CompletionItemKind.Module,
  constant: vscode.CompletionItemKind.Constant,
  type: vscode.CompletionItemKind.Class,
  ai: vscode.CompletionItemKind.Text,
};

// ---- Path A: local JSON-schema completions (no bridge required) -----------

function loadSchema() {
  try {
    localSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    return !!localSchema;
  } catch (_) {
    localSchema = null;
    return false;
  }
}

// Offline multi-language dataset. It is bundled in the VSIX, so completions
// never need a network call, a language server, or workspace code execution.
function loadLanguageData() {
  languageByAlias.clear();
  languageByExt.clear();
  try {
    languageData = JSON.parse(fs.readFileSync(LANGUAGE_DATA_PATH, 'utf8'));
  } catch (_) {
    languageData = null;
    return 0;
  }
  let count = 0;
  for (const [name, profile] of Object.entries(languageData.languages || {})) {
    const entry = Object.assign({ name }, profile);
    count++;
    for (const alias of entry.aliases || []) {
      languageByAlias.set(String(alias).toLowerCase(), entry);
    }
    languageByAlias.set(name.toLowerCase(), entry);
    for (const ext of entry.extensions || []) {
      languageByExt.set(String(ext).toLowerCase(), entry);
    }
  }
  return count;
}

function languageProfile(doc) {
  if (!doc) return null;
  const languageId = String(doc.languageId || '').toLowerCase();
  if (languageByAlias.has(languageId)) return languageByAlias.get(languageId);
  const filePath = String((doc.uri && doc.uri.fsPath) || '');
  const base = path.basename(filePath).toLowerCase();
  if (languageByAlias.has(base)) return languageByAlias.get(base);
  return languageByExt.get(path.extname(filePath).toLowerCase()) || null;
}

function currentToken(prefix) {
  const lines = String(prefix || '').split('\n');
  const line = lines[lines.length - 1] || '';
  const match = line.match(/([A-Za-z0-9_$#<>:./-]+)$/);
  return match ? match[1] : '';
}

function languageSuggestions(doc, prefix) {
  const profile = languageProfile(doc);
  if (!profile) return [];
  const token = currentToken(prefix);
  const lower = token.toLowerCase();
  const out = [];
  const push = (values, kind, sortText, limit, detailPrefix) => {
    let added = 0;
    for (const value of values || []) {
      const label = String(value.label || value);
      if (lower && !label.toLowerCase().startsWith(lower)) continue;
      out.push({
        label,
        kind,
        insertText: value.insertText || value.body || label,
        snippet: value.body || undefined,
        detail: value.description || `${detailPrefix} ${profile.label}`,
        sortText,
      });
      added++;
      if (added >= limit) break;
    }
  };
  push(profile.keywords, 'keyword', '1', 30, 'Keyword');
  push(profile.functions, 'function', '2', 20, 'Built-in');
  push(profile.snippets, 'snippet', '3', 8, 'Snippet');
  return out;
}

function schemaNodeFor(stack) {
  let node = localSchema;
  for (const level of stack) {
    if (!node || !node.properties || !node.properties[level.key]) return null;
    node = node.properties[level.key];
    while (node && node.type === 'array' && node.items) node = node.items;
  }
  return node;
}

function localSchemaSuggestions(prefix) {
  if (!localSchema) return [];
  const lines = prefix.split('\n');
  const current = lines[lines.length - 1] || '';
  const stack = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_.*-]+)\s*:/);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[2] });
  }

  // Typing a value after "key: " -> enum values from the schema.
  const valueMatch = current.match(/^(\s*)([A-Za-z0-9_.*-]+)\s*:\s+(.+)$/);
  if (valueMatch) {
    const indent = valueMatch[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const node = schemaNodeFor(stack.concat([{ indent, key: valueMatch[2] }]));
    if (!node || !node.enum) return [];
    return node.enum.map((v) => ({
      label: String(v),
      kind: 'value',
      insertText: String(v),
      detail: node.description || 'Schema value',
    }));
  }

  // Typing a key: a trailing colon, a partial key, or an empty indented line
  // are all key positions. Offer the properties of the enclosing schema node.
  const keyMatch = current.match(/^(\s*)([A-Za-z0-9_.*-]*)\s*:\s*$/);
  const partialKey = current.match(/^(\s*)([A-Za-z0-9_.*-]*)$/);
  const keyPosition = keyMatch || partialKey;
  if (keyPosition) {
    const indent = keyPosition[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const node = schemaNodeFor(stack);
    if (!node || !node.properties) return [];
    return Object.keys(node.properties).map((k) => ({
      label: k,
      kind: 'property',
      insertText: k,
      detail: node.properties[k].description || node.properties[k].type || 'Salt pillar key',
    }));
  }
  return [];
}

// Hover over a YAML key and show exactly what the bundled schema says about
// it. This is offline and uses the same schema that drives completions.
function schemaHover(document, position) {
  if (!localSchema || !isSaltLikeDocument(document)) return null;
  let line;
  try { line = document.lineAt(position.line).text; } catch (_) { return null; }
  const match = line.match(/^(\s*)([A-Za-z0-9_.*-]+)\s*:/);
  if (!match) return null;
  const start = match[1].length;
  const end = start + match[2].length;
  const at = Number(position.character || 0);
  if (at < start || at > end) return null;

  const stack = [];
  for (let i = 0; i < position.line; i++) {
    let prior;
    try { prior = document.lineAt(i).text; } catch (_) { continue; }
    const m = prior.match(/^(\s*)([A-Za-z0-9_.*-]+)\s*:/);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[2] });
  }
  while (stack.length && stack[stack.length - 1].indent >= start) stack.pop();
  const node = schemaNodeFor(stack);
  const prop = node && node.properties && node.properties[match[2]];
  if (!prop) return null;

  const parts = [prop.description || 'Salt pillar key'];
  if (prop.type) {
    parts.push(`type: ${Array.isArray(prop.type) ? prop.type.join(' | ') : prop.type}`);
  }
  if (prop.enum) parts.push(`allowed: ${prop.enum.map(String).join(', ')}`);
  if (prop.default !== undefined) parts.push(`default: ${JSON.stringify(prop.default)}`);
  if (typeof vscode.Hover !== 'function') return null;
  const range = new vscode.Range(position.line, start, position.line, end);
  return new vscode.Hover(parts.join('\n\n'), range);
}

function toCompletionItems(descriptors, source, sortText) {
  return descriptors.map((d) => {
    const item = new vscode.CompletionItem(d.label, KINDS[d.kind] || vscode.CompletionItemKind.Text);
    if (d.snippet && typeof vscode.SnippetString === 'function') {
      item.insertText = new vscode.SnippetString(d.snippet);
    } else {
      item.insertText = d.insertText || d.label;
    }
    item.detail = `${d.detail || d.label || source}  •  ${sourceLabel(source, d.kind)}`;
    item.sortText = d.sortText || sortText;
    return item;
  });
}

function isFileDocument(doc) {
  // Output-channel and other virtual documents must never feed back into
  // diagnostics: log() writes to the Output channel, which would otherwise
  // trigger another analysis pass forever.
  return !!(doc && doc.uri && doc.uri.scheme === 'file');
}

function isSaltLikeDocument(doc) {
  if (!isFileDocument(doc)) return false;
  return ['yaml', 'sls', 'jinja'].includes(String(doc.languageId || '').toLowerCase());
}

function severityOf(d) {
  if (d.severity === 'error') return vscode.DiagnosticSeverity.Error;
  if (d.severity === 'info') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}

function toDiagnostics(res, doc) {
  return (res.diagnostics || []).map((d) => {
    const line = Math.max(0, (d.line || 1) - 1);
    const col = Math.max(0, (d.column || 1) - 1);
    let endCol = col + 40;
    try { endCol = Math.min(endCol, doc.lineAt(line).range.end.character); } catch (_) { /* ignore */ }
    if (endCol <= col) endCol = col + 1;
    const range = new vscode.Range(line, col, line, endCol);
    const item = new vscode.Diagnostic(range, d.message, severityOf(d));
    if (d.source) item.source = d.source;
    return item;
  });
}

// ---- Debounced, single-flight bridge completion ---------------------------

function remoteItemsFrom(res, aiOnly) {
  return (res.suggestions || [])
    .filter((suggestion) => !aiOnly || suggestion.kind === 'ai')
    .map((suggestion) => {
      const item = new vscode.CompletionItem(
        suggestion.label, KINDS[suggestion.kind] || vscode.CompletionItemKind.Text);
      item.insertText = suggestion.insertText || suggestion.label;
      item.detail = `${suggestion.detail || suggestion.label || 'Salt AI Pillar'}  •  ${sourceLabel(res.source, suggestion.kind)}`;
      item.sortText = suggestion.kind === 'ai' ? '4' : '5';
      return item;
    });
}

function debouncedCompletion(document, prefix, s, localItems, externalToken, options) {
  const opts = options || {};
  const useBridge = opts.useBridge !== false;
  const uri = document.uri.toString();
  const previous = pending.get(uri);
  if (previous) previous.cancel('superseded');

  const controller = makeCancelToken(externalToken);
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const entry = {
    timer: null,
    done: false,
    cancel(reason) {
      if (entry.done) return;
      if (entry.timer) clearTimeout(entry.timer);
      controller.cancel();
      log(`completion superseded (${reason}) ${uri}`);
      finish(localItems);
    },
  };
  function finish(items) {
    if (entry.done) return;
    entry.done = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (pending.get(uri) === entry) pending.delete(uri);
    controller.dispose();
    resolveResult(items);
  }
  pending.set(uri, entry);

  entry.timer = setTimeout(async () => {
    if (!useBridge) {
      cache.set(uri + '|' + hashPrefix(prefix), { at: Date.now(), items: localItems });
      updateStatus('$(book) offline dataset');
      log(`complete ${document.uri.fsPath}: ${localItems.length} offline language items`);
      return finish(localItems);
    }
    if (!bridgeToken) {
      updateStatus('$(warning) token unavailable');
      log('completion skipped: bridge token unavailable');
      return finish(localItems);
    }
    const timeout = requestTimeout(s);
    try {
      const res = await request('POST', `${s.endpoint}/complete`, {
        prefix,
        path: document.uri.fsPath,
        useAI: s.useAI,
        maxTokens: s.maxTokens,
        timeoutMs: timeout,
      }, timeout, controller.token);
      if (controller.token.isCancellationRequested) return finish(localItems);
      const remote = remoteItemsFrom(res, opts.aiOnly);
      const seen = new Set(localItems.map((item) => item.label));
      const items = localItems.concat(remote.filter((item) => !seen.has(item.label)));
      cache.set(uri + '|' + hashPrefix(prefix), { at: Date.now(), items });
      updateStatus(
        `$(check) ${sourceLabel(res.source)}${res.elapsed_ms != null ? ' ' + res.elapsed_ms + 'ms' : ''}`.trim(),
        res.engine || res.source);
      log(`complete ${document.uri.fsPath}: ${items.length} via ${res.source} (+local completions)`);
      finish(items);
    } catch (err) {
      // Failures are never cached: a transient outage must not suppress retries.
      updateStatus('$(warning) bridge offline');
      log(`complete failed: ${err.message}; local completions only`);
      finish(localItems);
    }
  }, Math.max(0, s.debounceMs));
  return result;
}

// ---- Commands -------------------------------------------------------------

async function validateActive() {
  log('validate command invoked');
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Salt AI Pillar: no active editor.');
    return;
  }
  const settings = cfg();
  const doc = editor.document;
  if (!isSaltLikeDocument(doc)) {
    log(`validate skipped for non-YAML document ${doc.uri.fsPath}`);
    vscode.window.showWarningMessage(
      'Salt AI Pillar: YAML validation applies to yaml/sls/jinja files. Use Scan for Vulnerabilities for this file.');
    return;
  }
  try {
    const res = await request('POST', `${settings.endpoint}/validate`, {
      text: doc.getText(),
      path: doc.uri.fsPath,
    }, settings.timeoutMs);
    const items = toDiagnostics(res, doc);
    diagnostics.set(doc.uri, items);
    log(`validate ${doc.uri.fsPath}: ${items.length} diagnostic(s)`);
    vscode.window.showInformationMessage(
      items.length ? `Salt AI Pillar: ${items.length} issue(s) found.`
                   : 'Salt AI Pillar: YAML valid, schema checks passed.');
  } catch (err) {
    log(`validate failed: ${err.message}`);
    vscode.window.showErrorMessage(`Salt AI Pillar validation failed: ${err.message}`);
  }
}

async function scanActive() {
  log('scan command invoked');
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Salt AI Pillar: no active editor.');
    return;
  }
  const settings = cfg();
  const doc = editor.document;
  try {
    const res = await request('POST', `${settings.endpoint}/analyze`, {
      text: doc.getText(),
      path: doc.uri.fsPath,
    }, settings.timeoutMs);
    const items = toDiagnostics(res, doc);
    securityDiagnostics.set(doc.uri, items);
    log(`scan ${doc.uri.fsPath}: ${items.length} finding(s) via ${res.engine || 'analyze'}`);
    const nError = items.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
    const nInfo = items.filter((d) => d.severity === vscode.DiagnosticSeverity.Information).length;
    vscode.window.showInformationMessage(
      items.length
        ? `Salt AI Pillar scan: ${items.length} finding(s) (${nError} high, ${nInfo} info).`
        : 'Salt AI Pillar scan: no schema or vulnerability findings.');
  } catch (err) {
    log(`scan failed: ${err.message}`);
    vscode.window.showErrorMessage(`Salt AI Pillar scan failed: ${err.message}`);
  }
}

// Findings are cleared on edit, so recompute them deterministically instead of
// leaving the Problems panel empty until the user runs both commands by hand.
function scheduleDiagnostics(doc) {
  if (!isFileDocument(doc)) return;
  const uri = doc.uri.toString();
  const previous = diagTimers.get(uri);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(async () => {
    diagTimers.delete(uri);
    if (!bridgeToken || doc.isClosed) return;
    const s = cfg();
    const text = doc.getText();
    const jobs = [
      request('POST', `${s.endpoint}/analyze`, { text, path: doc.uri.fsPath }, s.timeoutMs)
        .then((ar) => securityDiagnostics.set(doc.uri, toDiagnostics(ar, doc))),
    ];
    if (isSaltLikeDocument(doc)) {
      jobs.push(request('POST', `${s.endpoint}/validate`, { text, path: doc.uri.fsPath }, s.timeoutMs)
        .then((vr) => diagnostics.set(doc.uri, toDiagnostics(vr, doc))));
    }
    try {
      await Promise.all(jobs);
      log(`auto-diagnostics ${doc.uri.fsPath}: done`);
    } catch (err) {
      log(`auto-diagnostics skipped: ${err.message}`);
    }
  }, AUTO_DIAG_MS);
  diagTimers.set(uri, timer);
}

async function checkHealth() {
  const settings = cfg();
  log('health command invoked');
  if (output) output.show(true);
  try {
    const res = await request('GET', `${settings.endpoint}/health`, null, settings.timeoutMs);
    const state = res.ollama_reachable ? 'Qwen reachable' : 'Qwen NOT reachable';
    log(`health: ${state}, model=${res.model}`);
    updateStatus(res.ollama_reachable ? '$(check) AI ok' : '$(warning) AI offline', `bridge v${res.version}`);
    writeHealthResult({ at: new Date().toISOString(), ...res });
    vscode.window.showInformationMessage(`Salt AI Pillar bridge v${res.version}: ${state}. Model: ${res.model}`);
  } catch (err) {
    log(`health failed: ${err.message}`);
    writeHealthResult({ at: new Date().toISOString(), error: err.message });
    updateStatus('$(warning) bridge offline');
    vscode.window.showErrorMessage(`Bridge offline at ${settings.endpoint}: ${err.message}`);
  }
}

async function toggleCompletion() {
  log('toggle command invoked');
  const c = vscode.workspace.getConfiguration(SECTION);
  const next = !c.get('enabled', true);
  const target = vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update('enabled', next, target);
  cache.clear();
  setIdleStatus();
  vscode.window.showInformationMessage(`Salt AI Pillar completions ${next ? 'enabled' : 'disabled'}.`);
}

// Explicit onboarding commands. Nothing here runs at activation, and the
// generated secret is never printed, logged, or included in a message.
async function createToken() {
  configurePaths();
  const target = runtimePaths.token;
  const choice = await vscode.window.showWarningMessage(
    `Create a new 0600 bridge token at ${target}? This overwrites any existing token; restart the bridge afterwards.`,
    { modal: true }, 'Create', 'Cancel');
  if (choice !== 'Create') return;
  try {
    const secret = crypto.randomBytes(32).toString('hex');
    ensureParentDir(target);
    fs.writeFileSync(target, secret, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    bridgeToken = secret;
    log('bridge token created (value not logged)');
    vscode.window.showInformationMessage(
      `Salt AI Pillar: created 0600 token at ${target}. Restart the bridge; do not share or commit this file.`);
  } catch (err) {
    log(`token creation failed: ${err.message}`);
    vscode.window.showErrorMessage(`Salt AI Pillar token creation failed: ${err.message}`);
  }
}

async function openSetup() {
  const guide = path.join(__dirname, 'BRIDGE-README.md');
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(guide));
    await vscode.window.showTextDocument(doc);
    log('opened bridge setup guide');
  } catch (err) {
    log(`setup guide unavailable: ${guide}`);
    vscode.window.showWarningMessage(
      `Salt AI Pillar: bridge guide not found at ${guide}. Download the companion bridge bundle.`);
  }
}

function activate(context) {
  configurePaths();
  log('activate() entered');
  output = vscode.window.createOutputChannel('Salt AI Pillar');
  diagnostics = vscode.languages.createDiagnosticCollection('saltAiPillar');
  securityDiagnostics = vscode.languages.createDiagnosticCollection('saltAiPillarSecurity');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'saltAiPillar.health';
  statusBar.show();
  loadToken();
  setIdleStatus();
  if (!loadSchema()) log('local Salt schema unavailable; language data only');
  const nLanguages = loadLanguageData();
  log(nLanguages ? `language completions loaded: ${nLanguages} languages`
                 : 'language completion dataset unavailable');

  // One file-scheme provider feeds Salt schema completions first for
  // YAML/SLS/Jinja, then offline language completions for every other file.
  const selector = [{ scheme: 'file' }];
  const provider = vscode.languages.registerCompletionItemProvider(selector, {
    async provideCompletionItems(document, position, token) {
      const s = cfg();
      if (!s.enabled) return [];

      const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
      const saltLike = isSaltLikeDocument(document);
      const schemaItems = saltLike ? localSchemaSuggestions(prefix) : [];
      const languageItems = (s.languageCompletions && !saltLike)
        ? languageSuggestions(document, prefix) : [];
      const localItems = toCompletionItems(schemaItems, 'local-schema', '0')
        .concat(toCompletionItems(languageItems, 'local-language', '1'));
      const key = document.uri.toString() + '|' + hashPrefix(prefix);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.at < s.debounceMs) return cached.items || [];

      updateStatus('$(sync~spin) completing');
      return debouncedCompletion(document, prefix, s, localItems, token, {
        useBridge: saltLike || s.useAI,
        aiOnly: !saltLike,
      });
    },
  }, ':', '-', '.', '<', '#');

  const hoverProvider = typeof vscode.languages.registerHoverProvider === 'function'
    ? vscode.languages.registerHoverProvider(selector, { provideHover: schemaHover })
    : { dispose() {} };

  context.subscriptions.push(
    provider,
    hoverProvider,
    diagnostics,
    securityDiagnostics,
    statusBar,
    output,
    vscode.commands.registerCommand('saltAiPillar.validate', validateActive),
    vscode.commands.registerCommand('saltAiPillar.scan', scanActive),
    vscode.commands.registerCommand('saltAiPillar.health', checkHealth),
    vscode.commands.registerCommand('saltAiPillar.toggle', toggleCompletion),
    vscode.commands.registerCommand('saltAiPillar.createToken', createToken),
    vscode.commands.registerCommand('saltAiPillar.openSetup', openSetup),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SECTION)) {
        const previousTokenPath = runtimePaths.token;
        configurePaths();
        if (runtimePaths.token !== previousTokenPath) loadToken();
        cache.clear();
        setIdleStatus();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      const active = pending.get(key);
      if (active) active.cancel('document closed');
      for (const k of Array.from(cache.keys())) if (k.startsWith(key + '|')) cache.delete(k);
      const diag = diagTimers.get(key);
      if (diag) clearTimeout(diag);
      diagTimers.delete(key);
      diagnostics.delete(doc.uri);
      securityDiagnostics.delete(doc.uri);
    }),
  );

  if (typeof vscode.workspace.onDidChangeTextDocument === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
      // Output-channel and other non-file documents must never feed back into
      // auto-diagnostics: log() writes to the Output channel, which would
      // otherwise trigger another analysis pass forever.
      if (!isFileDocument(event.document)) return;
      const key = event.document.uri.toString();
      const active = pending.get(key);
      if (active) active.cancel('document edited');
      for (const k of Array.from(cache.keys())) if (k.startsWith(key + '|')) cache.delete(k);
      diagnostics.delete(event.document.uri);
      securityDiagnostics.delete(event.document.uri);
      scheduleDiagnostics(event.document);
    }));
  }
  const s = cfg();
  log(`activated, endpoint=${s.endpoint}, useAI=${s.useAI}, token=${!!bridgeToken}`);
}

function deactivate() {
  for (const entry of Array.from(pending.values())) entry.cancel('deactivate');
  for (const timer of Array.from(diagTimers.values())) clearTimeout(timer);
  pending.clear();
  diagTimers.clear();
  cache.clear();
  if (output) output.dispose();
}

module.exports = { activate, deactivate };
