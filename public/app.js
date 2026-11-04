'use strict';

/*
 * Device simulator for the offline notes sync API.
 *
 * Each simulated device is an independent client with its own localStorage
 * entry: a cache of the notes it knows (text + revision), an outbox of
 * operations not yet confirmed by the server, and unresolved conflicts.
 *
 * Client rules shown here:
 *  - op_id is generated on the device when the edit is queued, and kept for retries.
 *  - An op that was never sent can still be updated in place (edits coalesce).
 *  - An op that was sent but not confirmed is frozen: resending must carry the same content.
 *  - Conflicts are shown to the user; resolving one sends a NEW op with the current base.
 */

const KEY = 'offline-notes-sim:';
const MAX_DEVICES = 4;
const NAMES = ["Ana's phone", "Ben's tablet", "Caio's laptop", "Dani's phone"];

// ---------- storage (per device, tolerant to blocked localStorage) ----------
const storage = {
  read(k, fallback) {
    try {
      const v = localStorage.getItem(KEY + k);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  write(k, v) {
    try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* memory only */ }
  },
  remove(k) {
    try { localStorage.removeItem(KEY + k); } catch { /* ignore */ }
  },
};

// ---------- helpers ----------
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const short = (id) => String(id ?? '?').slice(0, 8);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const now = () => new Date().toLocaleTimeString([], { hour12: false });
const $ = (id) => document.getElementById(id);

// ---------- devices ----------
const devices = new Map();
let deviceIds = [];

function createDevice(name) {
  return {
    id: uuid(),
    name,
    online: true,
    dropNext: false,
    syncing: false,
    notes: {},      // note_id -> { text, revision } as last confirmed by the server
    outbox: [],     // [{ op, attempts }] in the order they will be sent
    conflicts: {},  // note_id -> { kind: 'conflict', server, mine } | { kind: 'missing', mine }
    drafts: {},     // note_id -> unsaved textarea content
    selected: null,
    log: [],
  };
}

function persist(d) {
  storage.write('device:' + d.id, { ...d, syncing: false });
}
function persistIds() {
  storage.write('devices', deviceIds);
}

function addDevice() {
  if (deviceIds.length >= MAX_DEVICES) return;
  const used = new Set([...devices.values()].map((d) => d.name));
  const name = NAMES.find((n) => !used.has(n)) ?? `Device ${deviceIds.length + 1}`;
  const d = createDevice(name);
  devices.set(d.id, d);
  deviceIds.push(d.id);
  persist(d);
  persistIds();
}

function removeDevice(id) {
  devices.delete(id);
  deviceIds = deviceIds.filter((x) => x !== id);
  storage.remove('device:' + id);
  persistIds();
}

function loadDevices() {
  const ids = storage.read('devices', []);
  for (const id of Array.isArray(ids) ? ids : []) {
    const d = storage.read('device:' + id, null);
    if (d) {
      devices.set(id, { ...createDevice(d.name), ...d, syncing: false });
      deviceIds.push(id);
    }
  }
  if (deviceIds.length === 0) {
    addDevice();
    addDevice();
  }
}

function resetDevices() {
  for (const id of [...deviceIds]) removeDevice(id);
  addDevice();
  addDevice();
}

function logDevice(d, status, text) {
  d.log.unshift({ t: now(), status, text });
  d.log = d.log.slice(0, 6);
}

// ---------- local edits ----------
const pendingFor = (d, noteId) => d.outbox.find((e) => e.op.note_id === noteId);

function displayText(d, noteId) {
  const pending = pendingFor(d, noteId);
  return pending ? pending.op.text : d.notes[noteId]?.text ?? '';
}

function noteIds(d) {
  return [
    ...new Set([...Object.keys(d.notes), ...d.outbox.map((e) => e.op.note_id), ...Object.keys(d.conflicts)]),
  ].sort((a, b) => a.localeCompare(b));
}

function enqueue(d, noteId, base, text) {
  const op = { op_id: uuid(), note_id: noteId, base_revision: base, text };
  d.outbox.push({ op, attempts: 0 });
  return op;
}

function createNote(d, noteId) {
  d.selected = noteId;
  if (noteIds(d).includes(noteId)) return;
  enqueue(d, noteId, 0, '');
  logDevice(d, 'pending', `queued creation of "${noteId}" (base 0)`);
}

function saveEdit(d, noteId, text) {
  const pending = pendingFor(d, noteId);
  if (pending && pending.attempts > 0) {
    logDevice(d, 'lost', `"${noteId}" was sent and is waiting for a receipt. Sync before editing again.`);
    return;
  }
  if (pending) {
    pending.op.text = text; // never sent: safe to change, keeps the same op_id
    logDevice(d, 'pending', `updated queued op ${short(pending.op.op_id)} for "${noteId}"`);
  } else {
    const base = d.notes[noteId]?.revision ?? 0;
    const op = enqueue(d, noteId, base, text);
    logDevice(d, 'pending', `queued op ${short(op.op_id)}: "${noteId}" on base ${base}`);
  }
  delete d.drafts[noteId];
}

function resolveConflict(d, noteId, choice, text) {
  const c = d.conflicts[noteId];
  if (!c) return;
  delete d.conflicts[noteId];
  delete d.drafts[noteId];
  if (choice === 'server' || choice === 'discard') {
    logDevice(d, 'applied', `kept the server version of "${noteId}"`);
    return;
  }
  const base = c.kind === 'missing' ? 0 : c.server.revision;
  const op = enqueue(d, noteId, base, text);
  logDevice(d, 'pending', `resolution queued as new op ${short(op.op_id)} on base ${base}`);
}

// ---------- sync ----------
function applyResult(d, r) {
  const i = d.outbox.findIndex((e) => e.op.op_id === r.op_id);
  if (i >= 0) d.outbox.splice(i, 1);

  switch (r.status) {
    case 'applied':
      d.notes[r.note.id] = { text: r.note.text, revision: r.note.revision };
      logDevice(d, 'applied', `"${r.note.id}" confirmed at revision ${r.note.revision}`);
      break;
    case 'conflict': {
      const id = r.server_note.id;
      d.notes[id] = { text: r.server_note.text, revision: r.server_note.revision };
      d.conflicts[id] = { kind: 'conflict', server: r.server_note, mine: r.proposal.text };
      d.selected = id;
      logDevice(d, 'conflict', `conflict on "${id}": server is at revision ${r.server_note.revision}`);
      break;
    }
    case 'note_not_found': {
      const id = r.proposal.note_id;
      delete d.notes[id];
      d.conflicts[id] = { kind: 'missing', mine: r.proposal.text };
      d.selected = id;
      logDevice(d, 'note_not_found', `"${id}" does not exist on the server`);
      break;
    }
    default:
      logDevice(d, r.status, `op ${short(r.op_id)} rejected: ${r.errors ? r.errors.join('; ') : r.status}`);
  }
}

async function pull(d) {
  try {
    const res = await fetch('/notes');
    if (!res.ok) return;
    for (const n of await res.json()) {
      if (pendingFor(d, n.id) || d.conflicts[n.id]) continue; // never overwrite local work
      const local = d.notes[n.id];
      if (!local || local.revision < n.revision) d.notes[n.id] = { text: n.text, revision: n.revision };
    }
  } catch {
    /* offline from the server's point of view; keep the cache */
  }
}

async function sync(d) {
  if (d.syncing) return;
  if (!d.online) {
    logDevice(d, 'offline', `offline: ${d.outbox.length} op(s) kept in the outbox`);
    persist(d);
    render();
    return;
  }

  d.syncing = true;
  render();
  try {
    const batch = d.outbox.map((e) => {
      e.attempts += 1;
      return structuredClone(e.op);
    });
    persist(d);

    if (batch.length > 0) {
      const sentIds = new Set(batch.map((op) => op.op_id));
      let status = 0; // 0 = no HTTP response at all
      let body;
      try {
        const res = await fetch('/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operations: batch }),
        });
        status = res.status;
        body = await readBody(res);
      } catch (err) {
        body = { error: String(err) };
      }

      const isApiReply = Array.isArray(body?.results);
      const ok = status >= 200 && status < 300 && isApiReply;
      const lost = ok && d.dropNext;
      netLog({ who: d.name, request: { operations: batch }, response: body, ok, lost, status });

      if (!ok) {
        // A 4xx, or a 2xx that is not the sync API, is a definitive "not applied":
        // the ops go back to editable. No response or a 5xx is ambiguous (the server
        // may have applied them), so they stay frozen and the next sync resends them as-is.
        const definitive = (status >= 400 && status < 500) || (status >= 200 && status < 300 && !isApiReply);
        if (definitive) {
          for (const e of d.outbox) if (sentIds.has(e.op.op_id)) e.attempts -= 1;
        }
        const where = status ? `HTTP ${status}` : 'no response';
        logDevice(d, 'error', `sync failed (${where}): ${describeError(body)}.${definitive ? ' Nothing was applied.' : ' Ops stay frozen and will be resent unchanged.'}`);
        return;
      }
      if (lost) {
        d.dropNext = false;
        logDevice(d, 'lost', `the server processed ${batch.length} op(s) but the response was lost. They stay in the outbox with the same op_id.`);
        return;
      }
      for (const r of body.results) applyResult(d, r);
    }
    await pull(d);
  } finally {
    d.syncing = false;
    if (devices.has(d.id)) {
      persist(d);
      render();
    }
    refreshServer();
  }
}

