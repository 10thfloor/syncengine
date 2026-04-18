import { useState, useEffect, useMemo, useRef } from 'react';

/**
 * Header pill that lists previously-visited workspaces and lets the
 * user create or switch between them. Each workspace is a fully
 * isolated data scope (separate NATS stream, SQLite replica, entity
 * state); switching navigates via URL param so the target is
 * bookmarkable and the whole React tree + worker remount cleanly.
 */

const WS_STORAGE_KEY = 'syncengine:workspaces';
const WS_DEFAULT = 'default';
const WS_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

function loadKnownWorkspaces(current: string): string[] {
  const base = new Set<string>([WS_DEFAULT, current]);
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WS_STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        if (typeof v === 'string' && WS_NAME_RE.test(v)) base.add(v);
      }
    }
  } catch { /* ignore */ }
  return Array.from(base);
}

function saveKnownWorkspaces(list: readonly string[]): void {
  try {
    localStorage.setItem(WS_STORAGE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

function currentWorkspaceFromUrl(): string {
  if (typeof window === 'undefined') return WS_DEFAULT;
  return new URL(window.location.href).searchParams.get('workspace') ?? WS_DEFAULT;
}

export function WorkspaceSwitcher() {
  const current = useMemo(currentWorkspaceFromUrl, []);
  const [known, setKnown] = useState<string[]>(() => loadKnownWorkspaces(current));
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [focusIdx, setFocusIdx] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Persist list whenever we add a new one.
  useEffect(() => { saveKnownWorkspaces(known); }, [known]);

  // Close on outside click + Escape; manage focus return on close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setCreating(false);
    setDraft('');
    setFocusIdx(-1);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function switchTo(name: string) {
    if (name === current) { close(); return; }
    const url = new URL(window.location.href);
    if (name === WS_DEFAULT) url.searchParams.delete('workspace');
    else url.searchParams.set('workspace', name);
    window.location.href = url.toString();
  }

  function submitCreate() {
    const name = draft.trim();
    if (!WS_NAME_RE.test(name)) return;
    if (!known.includes(name)) {
      setKnown((prev) => [...prev, name]);
    }
    switchTo(name);
  }

  function onListKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(i + 1, known.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && focusIdx >= 0 && focusIdx < known.length) {
      e.preventDefault();
      switchTo(known[focusIdx]!);
    }
  }

  return (
    <div className="ws-switcher">
      <button
        ref={triggerRef}
        className={'ws-trigger' + (open ? ' is-open' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="ws-label">workspace</span>
        <span className="ws-name">{current}</span>
        <span className="ws-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="ws-popover"
          role="menu"
          onKeyDown={onListKey}
        >
          <div className="ws-list">
            {known.map((name, i) => (
              <button
                key={name}
                role="menuitem"
                className={
                  'ws-item' +
                  (name === current ? ' is-current' : '') +
                  (i === focusIdx ? ' is-focused' : '')
                }
                onClick={() => switchTo(name)}
                onMouseEnter={() => setFocusIdx(i)}
              >
                <span className="ws-item-name">{name}</span>
                {name === current && <span className="ws-item-check" aria-hidden>●</span>}
              </button>
            ))}
          </div>
          <div className="ws-divider" />
          {!creating ? (
            <button
              className="ws-create"
              onClick={() => {
                setCreating(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              <span className="ws-create-icon" aria-hidden>+</span>
              <span>Create workspace</span>
            </button>
          ) : (
            <form
              className="ws-create-form"
              onSubmit={(e) => { e.preventDefault(); submitCreate(); }}
            >
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32))}
                placeholder="name"
                aria-label="New workspace name"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" disabled={!WS_NAME_RE.test(draft.trim())}>go</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
