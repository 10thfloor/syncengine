import { SyncEngineError } from './error.js';

interface FormatOpts {
    color?: boolean;
}

const SEVERITY_ICONS = { fatal: '✘', warning: '⚠', info: 'ℹ' } as const;

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function wrap(text: string, code: string, color: boolean): string {
    return color ? `${code}${text}${RESET}` : text;
}

function severityColor(severity: SyncEngineError['severity']): string {
    if (severity === 'fatal') return RED;
    if (severity === 'warning') return YELLOW;
    return DIM;
}

interface ParsedFrame {
    raw: string;
    path: string;
    isUserCode: boolean;
}

function parseStack(stack: string | undefined): ParsedFrame[] {
    if (!stack) return [];
    return stack
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at '))
        .map((raw) => {
            // Non-greedy + end-anchored so "at foo (bar) (path)" (rare) captures
            // the final parenthesized group, not everything between the first
            // and last paren.
            const match = raw.match(/\(([^)]+)\)$/) ?? raw.match(/at (.+)$/);
            const path = match?.[1] ?? raw;
            const isUserCode =
                !path.includes('node_modules') && !path.startsWith('node:');
            return { raw, path, isUserCode };
        });
}

function formatStack(frames: ParsedFrame[], color: boolean): string[] {
    const lines: string[] = [];
    let collapsedSyncEngine = 0;
    let collapsedOther = 0;
    let firstUserFrame = true;

    function flushCollapsed() {
        if (collapsedSyncEngine > 0) {
            lines.push(
                `   ${wrap(`┄ (${collapsedSyncEngine} syncengine internals hidden)`, DIM, color)}`,
            );
            collapsedSyncEngine = 0;
        }
        if (collapsedOther > 0) {
            lines.push(
                `   ${wrap(`┄ (${collapsedOther} internals hidden)`, DIM, color)}`,
            );
            collapsedOther = 0;
        }
    }

    for (const frame of frames) {
        if (frame.isUserCode) {
            flushCollapsed();
            const prefix = firstUserFrame ? '→' : ' ';
            firstUserFrame = false;
            lines.push(`   ${prefix} ${frame.path}`);
        } else if (frame.path.includes('@syncengine')) {
            collapsedSyncEngine++;
        } else {
            collapsedOther++;
        }
    }

    flushCollapsed();
    return lines;
}

export function formatError(error: Error, opts: FormatOpts = {}): string {
    const color = opts.color ?? true;

    if (!(error instanceof SyncEngineError)) {
        return `${wrap('✘', RED, color)} ${error.message}`;
    }

    const icon = SEVERITY_ICONS[error.severity];
    const sColor = severityColor(error.severity);
    const lines: string[] = [];

    lines.push(
        ` ${wrap(icon, sColor, color)} ${wrap(`SE::${error.category}`, BOLD, color)} ${wrap(error.code, sColor, color)}`,
    );
    lines.push('');
    lines.push(`   ${error.message}`);

    if (error.hint) {
        lines.push('');
        lines.push(`   ${wrap('hint:', DIM, color)} ${error.hint.split('\n')[0]}`);
        for (const hintLine of error.hint.split('\n').slice(1)) {
            lines.push(`   ${hintLine ? '      ' + hintLine : ''}`);
        }
    }

    const frames = parseStack(error.stack);
    if (frames.length > 0) {
        lines.push('');
        lines.push(...formatStack(frames, color));
    }

    return lines.join('\n');
}