/** Reads a response body without assuming it is JSON (a proxy or another server may answer). */
async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: `non-JSON response "${text.slice(0, 60)}"` };
  }
}

function describeError(body) {
  if (Array.isArray(body?.message)) return body.message.join('; ');
  return body?.message ?? body?.error ?? 'unknown error';
}

// ---------- server panel ----------
function showApiWarning(show) {
  const el = $('api-warning');
  if (!show) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `This page is not talking to the sync API (opened at <code>${esc(location.origin)}</code>). Run <code>npm run start</code> and open <a href="http://localhost:3000/">http://localhost:3000</a>.`;
}

// The server keeps state in memory, so a restart wipes it while devices keep
// their local data. /health exposes an id that changes on every restart.
const INSTANCE_KEY = 'server-instance';

const hasLocalData = () =>
  [...devices.values()].some(
    (d) => Object.keys(d.notes).length || d.outbox.length || Object.keys(d.conflicts).length,
  );

async function checkServerInstance() {
  try {
    const res = await fetch('/health');
    const body = await readBody(res);
    if (!res.ok || typeof body?.instance_id !== 'string') return;
    const known = storage.read(INSTANCE_KEY, null);
    if (known === body.instance_id) return;
    if (known === null || !hasLocalData()) {
      storage.write(INSTANCE_KEY, body.instance_id); // nothing stale to warn about
      $('restart-warning').hidden = true;
      return;
    }
    $('restart-warning').dataset.instance = body.instance_id;
    $('restart-warning').hidden = false;
  } catch {
    /* reported by the API warning instead */
  }
}

