(function initSyncengineDevtools() {
    'use strict';

    // ── CSS class name constants (single source of truth) ─────────────────
    var CLS = {
        devtools:            'se-devtools',
        pill:                'se-pill',
        pillDot:             'se-pill-dot',
        pillLabel:           'se-pill-label',
        toast:               'se-toast',
        hidden:              'se-hidden',
        // Drawer shell
        drawer:              'se-drawer',
        resizeHandle:        'se-resize-handle',
        // Tab bar
        tabBar:              'se-tab-bar',
        tab:                 'se-tab',
        tabActive:           'active',
        tabBarStatus:        'se-tab-bar-status',
        tabContent:          'se-tab-content',
        // Data tab
        dataSidebar:         'se-data-sidebar',
        dataSidebarGroup:    'se-data-sidebar-group',
        dataSidebarItem:     'se-data-sidebar-item',
        syncDot:             'se-sync-dot',
        syncLabel:           'se-sync-label',
        dataGrid:            'se-data-grid',
        dataToolbar:         'se-data-toolbar',
        dataToolbarName:     'se-data-toolbar-name',
        dataToolbarCount:    'se-data-toolbar-count',
        dataToolbarSeq:      'se-data-toolbar-seq',
        gridTable:           'se-grid-table',
        // Timeline tab
        timeline:            'se-timeline',
        timelineFilters:     'se-timeline-filters',
        timelineFilter:      'se-timeline-filter',
        timelineList:        'se-timeline-list',
        timelineEntry:       'se-timeline-entry',
        timelineTs:          'se-timeline-ts',
        timelineBadge:       'se-timeline-badge',
        timelineSummary:     'se-timeline-summary',
        timelineDetail:      'se-timeline-detail',
        // State tab
        state:               'se-state',
        stateGroupLabel:     'se-state-group-label',
        stateRow:            'se-state-row',
        stateLabel:          'se-state-label',
        stateValue:          'se-state-value',
        // Actions tab
        actions:             'se-actions',
        actionCard:          'se-action-card',
        actionCardLabel:     'se-action-card-label',
        actionCardDesc:      'se-action-card-desc',
        // Badges
        badge:               'se-badge',
        badgeGreen:          'se-badge-green',
        badgeYellow:         'se-badge-yellow',
        badgeRed:            'se-badge-red',
        // Empty state
        empty:               'se-empty',
        // Num cell alignment
        num:                 'num',
        local:               'local',
    };

    // ── Shadow DOM setup ─────────────────────────────────────────────────
    var host = document.createElement('div');
    host.id = 'syncengine-devtools-host';
    var shadow = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = __DEVTOOLS_STYLES__;
    shadow.appendChild(style);
    var root = document.createElement('div');
    root.className = CLS.devtools;
    shadow.appendChild(root);
    document.body.appendChild(host);

    // ── Persistent state ─────────────────────────────────────────────────
    var drawerOpen = sessionStorage.getItem('se-dt-open') === '1';
    var drawerHeight = parseInt(localStorage.getItem('se-dt-h') || '320', 10);
    var activeTab = sessionStorage.getItem('se-dt-tab') || 'data';

    // ── App state ────────────────────────────────────────────────────────
    var connStatus = 'connecting';
    var knownWorkerTs = 0; // newest worker timestamp — ignore older workers
    var peerId = '';
    var serverUrl = '';
    var tables = [];          // Array<{ name, columns, sql }>
    var viewDefs = [];        // Array<{ name, sourceTable }>
    var schemaInfo = { version: 0, fingerprint: '' };
    var viewRowCounts = {};   // { [viewName]: number }
    var offlineQueue = 0;
    var offlineEntries = [];  // [{ table, id }]
    var prevViewCounts = '';  // JSON snapshot for change detection
    var prevStreamSeq = 0;    // last known stream lastSeq
    var syncPhase = 'idle';
    var hlc = { ts: 0, counter: 0 };

    // Conflicts
    var conflicts = [];
    var conflictsEl = null;

    // Selected table in Data tab
    var selectedTable = null;
    var tableRows = {};       // { [tableName]: { columns: [], rows: [], localIds: [] } }
    var pendingQueryIds = {}; // { [queryId]: tableName }

    // Timeline — fetched from NATS JetStream (persistent, survives reload)
    var streamMessages = []; // from server endpoint
    var streamInfo = null;   // { name, messages, firstSeq, lastSeq }
    var expandedStreamIdx = -1;
    var streamLoading = false;

    // ── DOM references ───────────────────────────────────────────────────
    var pillEl = null;
    var drawerEl = null;
    var tabPanels = {};       // { tabName: el }
    var dataSidebarEl = null;
    var dataGridEl = null;
    var timelineListEl = null;
    var stateEl = null;
    var actionsEl = null;

    // ── Helpers ──────────────────────────────────────────────────────────

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function clearChildren(e) {
        while (e.firstChild) e.removeChild(e.firstChild);
    }

    function truncate(str, max) {
        if (!str) return '';
        str = String(str);
        return str.length > max ? str.slice(0, max) + '\u2026' : str;
    }

    function copyToClipboard(text) {
        try { navigator.clipboard.writeText(text); showToast('Copied', true); }
        catch (_) { showToast('Copy failed', false); }
    }

    function statusColor() {
        if (connStatus === 'disconnected' || connStatus === 'error' || connStatus === 'auth_failed') return 'red';
        if (connStatus === 'connected' || connStatus === 'live' || connStatus === 'syncing') return 'green';
        return 'yellow'; // connecting, reconnecting, etc.
    }

    function savePrefs() {
        try {
            sessionStorage.setItem('se-dt-open', drawerOpen ? '1' : '0');
            sessionStorage.setItem('se-dt-tab', activeTab);
        } catch (_) {}
        try { localStorage.setItem('se-dt-h', String(drawerHeight)); } catch (_) {}
    }

    // ── Toast ─────────────────────────────────────────────────────────────

    function showToast(msg, ok) {
        var toast = el('div', CLS.toast + ' ' + (ok ? 'success' : 'error'), msg);
        root.appendChild(toast);
        setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 3000);
    }

    // ── Pill ─────────────────────────────────────────────────────────────

    function renderPill() {
        if (!pillEl) {
            pillEl = el('div', CLS.pill);
            pillEl.addEventListener('click', openDrawer);
            root.appendChild(pillEl);
        }
        pillEl.classList.toggle(CLS.hidden, drawerOpen);
        clearChildren(pillEl);
        var dot = el('span', CLS.pillDot + ' ' + statusColor());
        pillEl.appendChild(dot);
        var lbl = el('span', CLS.pillLabel, 'syncengine');
        pillEl.appendChild(lbl);
        if (conflicts.length > 0) {
            var badge = el('span', 'se-pill-conflicts', conflicts.length);
            pillEl.appendChild(badge);
        }
    }

    // ── Drawer shell ──────────────────────────────────────────────────────

    function buildDrawer() {
        if (drawerEl) return;

        drawerEl = el('div', CLS.drawer);
        drawerEl.style.height = drawerHeight + 'px';

        // Resize handle
        var handle = el('div', CLS.resizeHandle);
        drawerEl.appendChild(handle);
        setupResize(handle);

        // Tab bar
        var tabBar = el('div', CLS.tabBar);
        drawerEl.appendChild(tabBar);

        var TABS = ['Data', 'Timeline', 'State', 'Conflicts', 'Actions'];
        TABS.forEach(function (name) {
            var key = name.toLowerCase();
            var tabBtn = el('button', CLS.tab, name);
            tabBtn.addEventListener('click', function () {
                activeTab = key;
                savePrefs();
                updateTabActive();
                showTab(key);
            });
            tabBar.appendChild(tabBtn);
            tabBtn._tabKey = key;
        });

        // Status area + close button
        var statusArea = el('div', CLS.tabBarStatus);
        var closeBtn = el('button', 'se-close-btn', '\u00D7');
        closeBtn.title = 'Close (Ctrl+Shift+D)';
        closeBtn.addEventListener('click', closeDrawer);
        statusArea.appendChild(closeBtn);
        tabBar.appendChild(statusArea);

        // Tab content panels
        var contentWrap = el('div', CLS.tabContent);
        drawerEl.appendChild(contentWrap);

        // Build each panel
        tabPanels['data'] = buildDataPanel();
        tabPanels['timeline'] = buildTimelinePanel();
        tabPanels['state'] = buildStatePanel();
        tabPanels['conflicts'] = buildConflictsPanel();
        tabPanels['actions'] = buildActionsPanel();

        Object.keys(tabPanels).forEach(function (k) {
            contentWrap.appendChild(tabPanels[k]);
        });

        root.appendChild(drawerEl);
        updateTabActive();
        showTab(activeTab);
    }

    function updateTabActive() {
        if (!drawerEl) return;
        var tabs = drawerEl.querySelectorAll('.' + CLS.tab);
        tabs.forEach(function (t) {
            var key = t._tabKey;
            if (key) {
                t.classList.toggle(CLS.tabActive, key === activeTab);
                // Show conflict count on the Conflicts tab
                if (key === 'conflicts') {
                    var existing = t.querySelector('.se-tab-count');
                    if (conflicts.length > 0) {
                        if (!existing) {
                            existing = el('span', 'se-tab-count');
                            t.appendChild(existing);
                        }
                        existing.textContent = conflicts.length;
                    } else if (existing) {
                        existing.remove();
                    }
                }
            }
        });
    }

    function showTab(key) {
        Object.keys(tabPanels).forEach(function (k) {
            tabPanels[k].classList.toggle(CLS.hidden, k !== key);
        });
        if (key === 'data') renderDataSidebar();
        if (key === 'state') renderState();
        if (key === 'timeline') renderTimeline();
        if (key === 'conflicts') renderConflicts();
        if (key === 'actions') renderActions();
    }

    function openDrawer() {
        drawerOpen = true;
        savePrefs();
        if (!drawerEl) buildDrawer();
        drawerEl.classList.remove(CLS.hidden);
        renderPill();
        showTab(activeTab);
    }

    function closeDrawer() {
        drawerOpen = false;
        savePrefs();
        if (drawerEl) drawerEl.classList.add(CLS.hidden);
        renderPill();
    }

    function toggleDrawer() {
        if (drawerOpen) closeDrawer(); else openDrawer();
    }

    // ── Resize ────────────────────────────────────────────────────────────

    function setupResize(handle) {
        var resizing = false;
        var startY = 0;
        var startH = 0;

        handle.addEventListener('pointerdown', function (e) {
            resizing = true;
            startY = e.clientY;
            startH = drawerEl.offsetHeight;
            handle.setPointerCapture(e.pointerId);
            e.preventDefault();
        });

        handle.addEventListener('pointermove', function (e) {
            if (!resizing) return;
            var delta = startY - e.clientY;
            var newH = Math.min(
                Math.max(160, startH + delta),
                Math.floor(window.innerHeight * 0.8)
            );
            drawerHeight = newH;
            drawerEl.style.height = newH + 'px';
        });

        handle.addEventListener('pointerup', function () {
            if (!resizing) return;
            resizing = false;
            savePrefs();
        });
    }

    // ── Data panel ────────────────────────────────────────────────────────

    function buildDataPanel() {
        var panel = el('div', 'se-data-panel');

        dataSidebarEl = el('div', CLS.dataSidebar);
        panel.appendChild(dataSidebarEl);

        dataGridEl = el('div', CLS.dataGrid);
        panel.appendChild(dataGridEl);

        return panel;
    }

    function renderDataSidebar() {
        if (!dataSidebarEl) return;
        clearChildren(dataSidebarEl);

        if (tables.length === 0 && viewDefs.length === 0) {
            dataSidebarEl.appendChild(el('div', CLS.empty, 'Waiting for schema\u2026'));
            return;
        }

        if (tables.length > 0) {
            dataSidebarEl.appendChild(el('div', CLS.dataSidebarGroup, 'Tables'));
            tables.forEach(function (t) {
                var item = el('div', CLS.dataSidebarItem + (selectedTable === t.name ? ' active' : ''));
                var dot = el('span', CLS.syncDot + ' green');
                item.appendChild(dot);
                item.appendChild(el('span', null, t.name));
                // Show pending offline count from devtools-status offlineEntries
                var pendingForTable = offlineEntries.filter(function (e) { return e.table === t.name; }).length;
                if (pendingForTable > 0) {
                    var lbl = el('span', CLS.syncLabel, pendingForTable + ' pending');
                    lbl.style.color = 'var(--dt-yellow)';
                    item.appendChild(lbl);
                }
                item.addEventListener('click', function () {
                    selectedTable = t.name;
                    renderDataSidebar();
                    requestRows(t.name);
                });
                dataSidebarEl.appendChild(item);
            });
        }

        if (viewDefs.length > 0) {
            dataSidebarEl.appendChild(el('div', CLS.dataSidebarGroup, 'Views'));
            viewDefs.forEach(function (v) {
                var item = el('div', CLS.dataSidebarItem + (selectedTable === ('view:' + v.name) ? ' active' : ''));
                item.appendChild(el('span', null, v.name));
                var count = viewRowCounts[v.name];
                if (count != null) {
                    var lbl = el('span', CLS.syncLabel);
                    lbl.textContent = count + ' rows';
                    item.appendChild(lbl);
                }
                item.addEventListener('click', function () {
                    selectedTable = 'view:' + v.name;
                    renderDataSidebar();
                    requestRows(v.name, true);
                });
                dataSidebarEl.appendChild(item);
            });
        }

        renderDataGrid();
    }

    function requestRows(tableName, isView) {
        if (!tableName) return;
        var qid = 'dq_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        pendingQueryIds[qid] = { name: tableName, isView: !!isView };
        try {
            if (isView) {
                // Views aren't SQL tables — query the worker's in-memory cache
                bc.postMessage({ type: 'devtools-query', id: qid, view: tableName });
            } else {
                var sql = 'SELECT * FROM "' + tableName.replace(/"/g, '""') + '" LIMIT 500';
                bc.postMessage({ type: 'devtools-query', id: qid, sql: sql });
            }
        } catch (_) {}
    }

    function renderDataGrid() {
        if (!dataGridEl) return;
        clearChildren(dataGridEl);

        if (!selectedTable) {
            dataGridEl.appendChild(el('div', CLS.empty, 'Select a table'));
            return;
        }

        var key = selectedTable.replace(/^view:/, '');
        var data = tableRows[key];

        // Toolbar
        var toolbar = el('div', CLS.dataToolbar);
        toolbar.appendChild(el('span', CLS.dataToolbarName, key));

        if (data) {
            toolbar.appendChild(el('span', CLS.dataToolbarCount, data.rows.length + ' rows'));
            var pendingCount = offlineEntries.filter(function (e) { return e.table === key; }).length;
            if (pendingCount > 0) {
                toolbar.appendChild(el('span', CLS.dataToolbarCount, pendingCount + ' pending'));
            }
        } else {
            toolbar.appendChild(el('span', CLS.dataToolbarCount, 'loading\u2026'));
        }
        dataGridEl.appendChild(toolbar);

        if (!data) {
            dataGridEl.appendChild(el('div', CLS.empty, 'Loading\u2026'));
            return;
        }

        if (data.rows.length === 0) {
            dataGridEl.appendChild(el('div', CLS.empty, 'No rows'));
            return;
        }

        var tbl = el('table', CLS.gridTable);
        var thead = el('thead');
        var headerRow = el('tr');
        data.columns.forEach(function (col) {
            var th = el('th', null, col);
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        tbl.appendChild(thead);

        var tbody = el('tbody');
        data.rows.forEach(function (row) {
            var isLocal = data.localIds && data.localIds.indexOf(String(row['id'] || row['_id'] || '')) !== -1;
            var tr = el('tr');
            if (isLocal) tr.classList.add(CLS.local);
            data.columns.forEach(function (col) {
                var val = row[col];
                var td = el('td');
                var valStr = val === null || val === undefined ? '' : String(val);
                // Format timestamps (epoch ms > year 2000 and column name hints)
                if (typeof val === 'number' && val > 946684800000 && /(?:at|time|stamp|date|created|updated)/i.test(col)) {
                    valStr = new Date(val).toLocaleString();
                }
                // Truncate UUIDs but show full on hover
                if (typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(val)) {
                    td.textContent = val.slice(0, 8) + '\u2026';
                    td.title = val;
                    td.style.cursor = 'pointer';
                    td.addEventListener('click', function (ev) { ev.stopPropagation(); copyToClipboard(val); });
                } else {
                    td.textContent = truncate(valStr, 60);
                    td.title = valStr;
                }
                if (typeof val === 'number') td.classList.add(CLS.num);
                tbody.appendChild(tr);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);
        dataGridEl.appendChild(tbl);
    }

    // ── Timeline panel (reads from NATS JetStream via server) ──────────

    function fetchStreamMessages() {
        if (streamLoading) return;
        streamLoading = true;
        var wsParam = getWorkspaceId();
        fetch('/__syncengine/devtools/stream?limit=100' + (wsParam ? '&wsId=' + encodeURIComponent(wsParam) : ''))
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                streamLoading = false;
                if (!data) return;
                streamMessages = data.messages || [];
                streamInfo = data.stream || null;
                if (drawerOpen && activeTab === 'timeline') renderTimeline();
            })
            .catch(function () { streamLoading = false; });
    }

    function buildTimelinePanel() {
        var panel = el('div', CLS.timeline);

        // Header with stream info
        var header = el('div', CLS.timelineFilters);
        if (streamInfo) {
            header.appendChild(el('span', null, streamInfo.name + ' \u2014 ' + streamInfo.messages + ' messages (seq ' + streamInfo.firstSeq + '\u2013' + streamInfo.lastSeq + ')'));
        }
        var refreshBtn = el('button', CLS.timelineFilter + ' active', '\u21BB Refresh');
        refreshBtn.addEventListener('click', function () { fetchStreamMessages(); });
        header.appendChild(refreshBtn);
        panel.appendChild(header);

        timelineListEl = el('div', CLS.timelineList);
        panel.appendChild(timelineListEl);

        // Fetch on first build
        if (streamMessages.length === 0) fetchStreamMessages();

        return panel;
    }

    function renderTimeline() {
        if (!timelineListEl) return;
        clearChildren(timelineListEl);

        if (streamMessages.length === 0) {
            timelineListEl.appendChild(el('div', CLS.empty, streamLoading ? 'Loading stream\u2026' : 'No messages in stream'));
            return;
        }

        // Newest first
        for (var i = streamMessages.length - 1; i >= 0; i--) {
            timelineListEl.appendChild(buildStreamEntry(streamMessages[i], i));
        }
    }

    function buildStreamEntry(msg, idx) {
        var wrap = el('div');
        var row = el('div', CLS.timelineEntry);

        // Seq number
        row.appendChild(el('span', CLS.timelineTs, '#' + msg.seq));

        // Timestamp
        var ts = msg.ts ? new Date(msg.ts) : null;
        var tsStr = ts ? ts.toLocaleTimeString() : '';
        row.appendChild(el('span', CLS.timelineTs, tsStr));

        // Message type badge
        var data = msg.data || {};
        var msgType = data.type || '?';
        var badgeClass = CLS.timelineBadge;
        if (msgType === 'INSERT' || msgType === 'DELETE') badgeClass += ' delta';
        else if (msgType === 'RESET') badgeClass += ' gc';
        else badgeClass += ' topic';
        row.appendChild(el('span', badgeClass, msgType));

        // Summary from actual message content
        var summary = buildStreamSummary(msg);
        row.appendChild(el('span', CLS.timelineSummary, summary));

        wrap.appendChild(row);

        if (expandedStreamIdx === idx) {
            var detail = el('div', CLS.timelineDetail);
            try { detail.textContent = JSON.stringify(msg.data, null, 2); } catch (_) { detail.textContent = String(msg.data); }
            wrap.appendChild(detail);
        }

        row.addEventListener('click', function () {
            expandedStreamIdx = (expandedStreamIdx === idx) ? -1 : idx;
            renderTimeline();
        });

        return wrap;
    }

    function buildStreamSummary(msg) {
        var d = msg.data || {};
        var subject = msg.subject || '';
        // Extract channel from subject: ws.<wsId>.<channel>.delta → <channel>
        var subjectParts = subject.split('.');
        var channel = subjectParts.length >= 3 ? subjectParts[2] : subject;

        if (d.type === 'INSERT' && d.table && d.record) {
            var keys = Object.keys(d.record).slice(0, 3);
            var preview = keys.map(function (k) { return k + ': ' + truncate(String(d.record[k]), 12); }).join(', ');
            return d.table + ' {' + preview + '}';
        }
        if (d.type === 'DELETE' && d.table) {
            return d.table + ' id=' + (d.id != null ? d.id : '?');
        }
        if (d.type === 'RESET') {
            return channel + ' (full reset)';
        }
        return channel + ' ' + truncate(JSON.stringify(d), 40);
    }

    // ── State panel ───────────────────────────────────────────────────────

    function buildStatePanel() {
        stateEl = el('div', CLS.state);
        return stateEl;
    }

    function renderState() {
        if (!stateEl) return;
        clearChildren(stateEl);

        // Connection group
        var connGroup = el('div', 'se-state-group');
        connGroup.appendChild(el('div', CLS.stateGroupLabel, 'Connection'));
        addStateRow(connGroup, 'Status', connStatus);
        if (peerId) addStateRow(connGroup, 'Peer ID', truncate(peerId, 32));
        if (serverUrl) addStateRow(connGroup, 'Server', truncate(serverUrl, 40));
        addStateRow(connGroup, 'Sync phase', syncPhase);
        if (hlc.ts) addStateRow(connGroup, 'HLC', hlc.ts + '.' + hlc.counter);
        stateEl.appendChild(connGroup);

        // Schema
        var schemaGroup = el('div', 'se-state-group');
        schemaGroup.appendChild(el('div', CLS.stateGroupLabel, 'Schema'));
        if (schemaInfo.version) addStateRow(schemaGroup, 'Version', 'v' + schemaInfo.version);
        if (schemaInfo.fingerprint) addStateRow(schemaGroup, 'Fingerprint', truncate(schemaInfo.fingerprint, 16));
        stateEl.appendChild(schemaGroup);

        // Sync
        var syncGroup = el('div', 'se-state-group');
        syncGroup.appendChild(el('div', CLS.stateGroupLabel, 'Sync'));
        addStateRow(syncGroup, 'Offline queue', offlineQueue > 0 ? offlineQueue + ' pending' : '0');
        stateEl.appendChild(syncGroup);
    }

    function addStateRow(parent, label, value) {
        var row = el('div', CLS.stateRow);
        row.appendChild(el('span', CLS.stateLabel, label));
        row.appendChild(el('span', CLS.stateValue, value));
        parent.appendChild(row);
    }

    // ── Conflicts panel ───────────────────────────────────────────────────

    function buildConflictsPanel() {
        conflictsEl = el('div', 'se-conflicts');
        return conflictsEl;
    }

    function strategyLabel(s) {
        if (s === 'lww') return 'Last-Write-Wins';
        if (s === 'max') return 'Max value';
        return s || 'unknown';
    }

    function renderConflicts() {
        if (!conflictsEl) return;
        clearChildren(conflictsEl);

        if (conflicts.length === 0) {
            conflictsEl.appendChild(el('div', CLS.empty, 'No conflicts detected'));
            return;
        }

        // Header
        var header = el('div', 'se-conflicts-header');
        var title = el('span', 'se-conflicts-title',
            conflicts.length + ' conflict' + (conflicts.length === 1 ? '' : 's') + ' auto-resolved');
        header.appendChild(title);

        var dismissAllBtn = el('button', 'se-conflicts-dismiss-all', 'Dismiss all');
        dismissAllBtn.addEventListener('click', function () {
            try { bc.postMessage({ type: 'devtools-action', action: 'dismiss-all-conflicts' }); } catch (_) {}
            conflicts = [];
            renderConflicts();
        });
        header.appendChild(dismissAllBtn);
        conflictsEl.appendChild(header);

        // Explainer
        var explainer = el('div', 'se-conflicts-explainer',
            'Two clients wrote to the same field concurrently. ' +
            'syncengine resolved each conflict using its merge strategy \u2014 no data was lost.');
        conflictsEl.appendChild(explainer);

        // Conflict cards
        for (var i = 0; i < conflicts.length; i++) {
            conflictsEl.appendChild(buildConflictCard(conflicts[i], i));
        }
    }

    function buildConflictCard(c, idx) {
        var card = el('div', 'se-conflict-card');

        // Top row: table.field + strategy badge
        var topRow = el('div', 'se-conflict-top');
        topRow.appendChild(el('span', 'se-conflict-field', c.table + '.' + c.field));
        var stratBadge = el('span', 'se-conflict-strategy', strategyLabel(c.strategy));
        topRow.appendChild(stratBadge);
        card.appendChild(topRow);

        // Record ID
        if (c.recordId) {
            var recRow = el('div', 'se-conflict-record');
            recRow.appendChild(el('span', 'se-conflict-record-label', 'record'));
            var idStr = String(c.recordId);
            recRow.appendChild(el('span', 'se-conflict-record-id', truncate(idStr, 24)));
            if (idStr.length > 24) recRow.title = idStr;
            card.appendChild(recRow);
        }

        // Values: winner vs loser
        var valRow = el('div', 'se-conflict-values');

        var winnerBox = el('div', 'se-conflict-val se-conflict-winner');
        winnerBox.appendChild(el('span', 'se-conflict-val-label', 'kept'));
        winnerBox.appendChild(el('span', 'se-conflict-val-data', String(c.winner != null ? (c.winner.value != null ? c.winner.value : c.winner) : '?')));
        valRow.appendChild(winnerBox);

        var arrowEl = el('span', 'se-conflict-arrow', '\u2190');
        valRow.appendChild(arrowEl);

        var loserBox = el('div', 'se-conflict-val se-conflict-loser');
        loserBox.appendChild(el('span', 'se-conflict-val-label', 'discarded'));
        loserBox.appendChild(el('span', 'se-conflict-val-data', String(c.loser != null ? (c.loser.value != null ? c.loser.value : c.loser) : '?')));
        valRow.appendChild(loserBox);

        card.appendChild(valRow);

        // Dismiss button
        var dismissBtn = el('button', 'se-conflict-dismiss', '\u00D7');
        dismissBtn.title = 'Dismiss';
        dismissBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            try { bc.postMessage({ type: 'devtools-action', action: 'dismiss-conflict', index: idx }); } catch (_) {}
            conflicts.splice(idx, 1);
            renderConflicts();
        });
        card.appendChild(dismissBtn);

        return card;
    }

    // ── Actions panel ─────────────────────────────────────────────────────

    function buildActionsPanel() {
        actionsEl = el('div', CLS.actions);
        renderActions();
        return actionsEl;
    }

    function renderActions() {
        if (!actionsEl) return;
        clearChildren(actionsEl);

        var ACTION_DEFS = [
            { label: 'Force Reconnect', desc: 'When your connection is stuck or messages aren\'t flowing \u2014 drops and re-establishes the NATS connection', action: 'force-reconnect', clientSide: true },
            { label: 'Clear Local Data', desc: 'When this browser has stale or corrupted data \u2014 wipes local SQLite/OPFS and reloads (other clients unaffected)', variant: 'yellow', action: 'clear-client-db', clientSide: true },
            { label: 'Reset Workspace', desc: 'When you want a clean slate \u2014 clears all server state, streams, and entity data; every connected client reloads', variant: 'red', action: 'reset', confirm: true },
        ];

        ACTION_DEFS.forEach(function (def) {
            var card = el('div', CLS.actionCard + (def.variant ? ' ' + def.variant : ''));
            var info = el('div', 'se-action-info');
            info.appendChild(el('span', CLS.actionCardLabel, def.label));
            info.appendChild(el('span', CLS.actionCardDesc, def.desc));
            card.appendChild(info);
            card.addEventListener('click', function () { executeAction(def); });
            actionsEl.appendChild(card);
        });
    }

    function executeAction(def) {
        if (def.confirm) {
            if (!confirm('Are you sure? ' + def.label + ' cannot be undone.')) return;
        }

        // Client-side actions: dispatch via BroadcastChannel to the data worker
        if (def.clientSide) {
            try {
                bc.postMessage({ type: 'devtools-action', action: def.action });
                showToast(def.label + ': sent', true);
                if (def.action === 'clear-client-db') {
                    // Wait for the worker to confirm OPFS wipe, then reload
                    var done = false;
                    var onCleared = function (e) {
                        if (e.data && e.data.type === 'devtools-db-cleared') {
                            done = true;
                            location.reload();
                        }
                    };
                    bc.addEventListener('message', onCleared);
                    setTimeout(function () { if (!done) location.reload(); }, 1000);
                }
            } catch (err) {
                showToast(def.label + ': ' + err.message, false);
            }
            return;
        }

        // Server-side actions: POST to devtools endpoint.
        // For reset, the server publishes sys.reset via NATS after
        // completing — every connected client (including this tab)
        // will clear OPFS and reload automatically.
        var wsParam = getWorkspaceId();
        var payload = { action: def.action, workspaceId: wsParam };

        showToast(def.label + '...', true);
        fetch('/__syncengine/devtools/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.ok) showToast(data.message || (def.label + ': OK'), true);
                else showToast(data.message || (def.label + ': failed'), false);
            })
            .catch(function (err) { showToast(def.label + ': ' + err.message, false); });
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function getWorkspaceId() {
        var meta = document.querySelector('meta[name="syncengine-workspace-id"]');
        return (meta && meta.getAttribute('content')) || null;
    }

    // ── Full render ───────────────────────────────────────────────────────

    function render() {
        renderPill();
        if (drawerOpen) {
            if (!drawerEl) buildDrawer();
            drawerEl.classList.remove(CLS.hidden);
            updateTabActive();
            if (activeTab === 'data') renderDataSidebar();
            if (activeTab === 'state') renderState();
            if (activeTab === 'timeline') renderTimeline();
            if (activeTab === 'conflicts') renderConflicts();
        }
    }

    // ── BroadcastChannel ──────────────────────────────────────────────────

    var bc = new BroadcastChannel('syncengine-devtools');

    bc.addEventListener('message', function (e) {
        var data = e.data;
        if (!data || !data.type) return;

        if (data.type === 'devtools-status') {
            // Ignore messages from stale workers (HMR can leave old workers alive)
            if (data._workerTs) {
                if (data._workerTs < knownWorkerTs) return;
                knownWorkerTs = data._workerTs;
            } else if (knownWorkerTs > 0) {
                return; // drop messages from old workers without timestamp
            }
            // Connection
            if (data.connection !== undefined) connStatus = data.connection;
            if (data.peerId !== undefined) peerId = data.peerId || '';
            if (data.serverUrl !== undefined) serverUrl = data.serverUrl || '';
            // Sync
            if (data.sync) syncPhase = data.sync.phase || 'idle';
            if (data.hlc) hlc = data.hlc;
            if (data.offlineQueue !== undefined) offlineQueue = data.offlineQueue;
            if (Array.isArray(data.offlineEntries)) offlineEntries = data.offlineEntries;
            // Schema & tables
            if (data.schema) schemaInfo = data.schema;
            if (Array.isArray(data.tables)) tables = data.tables;
            if (Array.isArray(data.viewDefs)) viewDefs = data.viewDefs;
            // Conflicts
            if (Array.isArray(data.conflicts)) {
                conflicts = data.conflicts;
                if (drawerOpen && activeTab === 'conflicts') renderConflicts();
            }
            // View row counts
            if (data.views) {
                var newCounts = JSON.stringify(data.views);
                if (newCounts !== prevViewCounts) {
                    prevViewCounts = newCounts;
                    viewRowCounts = data.views;
                    // Data changed — re-query selected table/view if drawer is open
                    if (drawerOpen && activeTab === 'data' && selectedTable) {
                        var isView = selectedTable.indexOf('view:') === 0;
                        var key = isView ? selectedTable.replace(/^view:/, '') : selectedTable;
                        requestRows(key, isView);
                    }
                    // Stream changed — refresh timeline if visible
                    if (drawerOpen && activeTab === 'timeline') fetchStreamMessages();
                }
            }
            render();
        }

        if (data.type === 'devtools-query-result') {
            var qid = data.id;
            var pending = pendingQueryIds[qid];
            if (pending) {
                delete pendingQueryIds[qid];
                tableRows[pending.name] = {
                    columns: data.columns || [],
                    rows: data.rows || [],
                    localIds: data.localIds || [],
                };
                if (drawerOpen && activeTab === 'data') renderDataGrid();
            }
        }
    });

    // ── Ping heartbeat ────────────────────────────────────────────────────

    function sendPing() {
        try { bc.postMessage({ type: 'devtools-ping' }); } catch (_) {}
    }
    sendPing();
    setInterval(sendPing, 5000);

    // ── Keyboard shortcut ─────────────────────────────────────────────────

    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
            e.preventDefault();
            toggleDrawer();
        }
    });

    // ── Initial render ────────────────────────────────────────────────────

    if (drawerOpen) {
        buildDrawer();
    }
    render();

})();
