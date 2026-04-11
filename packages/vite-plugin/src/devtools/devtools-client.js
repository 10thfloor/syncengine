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
    var peerId = '';
    var serverUrl = '';
    var tables = [];          // Array<{ name, columns, sql }>
    var viewDefs = [];        // Array<{ name, sourceTable }>
    var schemaInfo = { version: 0, fingerprint: '' };
    var viewRowCounts = {};   // { [viewName]: number }
    var channelSeqs = {};     // { [channelId]: number }
    var entityCounts = {};    // { [table]: { rowCount, localCount } }
    var lastGcCollected = null;
    var offlineQueue = 0;
    var syncPhase = 'idle';
    var hlc = { ts: 0, counter: 0 };

    // Selected table in Data tab
    var selectedTable = null;
    var tableRows = {};       // { [tableName]: { columns: [], rows: [], localIds: [] } }
    var pendingQueryIds = {}; // { [queryId]: tableName }

    // Timeline
    var TIMELINE_MAX = 200;
    var timeline = [];
    var expandedTimelineIdx = -1;
    var timelineFilters = { delta: true, 'entity-write': true, 'entity-state': true, authority: true, gc: true, topic: true };
    var TIMELINE_KINDS = ['delta', 'entity-write', 'entity-state', 'authority', 'gc', 'topic'];

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

    function relativeTime(tsMs) {
        var diff = Date.now() - tsMs;
        if (diff < 1000) return 'now';
        if (diff < 60000) return Math.floor(diff / 1000) + 's';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
        return Math.floor(diff / 3600000) + 'h';
    }

    function statusColor() {
        if (connStatus === 'disconnected' || connStatus === 'error') return 'red';
        if (connStatus === 'live' || connStatus === 'connected') return 'green';
        return 'yellow';
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

        var TABS = ['Data', 'Timeline', 'State', 'Actions'];
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
        var closeBtn = el('button', null, '\u00D7');
        closeBtn.title = 'Close (Ctrl+Shift+D)';
        closeBtn.style.cssText = 'background:none;border:none;color:var(--dt-muted);cursor:pointer;font-size:16px;padding:0 4px;line-height:1;font-family:inherit;';
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
        var panel = el('div', null);
        panel.style.cssText = 'display:flex;flex:1;overflow:hidden;';

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
                var cnt = entityCounts[t.name];
                if (cnt && cnt.localCount > 0) {
                    var lbl = el('span', CLS.syncLabel, cnt.localCount + 'L');
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
                var dot = el('span', CLS.syncDot + ' yellow');
                item.appendChild(dot);
                item.appendChild(el('span', null, v.name));
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
        var sql = isView
            ? 'SELECT * FROM "' + tableName.replace(/"/g, '""') + '" LIMIT 500'
            : 'SELECT * FROM "' + tableName.replace(/"/g, '""') + '" LIMIT 500';
        var qid = 'dq_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        pendingQueryIds[qid] = { name: tableName, isView: !!isView };
        try {
            bc.postMessage({ type: 'devtools-query', id: qid, sql: sql });
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
            var cnt = entityCounts[key];
            if (cnt && cnt.localCount > 0) {
                toolbar.appendChild(el('span', CLS.dataToolbarCount, cnt.localCount + ' local'));
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
                td.textContent = truncate(valStr, 80);
                td.title = valStr;
                if (typeof val === 'number') td.classList.add(CLS.num);
                tbody.appendChild(tr);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);
        dataGridEl.appendChild(tbl);
    }

    // ── Timeline panel ────────────────────────────────────────────────────

    function buildTimelinePanel() {
        var panel = el('div', CLS.timeline);

        // Filters
        var filtersEl = el('div', CLS.timelineFilters);
        TIMELINE_KINDS.forEach(function (kind) {
            var btn = el('button', CLS.timelineFilter + (timelineFilters[kind] ? ' active' : ''), kind);
            btn.addEventListener('click', function () {
                timelineFilters[kind] = !timelineFilters[kind];
                btn.classList.toggle('active', !!timelineFilters[kind]);
                renderTimelineList();
            });
            filtersEl.appendChild(btn);
        });
        panel.appendChild(filtersEl);

        timelineListEl = el('div', CLS.timelineList);
        panel.appendChild(timelineListEl);

        return panel;
    }

    function renderTimeline() {
        renderTimelineList();
    }

    function renderTimelineList() {
        if (!timelineListEl) return;
        clearChildren(timelineListEl);

        var filtered = timeline.filter(function (e) { return timelineFilters[e.kind] !== false; });

        if (filtered.length === 0) {
            timelineListEl.appendChild(el('div', CLS.empty, timeline.length === 0 ? 'No events yet' : 'All filtered out'));
            return;
        }

        // Newest first
        for (var i = filtered.length - 1; i >= 0; i--) {
            timelineListEl.appendChild(buildTimelineEntry(filtered[i], i));
        }
    }

    function buildTimelineEntry(entry, idx) {
        var wrap = el('div');

        var row = el('div', CLS.timelineEntry);
        row.appendChild(el('span', CLS.timelineTs, relativeTime(entry.ts)));

        var badge = el('span', CLS.timelineBadge + ' ' + (entry.kind || '').replace(/\s+/g, '-'), entry.kind || '?');
        row.appendChild(badge);

        row.appendChild(el('span', CLS.timelineSummary, buildTimelineSummary(entry)));

        wrap.appendChild(row);

        // Expanded detail
        var origIdx = timeline.indexOf(entry);
        if (expandedTimelineIdx === origIdx) {
            var detail = el('div', CLS.timelineDetail);
            try { detail.textContent = JSON.stringify(entry, null, 2); } catch (_) { detail.textContent = String(entry); }
            wrap.appendChild(detail);
        }

        row.addEventListener('click', function () {
            var oi = timeline.indexOf(entry);
            expandedTimelineIdx = (expandedTimelineIdx === oi) ? -1 : oi;
            renderTimelineList();
        });

        return wrap;
    }

    function buildTimelineSummary(entry) {
        switch (entry.kind) {
            case 'delta': return (entry.channelId || entry.channel || '') + ' seq=' + (entry.seq || '?') + ' ops=' + (entry.opCount || '?');
            case 'entity-write': return (entry.table || '') + '#' + (entry.id || '') + ' [' + (entry.fields || []).join(',') + ']';
            case 'entity-state': return (entry.table || '') + ' rows=' + (entry.rowCount || 0) + ' local=' + (entry.localCount || 0);
            case 'authority': return (entry.topic || '') + ' ' + (entry.granted ? 'granted' : 'denied');
            case 'gc': return 'collected ' + (entry.collected || 0);
            case 'topic': return (entry.topic || '') + ' ' + (entry.event || '');
            default: return entry.kind || '?';
        }
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
        stateEl.appendChild(el('div', CLS.stateGroupLabel, 'Connection'));
        addStateRow(stateEl, 'Status', connStatus);
        if (peerId) addStateRow(stateEl, 'Peer ID', truncate(peerId, 32));
        if (serverUrl) addStateRow(stateEl, 'Server', truncate(serverUrl, 40));
        addStateRow(stateEl, 'Sync phase', syncPhase);
        if (hlc.ts) addStateRow(stateEl, 'HLC', hlc.ts + '.' + hlc.counter);

        // Channels group
        var channelIds = Object.keys(channelSeqs);
        if (channelIds.length > 0) {
            stateEl.appendChild(el('div', CLS.stateGroupLabel, 'Channels'));
            channelIds.forEach(function (cid) {
                addStateRow(stateEl, truncate(cid, 24), 'seq=' + channelSeqs[cid]);
            });
        }

        // Entity counts group
        var entityKeys = Object.keys(entityCounts);
        if (entityKeys.length > 0) {
            stateEl.appendChild(el('div', CLS.stateGroupLabel, 'Entities'));
            entityKeys.forEach(function (t) {
                var c = entityCounts[t];
                addStateRow(stateEl, t, c.rowCount + ' rows' + (c.localCount > 0 ? ', ' + c.localCount + ' local' : ''));
            });
        }

        // Misc
        stateEl.appendChild(el('div', CLS.stateGroupLabel, 'Misc'));
        addStateRow(stateEl, 'Offline queue', String(offlineQueue));
        if (lastGcCollected !== null) addStateRow(stateEl, 'Last GC', String(lastGcCollected));
        if (schemaInfo.version) addStateRow(stateEl, 'Schema v', String(schemaInfo.version));
        if (schemaInfo.fingerprint) addStateRow(stateEl, 'Fingerprint', truncate(schemaInfo.fingerprint, 16));
    }

    function addStateRow(parent, label, value) {
        var row = el('div', CLS.stateRow);
        row.appendChild(el('span', CLS.stateLabel, label));
        row.appendChild(el('span', CLS.stateValue, value));
        parent.appendChild(row);
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
            {
                label: 'Reconnect',
                desc: 'Force gateway reconnect',
                variant: null,
                action: 'reconnect',
                clientSide: true,
            },
            {
                label: 'Force Full Sync',
                desc: 'Discard local state, re-sync',
                variant: 'yellow',
                action: 'force-full-sync',
                clientSide: true,
            },
            {
                label: 'Clear Client DB',
                desc: 'Delete OPFS database & reload',
                variant: 'red',
                action: 'clear-client-db',
                clientSide: true,
                confirm: true,
            },
        ];

        ACTION_DEFS.forEach(function (def) {
            var card = el('div', CLS.actionCard + (def.variant ? ' ' + def.variant : ''));
            var info = el('div');
            info.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
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

        if (def.clientSide) {
            try {
                bc.postMessage({ type: 'devtools-action', action: def.action });
                showToast(def.label + ': sent', true);
                if (def.action === 'clear-client-db') {
                    var onCleared = function (e) {
                        if (e.data && e.data.type === 'devtools-db-cleared') {
                            bc.removeEventListener('message', onCleared);
                            location.reload();
                        }
                    };
                    bc.addEventListener('message', onCleared);
                    // Fallback reload after 2s
                    setTimeout(function () { location.reload(); }, 2000);
                }
            } catch (err) {
                showToast(def.label + ': ' + err.message, false);
            }
            return;
        }

        // Server-side actions
        var wsParam = getWorkspaceId();
        fetch('/__syncengine/devtools/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: def.action, workspaceId: wsParam }),
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
            if (activeTab === 'data') renderDataSidebar();
            if (activeTab === 'state') renderState();
            if (activeTab === 'timeline') renderTimelineList();
        }
    }

    // ── BroadcastChannel ──────────────────────────────────────────────────

    var bc = new BroadcastChannel('syncengine-devtools');

    bc.addEventListener('message', function (e) {
        var data = e.data;
        if (!data || !data.type) return;

        if (data.type === 'devtools-status') {
            // Connection
            if (data.connection !== undefined) connStatus = data.connection;
            if (data.peerId !== undefined) peerId = data.peerId || '';
            if (data.serverUrl !== undefined) serverUrl = data.serverUrl || '';
            // Sync
            if (data.sync) syncPhase = data.sync.phase || 'idle';
            if (data.hlc) hlc = data.hlc;
            if (data.offlineQueue !== undefined) offlineQueue = data.offlineQueue;
            // Schema & tables
            if (data.schema) schemaInfo = data.schema;
            if (Array.isArray(data.tables)) tables = data.tables;
            if (Array.isArray(data.viewDefs)) viewDefs = data.viewDefs;
            // View row counts
            if (data.views) viewRowCounts = data.views;
            // Channels
            if (Array.isArray(data.channels)) {
                data.channels.forEach(function (ch) {
                    if (typeof ch === 'string' && !channelSeqs[ch]) channelSeqs[ch] = 0;
                });
            }
            render();
        }

        if (data.type === 'devtools-message') {
            var entry = {
                ts: data.ts || Date.now(),
                kind: data.kind || 'unknown',
                channelId: data.channel || data.channelId || '',
                seq: data.seq,
                opCount: data.opCount,
                table: data.table || data.entity || '',
                id: data.id || '',
                fields: data.fields || [],
                rowCount: data.rowCount,
                localCount: data.localCount,
                topic: data.topic || '',
                event: data.event || '',
                granted: data.granted,
                collected: data.collected,
                payload: data.payload,
            };
            timeline.push(entry);
            while (timeline.length > TIMELINE_MAX) timeline.shift();

            // Update derived state from message
            if (data.kind === 'delta' && (data.channel || data.channelId) && data.seq != null) {
                channelSeqs[data.channel || data.channelId] = data.seq;
            }
            if (data.kind === 'entity-state' && data.table) {
                entityCounts[data.table] = { rowCount: data.rowCount || 0, localCount: data.localCount || 0 };
            }
            if (data.kind === 'gc' && data.collected != null) {
                lastGcCollected = data.collected;
            }

            if (drawerOpen && activeTab === 'timeline') renderTimelineList();
            renderPill();
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
