(function initSyncengineDevtools() {
    'use strict';

    // ── Shadow DOM setup ─────────────────────────────────────────────────
    var host = document.createElement('div');
    host.id = 'syncengine-devtools-host';
    var shadow = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = __DEVTOOLS_STYLES__;
    shadow.appendChild(style);
    var root = document.createElement('div');
    root.className = 'se-devtools';
    shadow.appendChild(root);
    document.body.appendChild(host);

    // ── State ────────────────────────────────────────────────────────────
    var expanded = sessionStorage.getItem('se-devtools-expanded') === '1';
    var status = {
        connection: 'connecting',
        sync: { phase: 'idle', messagesReplayed: 0, totalMessages: 0, snapshotLoaded: false },
        hlc: { ts: 0, counter: 0 },
        conflicts: [],
        offlineQueue: 0,
        undoDepth: 0,
        schema: { version: null, fingerprint: null },
        entities: [],
        channels: [],
        views: {},
    };
    var serverMetrics = null;

    // Message log ring buffer
    var MESSAGE_LOG_MAX = 50;
    var messageLog = [];
    var messagePaused = false;
    var expandedMessageIndex = -1;

    // Message filter types
    var MESSAGE_KINDS = ['delta', 'entity-write', 'entity-state', 'topic', 'gc', 'authority'];
    var messageFilters = {};
    MESSAGE_KINDS.forEach(function (k) { messageFilters[k] = true; });

    // Section open states
    var SECTION_KEYS = ['sync', 'data', 'messages', 'peers', 'actions'];
    var sectionOpen = {};
    try {
        var saved = JSON.parse(sessionStorage.getItem('se-devtools-sections') || '{}');
        SECTION_KEYS.forEach(function (k) {
            sectionOpen[k] = saved[k] !== undefined ? saved[k] : (k === 'sync');
        });
    } catch (_) {
        SECTION_KEYS.forEach(function (k) { sectionOpen[k] = (k === 'sync'); });
    }

    // Pill position
    var pillPos = null;
    try {
        pillPos = JSON.parse(sessionStorage.getItem('se-devtools-pill-pos'));
    } catch (_) { /* ignore */ }

    // ── DOM references ───────────────────────────────────────────────────
    var pillEl = null;
    var popoverEl = null;

    // ── Helpers ──────────────────────────────────────────────────────────

    /** Remove all child nodes from an element (safe alternative to innerHTML = '') */
    function clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    function saveSectionStates() {
        try { sessionStorage.setItem('se-devtools-sections', JSON.stringify(sectionOpen)); } catch (_) { /* ignore */ }
    }

    function savePillPos() {
        if (pillPos) {
            try { sessionStorage.setItem('se-devtools-pill-pos', JSON.stringify(pillPos)); } catch (_) { /* ignore */ }
        }
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function relativeTime(tsMs) {
        var diff = Date.now() - tsMs;
        if (diff < 1000) return 'now';
        if (diff < 60000) return Math.floor(diff / 1000) + 's';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
        return Math.floor(diff / 3600000) + 'h';
    }

    function truncate(str, max) {
        if (!str) return '';
        str = String(str);
        return str.length > max ? str.slice(0, max) + '\u2026' : str;
    }

    function statusColor() {
        if (status.connection === 'error' || status.connection === 'disconnected') return 'red';
        if (status.connection === 'live' && status.sync.phase === 'ready') return 'green';
        return 'yellow';
    }

    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showToast('Copied!', true);
            });
        }
    }

    // ── Toast system ─────────────────────────────────────────────────────

    function showToast(msg, ok) {
        var toast = document.createElement('div');
        toast.className = 'se-toast ' + (ok ? 'success' : 'error');
        toast.textContent = msg;
        root.appendChild(toast);

        // Position toast relative to pill
        if (pillEl) {
            var pr = pillEl.getBoundingClientRect();
            toast.style.bottom = (window.innerHeight - pr.top + 8) + 'px';
            toast.style.right = (window.innerWidth - pr.right) + 'px';
        }

        setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 3000);
    }

    // ── Render pill ──────────────────────────────────────────────────────

    function renderPill() {
        if (!pillEl) {
            pillEl = document.createElement('div');
            pillEl.className = 'se-pill';
            root.appendChild(pillEl);
            setupDraggable(pillEl);
        }

        var color = statusColor();
        var conflictCount = status.conflicts ? status.conflicts.length : 0;
        var label = 'syncengine';
        if (conflictCount > 0) label += ' \u26A0' + conflictCount;

        clearChildren(pillEl);
        var dot = document.createElement('span');
        dot.className = 'se-pill-dot ' + color;
        pillEl.appendChild(dot);
        var lbl = document.createElement('span');
        lbl.className = 'se-pill-label';
        lbl.textContent = label;
        pillEl.appendChild(lbl);

        // Apply saved position
        if (pillPos) {
            pillEl.style.bottom = 'auto';
            pillEl.style.right = 'auto';
            pillEl.style.left = pillPos.x + 'px';
            pillEl.style.top = pillPos.y + 'px';
        }
    }

    // ── Render popover ───────────────────────────────────────────────────

    function renderPopover() {
        if (!expanded) {
            if (popoverEl) popoverEl.classList.add('se-hidden');
            return;
        }

        if (!popoverEl) {
            popoverEl = document.createElement('div');
            popoverEl.className = 'se-popover';
            root.appendChild(popoverEl);
        }
        popoverEl.classList.remove('se-hidden');

        // Position relative to pill
        if (pillEl) {
            var pr = pillEl.getBoundingClientRect();
            var popoverBottom = window.innerHeight - pr.top + 8;
            var popoverRight = window.innerWidth - pr.right;
            // Clamp to viewport
            if (popoverRight < 8) popoverRight = 8;
            if (popoverBottom + 520 > window.innerHeight) popoverBottom = 8;
            popoverEl.style.bottom = popoverBottom + 'px';
            popoverEl.style.right = popoverRight + 'px';
            popoverEl.style.top = 'auto';
            popoverEl.style.left = 'auto';
        }

        // Rebuild content
        clearChildren(popoverEl);

        // Header
        var header = document.createElement('div');
        header.className = 'se-popover-header';

        var titleWrap = document.createElement('div');
        titleWrap.className = 'se-popover-header-title';
        var logo = document.createElement('div');
        logo.className = 'se-popover-header-logo';
        titleWrap.appendChild(logo);
        var titleText = document.createElement('span');
        titleText.textContent = 'Syncengine DevTools';
        titleWrap.appendChild(titleText);
        header.appendChild(titleWrap);

        var minBtn = document.createElement('button');
        minBtn.className = 'se-popover-minimize';
        minBtn.textContent = '\u2212'; // minus sign
        minBtn.title = 'Minimize (Ctrl+Shift+D)';
        minBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleExpanded();
        });
        header.appendChild(minBtn);
        popoverEl.appendChild(header);

        // Sections
        renderSectionSync();
        renderSectionData();
        renderSectionMessages();
        renderSectionPeers();
        renderSectionActions();
    }

    function createSection(key, title) {
        var sec = document.createElement('div');
        sec.className = 'se-section';

        var hdr = document.createElement('div');
        hdr.className = 'se-section-header';

        var label = document.createElement('span');
        label.textContent = title;
        hdr.appendChild(label);

        var chevron = document.createElement('span');
        chevron.className = 'se-chevron' + (sectionOpen[key] ? ' open' : '');
        chevron.textContent = '\u25B6'; // right triangle
        hdr.appendChild(chevron);

        hdr.addEventListener('click', function () {
            sectionOpen[key] = !sectionOpen[key];
            saveSectionStates();
            renderPopover();
        });
        sec.appendChild(hdr);

        if (sectionOpen[key]) {
            var body = document.createElement('div');
            body.className = 'se-section-body';
            sec.appendChild(body);
            sec._body = body;
        }

        popoverEl.appendChild(sec);
        return sec._body || null;
    }

    function addRow(parent, label, value, opts) {
        opts = opts || {};
        var row = document.createElement('div');
        row.className = 'se-row';
        var lbl = document.createElement('span');
        lbl.className = 'se-label';
        lbl.textContent = label;
        row.appendChild(lbl);
        var val = document.createElement('span');
        val.className = 'se-value' + (opts.mono ? ' se-mono' : '');
        if (opts.copyable) {
            val.className += ' se-copyable';
            val.title = 'Click to copy';
            val.addEventListener('click', function () { copyToClipboard(opts.copyText || val.textContent); });
        }
        if (opts.rawElement) {
            val.appendChild(value);
        } else {
            val.textContent = value;
        }
        row.appendChild(val);
        parent.appendChild(row);
        return row;
    }

    // ── Section 1: Sync & Connection ─────────────────────────────────────

    function renderSectionSync() {
        var body = createSection('sync', 'Sync & Connection');
        if (!body) return;

        // Connection badge
        var connColor = statusColor();
        var connBadge = document.createElement('span');
        connBadge.className = 'se-badge se-badge-' + connColor;
        var dot = document.createElement('span');
        dot.className = 'se-badge-dot ' + connColor;
        connBadge.appendChild(dot);
        var connText = document.createElement('span');
        connText.textContent = status.connection;
        connBadge.appendChild(connText);
        addRow(body, 'Connection', connBadge, { rawElement: true });

        // Sync phase
        var phase = status.sync.phase || 'idle';
        addRow(body, 'Phase', phase);

        // Progress bar during replay
        if (phase === 'replaying' && status.sync.totalMessages > 0) {
            var pct = Math.min(100, Math.round((status.sync.messagesReplayed / status.sync.totalMessages) * 100));
            var progressWrap = document.createElement('div');
            progressWrap.style.width = '100%';
            var progressLabel = document.createElement('div');
            progressLabel.className = 'se-muted';
            progressLabel.style.fontSize = '9px';
            progressLabel.style.marginBottom = '2px';
            progressLabel.textContent = status.sync.messagesReplayed + ' / ' + status.sync.totalMessages + ' (' + pct + '%)';
            progressWrap.appendChild(progressLabel);
            var bar = document.createElement('div');
            bar.className = 'se-progress';
            var fill = document.createElement('div');
            fill.className = 'se-progress-bar';
            fill.style.width = pct + '%';
            bar.appendChild(fill);
            progressWrap.appendChild(bar);
            body.appendChild(progressWrap);
        }

        // HLC
        if (status.hlc) {
            var hlcTs = status.hlc.ts || 0;
            var hlcCounter = status.hlc.counter || 0;
            var drift = hlcTs > 0 ? Math.abs(Date.now() - hlcTs) : 0;
            var driftLabel = drift < 1000 ? '<1s' : (drift / 1000).toFixed(1) + 's';
            addRow(body, 'HLC', hlcTs + '.' + hlcCounter + ' (drift: ' + driftLabel + ')', { mono: true });
        }

        // Schema
        if (status.schema) {
            if (status.schema.version != null) {
                addRow(body, 'Schema', 'v' + status.schema.version);
            }
            if (status.schema.fingerprint) {
                addRow(body, 'Fingerprint', truncate(status.schema.fingerprint, 16), { mono: true, copyable: true, copyText: status.schema.fingerprint });
            }
        }

        // Offline queue
        if (status.offlineQueue > 0) {
            var qBadge = document.createElement('span');
            qBadge.className = 'se-badge se-badge-yellow';
            qBadge.textContent = status.offlineQueue + ' pending';
            addRow(body, 'Offline Queue', qBadge, { rawElement: true });
        }
    }

    // ── Section 2: Data ──────────────────────────────────────────────────

    function renderSectionData() {
        var body = createSection('data', 'Data');
        if (!body) return;

        // Channels (from server metrics)
        var streams = (serverMetrics && serverMetrics.nats && serverMetrics.nats.streams) ? serverMetrics.nats.streams : [];
        if (streams.length > 0) {
            var sh = document.createElement('div');
            sh.className = 'se-subheader';
            sh.textContent = 'Channels (NATS Streams)';
            body.appendChild(sh);

            var tbl = document.createElement('table');
            tbl.className = 'se-table';
            var thead = document.createElement('thead');
            var headerRow = document.createElement('tr');
            ['Name', 'Msgs', 'Size', 'Last Seq', 'Consumers'].forEach(function (h) {
                var th = document.createElement('th');
                th.textContent = h;
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);
            tbl.appendChild(thead);

            var tbody = document.createElement('tbody');
            streams.forEach(function (s) {
                var tr = document.createElement('tr');
                var cells = [
                    truncate(s.name, 20),
                    String(s.messages),
                    formatBytes(s.bytes),
                    String(s.lastSeq),
                    String(s.consumerCount)
                ];
                cells.forEach(function (c) {
                    var td = document.createElement('td');
                    td.textContent = c;
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            tbl.appendChild(tbody);
            body.appendChild(tbl);
        }

        // Views
        var viewKeys = status.views ? Object.keys(status.views) : [];
        if (viewKeys.length > 0) {
            var sh2 = document.createElement('div');
            sh2.className = 'se-subheader';
            sh2.textContent = 'Views';
            body.appendChild(sh2);

            viewKeys.forEach(function (name) {
                addRow(body, name, String(status.views[name]), { mono: true });
            });
        }

        // Entities
        var entities = status.entities || [];
        if (entities.length > 0) {
            var sh3 = document.createElement('div');
            sh3.className = 'se-subheader';
            sh3.textContent = 'Entities';
            body.appendChild(sh3);

            entities.forEach(function (ent) {
                var row = document.createElement('div');
                row.className = 'se-row';
                var lbl = document.createElement('span');
                lbl.className = 'se-label se-mono';
                lbl.textContent = truncate(ent.name || ent.key || String(ent), 24);
                row.appendChild(lbl);

                var badges = document.createElement('span');
                badges.className = 'se-value';
                badges.style.display = 'flex';
                badges.style.gap = '4px';

                if (ent.dirty || ent.diff) {
                    var diffBadge = document.createElement('span');
                    diffBadge.className = 'se-badge se-badge-yellow';
                    diffBadge.textContent = 'diff';
                    badges.appendChild(diffBadge);
                }
                if (ent.pending) {
                    var pendBadge = document.createElement('span');
                    pendBadge.className = 'se-badge';
                    pendBadge.textContent = 'pending';
                    badges.appendChild(pendBadge);
                }

                row.appendChild(badges);
                body.appendChild(row);
            });
        }

        // Conflicts
        var conflicts = status.conflicts || [];
        if (conflicts.length > 0) {
            var sh4 = document.createElement('div');
            sh4.className = 'se-subheader';
            sh4.textContent = 'Conflicts (' + conflicts.length + ')';
            body.appendChild(sh4);

            conflicts.forEach(function (c) {
                var cRow = document.createElement('div');
                cRow.className = 'se-conflict-row';
                var field = document.createElement('div');
                field.className = 'se-conflict-field';
                field.textContent = (c.table || '?') + '.' + (c.field || '?');
                cRow.appendChild(field);
                var meta = document.createElement('div');
                meta.className = 'se-conflict-meta';
                meta.textContent = 'strategy: ' + (c.strategy || '?') + ' | winner: ' + truncate(String(c.winner), 12) + ' | loser: ' + truncate(String(c.loser), 12);
                cRow.appendChild(meta);
                body.appendChild(cRow);
            });
        }

        // Undo depth
        if (status.undoDepth > 0) {
            addRow(body, 'Undo depth', String(status.undoDepth));
        }

        // Empty state
        if (streams.length === 0 && viewKeys.length === 0 && entities.length === 0 && conflicts.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'se-empty';
            empty.textContent = 'Waiting for data\u2026';
            body.appendChild(empty);
        }
    }

    // ── Section 3: Message Log ───────────────────────────────────────────

    function renderSectionMessages() {
        var body = createSection('messages', 'Messages');
        if (!body) return;

        // Filters row
        var filtersRow = document.createElement('div');
        filtersRow.className = 'se-msg-filters';

        MESSAGE_KINDS.forEach(function (kind) {
            var btn = document.createElement('button');
            btn.className = 'se-msg-filter' + (messageFilters[kind] ? ' active' : '');
            btn.textContent = kind;
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                messageFilters[kind] = !messageFilters[kind];
                renderPopover();
            });
            filtersRow.appendChild(btn);
        });

        // Pause/resume button
        var pauseBtn = document.createElement('button');
        pauseBtn.className = 'se-msg-pause' + (messagePaused ? ' paused' : '');
        pauseBtn.textContent = messagePaused ? '\u25B6 Resume' : '\u23F8 Pause';
        pauseBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            messagePaused = !messagePaused;
            renderPopover();
        });
        filtersRow.appendChild(pauseBtn);

        body.appendChild(filtersRow);

        // Message list
        var list = document.createElement('div');
        list.className = 'se-msg-list';

        var filtered = messageLog.filter(function (m) {
            return messageFilters[m.kind] !== false;
        });

        if (filtered.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'se-msg-empty';
            empty.textContent = messageLog.length === 0 ? 'No messages yet' : 'All filtered out';
            list.appendChild(empty);
        } else {
            // Show newest first
            for (var i = filtered.length - 1; i >= 0; i--) {
                list.appendChild(createMessageRow(filtered[i]));
            }
        }

        body.appendChild(list);
    }

    function createMessageRow(msg) {
        var row = document.createElement('div');
        row.className = 'se-msg-row';

        var summary = document.createElement('div');
        summary.className = 'se-msg-summary';

        var ts = document.createElement('span');
        ts.className = 'se-msg-ts';
        ts.textContent = relativeTime(msg.ts);
        summary.appendChild(ts);

        var kindBadge = document.createElement('span');
        kindBadge.className = 'se-msg-kind ' + (msg.kind || '').replace(/\s+/g, '-');
        kindBadge.textContent = msg.kind || '?';
        summary.appendChild(kindBadge);

        var channel = document.createElement('span');
        channel.className = 'se-msg-channel';
        channel.textContent = msg.channel || msg.entity || '';
        summary.appendChild(channel);

        var preview = document.createElement('span');
        preview.className = 'se-msg-payload-preview';
        try {
            preview.textContent = truncate(JSON.stringify(msg.payload), 30);
        } catch (_) {
            preview.textContent = '...';
        }
        summary.appendChild(preview);

        row.appendChild(summary);

        // Expanded detail
        var originalIndex = messageLog.indexOf(msg);
        if (expandedMessageIndex === originalIndex) {
            var detail = document.createElement('div');
            detail.className = 'se-msg-detail';
            try {
                detail.textContent = JSON.stringify(msg, null, 2);
            } catch (_) {
                detail.textContent = String(msg);
            }
            row.appendChild(detail);
        }

        row.addEventListener('click', function (e) {
            e.stopPropagation();
            var oi = messageLog.indexOf(msg);
            expandedMessageIndex = (expandedMessageIndex === oi) ? -1 : oi;
            renderPopover();
        });

        return row;
    }

    // ── Section 4: Peers ─────────────────────────────────────────────────

    function renderSectionPeers() {
        var body = createSection('peers', 'Peers');
        if (!body) return;

        // Workspace members
        var wsMembers = (serverMetrics && serverMetrics.workspace && serverMetrics.workspace.members)
            ? serverMetrics.workspace.members : [];

        if (wsMembers.length > 0) {
            var sh = document.createElement('div');
            sh.className = 'se-subheader';
            sh.textContent = 'Workspace Members (' + wsMembers.length + ')';
            body.appendChild(sh);

            wsMembers.forEach(function (m) {
                var item = document.createElement('div');
                item.className = 'se-peer-item';
                var dot = document.createElement('span');
                dot.className = 'se-peer-dot';
                item.appendChild(dot);
                var name = document.createElement('span');
                name.textContent = typeof m === 'string' ? m : (m.id || m.name || JSON.stringify(m));
                item.appendChild(name);
                body.appendChild(item);
            });
        }

        // Workspace ID
        if (serverMetrics && serverMetrics.workspace && serverMetrics.workspace.id) {
            addRow(body, 'Workspace ID', truncate(serverMetrics.workspace.id, 16), {
                mono: true,
                copyable: true,
                copyText: serverMetrics.workspace.id
            });
        }

        // Consumer count
        var streams = (serverMetrics && serverMetrics.nats && serverMetrics.nats.streams) ? serverMetrics.nats.streams : [];
        if (streams.length > 0 && streams[0].consumerCount != null) {
            addRow(body, 'Consumers', String(streams[0].consumerCount));
        }

        // Active channels
        var channels = status.channels || [];
        if (channels.length > 0) {
            var sh2 = document.createElement('div');
            sh2.className = 'se-subheader';
            sh2.textContent = 'Active Channels (' + channels.length + ')';
            body.appendChild(sh2);

            channels.forEach(function (ch) {
                var item = document.createElement('div');
                item.className = 'se-channel-item';
                item.textContent = typeof ch === 'string' ? ch : (ch.name || JSON.stringify(ch));
                body.appendChild(item);
            });
        }

        // Restate health
        if (serverMetrics && serverMetrics.restate) {
            var healthy = serverMetrics.restate.healthy;
            var badge = document.createElement('span');
            badge.className = 'se-badge ' + (healthy ? 'se-badge-green' : 'se-badge-red');
            badge.textContent = healthy ? 'healthy' : 'unhealthy';
            addRow(body, 'Restate', badge, { rawElement: true });
        }

        // Empty state
        if (wsMembers.length === 0 && channels.length === 0 && !serverMetrics) {
            var empty = document.createElement('div');
            empty.className = 'se-empty';
            empty.textContent = 'Waiting for server metrics\u2026';
            body.appendChild(empty);
        }
    }

    // ── Section 5: Actions ───────────────────────────────────────────────

    function renderSectionActions() {
        var body = createSection('actions', 'Actions');
        if (!body) return;

        // Safe actions
        createActionGroup(body, 'Safe', [
            { label: 'Force Reconnect', action: 'force-reconnect', clientSide: true },
            { label: 'Trigger GC', action: 'trigger-gc' },
        ]);

        // Moderate actions
        createActionGroup(body, 'Moderate', [
            { label: 'Clear Client DB', action: 'clear-client-db', clientSide: true, variant: 'yellow' },
            { label: 'Purge Stream', action: 'purge-stream', variant: 'yellow' },
        ]);

        // Destructive actions
        createActionGroup(body, 'Destructive', [
            { label: 'Teardown Workspace', action: 'teardown', variant: 'red', confirm: true },
            { label: 'Reset Everything', action: 'reset', variant: 'red', confirm: true },
        ]);
    }

    function createActionGroup(parent, label, actions) {
        var group = document.createElement('div');
        group.className = 'se-actions-group';

        var groupLabel = document.createElement('div');
        groupLabel.className = 'se-actions-group-label';
        groupLabel.textContent = label;
        group.appendChild(groupLabel);

        var row = document.createElement('div');
        row.className = 'se-actions-row';

        actions.forEach(function (a) {
            var btn = document.createElement('button');
            btn.className = 'se-action-btn' + (a.variant ? ' ' + a.variant : '');
            btn.textContent = a.label;
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                executeAction(a);
            });
            row.appendChild(btn);
        });

        group.appendChild(row);
        parent.appendChild(group);
    }

    function executeAction(a) {
        if (a.confirm) {
            if (!confirm('Are you sure you want to: ' + a.label + '? This cannot be undone.')) return;
        }

        if (a.clientSide) {
            // Send via BroadcastChannel
            try {
                bc.postMessage({ type: 'devtools-action', action: a.action });
                showToast(a.label + ': sent', true);
                if (a.action === 'clear-client-db') {
                    setTimeout(function () { location.reload(); }, 1000);
                }
            } catch (err) {
                showToast(a.label + ': ' + err.message, false);
            }
            return;
        }

        // Server-side action
        var payload = { action: a.action };

        fetch('/__syncengine/devtools/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.ok) {
                    showToast(data.message || (a.label + ': OK'), true);
                    if (a.action === 'reset' || a.action === 'teardown') {
                        setTimeout(function () { location.reload(); }, 1000);
                    }
                } else {
                    showToast(data.message || data.error || (a.label + ': failed'), false);
                }
            })
            .catch(function (err) {
                showToast(a.label + ': ' + err.message, false);
            });
    }

    // ── Toggle / render ──────────────────────────────────────────────────

    function toggleExpanded() {
        expanded = !expanded;
        sessionStorage.setItem('se-devtools-expanded', expanded ? '1' : '0');
        render();
    }

    function render() {
        renderPill();
        renderPopover();
    }

    // ── Draggable pill ───────────────────────────────────────────────────

    function setupDraggable(el) {
        var dragging = false;
        var dragStartX = 0, dragStartY = 0;
        var elStartX = 0, elStartY = 0;
        var totalMoved = 0;

        el.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            dragging = true;
            totalMoved = 0;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            var rect = el.getBoundingClientRect();
            elStartX = rect.left;
            elStartY = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var dx = e.clientX - dragStartX;
            var dy = e.clientY - dragStartY;
            totalMoved += Math.abs(dx) + Math.abs(dy);

            var newX = elStartX + dx;
            var newY = elStartY + dy;

            // Clamp to viewport
            newX = Math.max(0, Math.min(newX, window.innerWidth - el.offsetWidth));
            newY = Math.max(0, Math.min(newY, window.innerHeight - el.offsetHeight));

            el.style.left = newX + 'px';
            el.style.top = newY + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';

            pillPos = { x: newX, y: newY };
        });

        document.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false;
            savePillPos();

            // If it was a click (not a drag), toggle popover
            if (totalMoved < 4) {
                toggleExpanded();
            } else if (expanded) {
                // Re-render popover to reposition relative to new pill position
                renderPopover();
            }
        });
    }

    // ── Keyboard shortcut ────────────────────────────────────────────────

    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
            e.preventDefault();
            toggleExpanded();
        }
    });

    // ── BroadcastChannel ─────────────────────────────────────────────────

    var bc = new BroadcastChannel('syncengine-devtools');

    bc.addEventListener('message', function (e) {
        var data = e.data;
        if (!data || !data.type) return;

        if (data.type === 'devtools-status') {
            // Merge status, preserving defaults for missing fields
            if (data.connection !== undefined) status.connection = data.connection;
            if (data.sync) {
                status.sync = Object.assign({}, status.sync, data.sync);
            }
            if (data.hlc) status.hlc = data.hlc;
            if (data.conflicts !== undefined) status.conflicts = data.conflicts;
            if (data.offlineQueue !== undefined) status.offlineQueue = data.offlineQueue;
            if (data.undoDepth !== undefined) status.undoDepth = data.undoDepth;
            if (data.schema) status.schema = data.schema;
            if (data.entities !== undefined) status.entities = data.entities;
            if (data.channels !== undefined) status.channels = data.channels;
            if (data.views !== undefined) status.views = data.views;
            render();
        }

        if (data.type === 'devtools-message' && !messagePaused) {
            messageLog.push({
                ts: data.ts || Date.now(),
                kind: data.kind || 'unknown',
                channel: data.channel || '',
                entity: data.entity || '',
                seq: data.seq,
                payload: data.payload,
            });
            // Ring buffer
            while (messageLog.length > MESSAGE_LOG_MAX) {
                messageLog.shift();
                // Adjust expanded index
                if (expandedMessageIndex >= 0) expandedMessageIndex--;
                if (expandedMessageIndex < 0) expandedMessageIndex = -1;
            }
            render();
        }
    });

    // Send initial ping, re-ping every 5s
    function sendPing() {
        try { bc.postMessage({ type: 'devtools-ping' }); } catch (_) { /* ignore */ }
    }
    sendPing();
    setInterval(sendPing, 5000);

    // ── Server metrics polling ───────────────────────────────────────────

    function pollServerMetrics() {
        fetch('/__syncengine/devtools/metrics')
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                serverMetrics = data;
                render();
            })
            .catch(function () {
                // Silently ignore — server may not be ready yet
            });
    }

    pollServerMetrics();
    setInterval(pollServerMetrics, 3000);

    // ── Initial render ───────────────────────────────────────────────────
    render();

})();