function acceptServerInstance(resetLocal) {
  const banner = $('restart-warning');
  if (resetLocal) resetDevices();
  if (banner.dataset.instance) storage.write(INSTANCE_KEY, banner.dataset.instance);
  banner.hidden = true;
  render();
}

async function refreshServer() {
  checkServerInstance();
  const tbody = $('server-notes');
  try {
    const res = await fetch('/notes');
    const list = await readBody(res);
    if (!res.ok || !Array.isArray(list)) throw new Error('not the sync API');
    showApiWarning(false);
    tbody.innerHTML = list.length
      ? list
          .map((n) => `<tr><td class="mono">${esc(n.id)}</td><td>${esc(n.text) || '<span class="empty">(empty)</span>'}</td><td>v${n.revision}</td></tr>`)
          .join('')
      : '<tr><td colspan="3" class="empty">No notes on the server yet.</td></tr>';
  } catch {
    showApiWarning(true);
    tbody.innerHTML = '<tr><td colspan="3" class="s-error">Sync API not reachable from this page.</td></tr>';
  }
}

async function lookupReceipt(opId) {
  const out = $('receipt-out');
  out.hidden = false;
  try {
    const res = await fetch('/operations/' + encodeURIComponent(opId));
    out.textContent = `HTTP ${res.status}\n` + JSON.stringify(await readBody(res), null, 2);
  } catch (err) {
    out.textContent = String(err);
  }
}

// ---------- network log ----------
const netEntries = [];

function netLog(entry) {
  netEntries.unshift({ ...entry, t: now() });
  netEntries.length = Math.min(netEntries.length, 40);
  renderNetLog();
}

function renderNetLog() {
  $('net-log').innerHTML = netEntries.length
    ? netEntries
        .map((e) => {
          const summary = e.lost
            ? '<span class="s-lost">response lost on the way back</span>'
            : e.ok
              ? e.response.results.map((r) => `<span class="s-${esc(r.status)}">${esc(r.status)}</span>`).join(' · ')
              : `<span class="s-error">request failed${e.status ? ` · HTTP ${e.status}` : ' · no response'}</span>`;
          return `<li><details>
            <summary><span class="time">${e.t}</span><span class="who">${esc(e.who)}</span>
              <code>POST /sync</code><span>${e.request.operations.length} op(s)</span><span class="statuses">${summary}</span></summary>
            <div class="cols">
              <div><span>request</span><pre class="json">${esc(JSON.stringify(e.request, null, 2))}</pre></div>
              <div><span>response${e.lost ? ' (never reached the device)' : ''}</span><pre class="json">${esc(JSON.stringify(e.response, null, 2))}</pre></div>
            </div></details></li>`;
        })
        .join('')
    : '<li class="empty">No requests yet. Edit a note on a device and press Sync.</li>';
}

