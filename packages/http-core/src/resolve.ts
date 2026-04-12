import { errors, CliCode, SyncEngineError } from '@syncengine/core';
import { hashWorkspaceId } from '@syncengine/core/http';
import type { SyncengineConfig, SyncengineUser } from '@syncengine/core';
import type { ProvisionCache } from './provision-cache.ts';

export interface ResolvePipelineOptions {
    readonly config: SyncengineConfig;
    readonly provisionCache: ProvisionCache;
    /** Hard ceiling on resolve() wall time. Default 5000ms. */
    readonly resolveTimeoutMs?: number;
    /**
     * If set, provisioning failures are reported to this callback and
     * resolution returns normally (with the derived wsKey). If unset,
     * provisioning failures throw `RESTATE_UNREACHABLE`.
     *
     * Dev middleware uses this to warn-and-continue — a restated
     * Restate shouldn't take the page down. Prod (the serve binary)
     * omits it, so failures surface as 502s.
     */
    readonly onProvisionError?: (err: unknown, wsKey: string) => void;
}

export interface ResolutionResult {
    readonly wsKey: string;
    readonly workspaceId: string;
    readonly user: SyncengineUser;
}

const DEFAULT_RESOLVE_TIMEOUT_MS = 5000;
const ANONYMOUS: SyncengineUser = Object.freeze({ id: 'anonymous' });

/**
 * Run the full request → workspace pipeline for one inbound HTTP Request.
 *
 * Pipeline (matches spec §3d):
 *   1. auth.verify({ request }) if configured; soft-fail to anonymous.
 *   2. workspaces.resolve({ request, user }) with timeout.
 *   3. hashWorkspaceId(id) → wsKey.
 *   4. provisionCache.ensureProvisioned(wsKey) — idempotent dedupe.
 *
 * Any step-internal error is wrapped as a SyncEngineError with the right
 * code/category so upstream HTTP handlers (Vite middleware, serve binary)
 * can render a consistent 500/502/504.
 */
export async function resolveWorkspace(
    request: Request,
    opts: ResolvePipelineOptions,
): Promise<ResolutionResult> {
    const { config, provisionCache } = opts;
    const timeoutMs = opts.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;

    // 1. Auth — soft failures degrade to anonymous. Hard throws don't
    //    escape (we don't want a stale cookie to 500 every page).
    const user = await runVerify(config, request);

    // 2. Resolve — user code, wrapped.
    const workspaceId = await runResolve(config, request, user, timeoutMs);

    // 3. Hash.
    const wsKey = hashWorkspaceId(workspaceId);

    // 4. Provision — dedup'd across concurrent callers by the cache.
    try {
        await provisionCache.ensureProvisioned(wsKey);
    } catch (err) {
        if (opts.onProvisionError) {
            opts.onProvisionError(err, wsKey);
        } else {
            throw errors.connection('RESTATE_UNREACHABLE', {
                message: `workspace provisioning failed for wsKey=${wsKey}`,
                cause: err instanceof Error ? err : new Error(String(err)),
                context: { wsKey },
            });
        }
    }

    return { wsKey, workspaceId, user };
}

async function runVerify(
    config: SyncengineConfig,
    request: Request,
): Promise<SyncengineUser> {
    const verify = config.auth?.verify;
    if (!verify) return ANONYMOUS;
    try {
        const result = await verify({ request });
        if (result && typeof result.id === 'string') return result;
        return ANONYMOUS;
    } catch {
        // Soft-fail — anonymous. Logging is the caller's concern (so the
        // Vite middleware and the serve binary can use their respective
        // loggers without this module importing either).
        return ANONYMOUS;
    }
}

async function runResolve(
    config: SyncengineConfig,
    request: Request,
    user: SyncengineUser,
    timeoutMs: number,
): Promise<string> {
    let returned: unknown;
    try {
        returned = await withTimeout(
            Promise.resolve(config.workspaces.resolve({ request, user })),
            timeoutMs,
        );
    } catch (err) {
        if (err instanceof SyncEngineError) throw err; // already typed
        if (isTimeoutSentinel(err)) {
            throw errors.cli(CliCode.RESOLVE_TIMEOUT, {
                message: `workspaces.resolve() did not complete within ${timeoutMs}ms`,
                context: { timeoutMs },
            });
        }
        throw errors.cli(CliCode.RESOLVE_FAILED, {
            message: `workspaces.resolve() threw: ${err instanceof Error ? err.message : String(err)}`,
            cause: err instanceof Error ? err : new Error(String(err)),
        });
    }

    if (typeof returned !== 'string' || returned.length === 0) {
        throw errors.cli(CliCode.RESOLVE_FAILED, {
            message: `workspaces.resolve() must return a non-empty string`,
            context: { returned: String(returned) },
        });
    }
    return returned;
}

// ── Timeout helper ─────────────────────────────────────────────────────────

const TIMEOUT_SENTINEL = Symbol('resolve-timeout');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(TIMEOUT_SENTINEL), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (err) => {
                clearTimeout(t);
                reject(err);
            },
        );
    });
}

function isTimeoutSentinel(err: unknown): boolean {
    return err === TIMEOUT_SENTINEL;
}