// ---------- device rendering ----------
function editorHTML(d, noteId) {
  const c = d.conflicts[noteId];
  const attr = `data-device="${d.id}" data-note="${esc(noteId)}"`;

  if (c?.kind === 'conflict') {
    const merged = d.drafts[noteId] ?? `${c.server.text}\n${c.mine}`;
    return `<div class="conflict-box">
      <h3>Conflict on "${esc(noteId)}"</h3>
      <div class="side"><span>Server · revision ${c.server.revision}</span><p>${esc(c.server.text) || '(empty)'}</p></div>
      <div class="side"><span>Your proposal</span><p>${esc(c.mine) || '(empty)'}</p></div>
      <div class="row">
        <button class="btn small" data-action="keep-server" ${attr}>Keep server</button>
        <button class="btn small" data-action="keep-mine" ${attr}>Keep mine</button>
      </div>
      <textarea data-draft ${attr} data-focus="draft-${d.id}" aria-label="Merged text">${esc(merged)}</textarea>
      <button class="btn small primary" data-action="save-merged" ${attr}>Send merged text</button>
    </div>`;
  }

  if (c?.kind === 'missing') {
    return `<div class="conflict-box">
      <h3>"${esc(noteId)}" does not exist on the server</h3>
      <div class="side"><span>Your proposal</span><p>${esc(c.mine) || '(empty)'}</p></div>
      <div class="row">
        <button class="btn small primary" data-action="recreate" ${attr}>Create it (base 0)</button>
        <button class="btn small" data-action="discard" ${attr}>Discard</button>
      </div>
    </div>`;
  }

  const pending = pendingFor(d, noteId);
  const known = d.notes[noteId];
  const meta = [
    known ? `known revision v${known.revision}` : 'not confirmed by the server yet',
    pending
      ? `queued op <code>${short(pending.op.op_id)}</code> on base ${pending.op.base_revision}${pending.attempts > 0 ? ' · sent, waiting for receipt (press Sync to resend)' : ''}`
      : '',
  ].filter(Boolean).join(' · ');
  const locked = pending && pending.attempts > 0;
  return `<div class="meta">${meta}</div>
    <textarea data-draft ${attr} data-focus="draft-${d.id}" aria-label="Note text" ${locked ? 'disabled' : ''}>${esc(d.drafts[noteId] ?? displayText(d, noteId))}</textarea>
    <div class="row"><button class="btn small primary" data-action="save" ${attr} ${locked ? 'disabled' : ''}>Save on device</button></div>`;
}

function deviceHTML(d) {
  const ids = noteIds(d);
  const sel = ids.includes(d.selected) ? d.selected : null;
  const list = ids.length
    ? ids
        .map((id) => {
          const pending = pendingFor(d, id);
          const badges = [
            d.notes[id] ? `<span class="badge">v${d.notes[id].revision}</span>` : '',
            pending ? '<span class="badge pending">pending</span>' : '',
            d.conflicts[id] ? '<span class="badge conflict">conflict</span>' : '',
          ].join('');
          return `<li><button class="note-item" data-action="select" data-device="${d.id}" data-note="${esc(id)}" aria-current="${id === sel}">
            <span class="nid">${esc(id)}</span><span class="badges">${badges}</span>
            <span class="preview">${esc(displayText(d, id)) || '(empty)'}</span></button></li>`;
        })
        .join('')
    : '<li class="empty">No notes on this device. Create one below.</li>';

  return `<article class="device"><div class="phone">
    <div class="status-bar"><span>${esc(d.name)}</span>
      <span class="net-pill ${d.online ? 'on' : 'off'}">${d.online ? 'online' : 'offline'}</span></div>
    <div class="screen">
      <div class="controls">
        <button class="btn small" data-action="toggle-net" data-device="${d.id}">${d.online ? 'Go offline' : 'Go online'}</button>
        <button class="btn small primary" data-action="sync" data-device="${d.id}" ${d.syncing ? 'disabled' : ''}>${d.syncing ? 'Syncing…' : 'Sync'}</button>
        <label class="drop"><input type="checkbox" data-action="drop-next" data-device="${d.id}" ${d.dropNext ? 'checked' : ''}> Lose next response</label>
      </div>
      <div class="outbox-line">Outbox: <b>${d.outbox.length}</b> op(s) waiting${Object.keys(d.conflicts).length ? ` · <b>${Object.keys(d.conflicts).length}</b> to resolve` : ''}</div>
      <ul class="note-list">${list}</ul>
      <form class="new-note" data-device="${d.id}">
        <input name="noteId" placeholder="New note name" autocomplete="off" aria-label="New note name" data-focus="new-${d.id}">
        <button class="btn small" type="submit">Create</button>
      </form>
      <div class="editor">${sel ? editorHTML(d, sel) : ''}</div>
      <ol class="device-log">${d.log.map((l) => `<li><span class="s-${esc(l.status)}">${l.t}</span> ${esc(l.text)}</li>`).join('')}</ol>
    </div>
    ${deviceIds.length > 1 ? `<button class="remove-device" data-action="remove" data-device="${d.id}" title="Remove device" aria-label="Remove ${esc(d.name)}">×</button>` : ''}
  </div></article>`;
}

function render() {
  // Keep focus and caret when re-rendering (e.g. another device finished syncing).
  const active = document.activeElement;
  const focusKey = active?.dataset?.focus;
  const caret = focusKey && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  $('devices').innerHTML = deviceIds.map((id) => deviceHTML(devices.get(id))).join('');
  $('add-device').disabled = deviceIds.length >= MAX_DEVICES;

  if (focusKey) {
    const el = document.querySelector(`[data-focus="${focusKey}"]`);
    if (el) {
      el.focus();
      if (caret) el.setSelectionRange(caret[0], caret[1]);
    }
  }
}

// ---------- events ----------
$('devices').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.matches('input[type="checkbox"]')) return;
  const d = devices.get(el.dataset.device);
  if (!d) return;
  const noteId = el.dataset.note;
  const textarea = () => el.closest('.editor')?.querySelector('textarea')?.value ?? '';

  switch (el.dataset.action) {
    case 'select': d.selected = noteId; break;
    case 'toggle-net':
      d.online = !d.online;
      logDevice(d, d.online ? 'applied' : 'offline', d.online ? 'back online, syncing' : 'went offline');
      persist(d);
      if (d.online) return void sync(d); // reconnecting triggers a sync, like a real app
      break;
    case 'sync': return void sync(d);
    case 'save': saveEdit(d, noteId, textarea()); break;
    case 'keep-server': resolveConflict(d, noteId, 'server'); break;
    case 'keep-mine': resolveConflict(d, noteId, 'mine', d.conflicts[noteId].mine); break;
    case 'save-merged': resolveConflict(d, noteId, 'merged', textarea()); break;
    case 'recreate': resolveConflict(d, noteId, 'recreate', d.conflicts[noteId].mine); break;
    case 'discard': resolveConflict(d, noteId, 'discard'); break;
    case 'remove': removeDevice(d.id); render(); return;
  }
  persist(d);
  render();
});

$('devices').addEventListener('change', (e) => {
  if (!e.target.matches('[data-action="drop-next"]')) return;
  const d = devices.get(e.target.dataset.device);
  if (!d) return;
  d.dropNext = e.target.checked;
  persist(d);
});

$('devices').addEventListener('input', (e) => {
  if (!e.target.matches('textarea[data-draft]')) return;
  const d = devices.get(e.target.dataset.device);
  if (!d) return;
  d.drafts[e.target.dataset.note] = e.target.value; // no re-render while typing
  persist(d);
});

$('devices').addEventListener('submit', (e) => {
  e.preventDefault();
  const d = devices.get(e.target.dataset.device);
  const noteId = e.target.elements.noteId.value.trim();
  if (!d || !noteId) return;
  createNote(d, noteId);
  persist(d);
  render();
});

$('add-device').addEventListener('click', () => { addDevice(); render(); });
$('reset-devices').addEventListener('click', () => { resetDevices(); render(); });
$('refresh-server').addEventListener('click', refreshServer);
$('restart-reset').addEventListener('click', () => acceptServerInstance(true));
$('restart-keep').addEventListener('click', () => acceptServerInstance(false));
$('clear-log').addEventListener('click', () => { netEntries.length = 0; renderNetLog(); });
$('receipt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const opId = $('receipt-op').value.trim();
  if (opId) lookupReceipt(opId);
});

// ---------- boot ----------
loadDevices();
render();
renderNetLog();
refreshServer();
setInterval(refreshServer, 3000);
