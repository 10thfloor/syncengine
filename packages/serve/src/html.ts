import {
    ProvisionCache,
    createHtmlInjector,
    resolveWorkspace,
    type HtmlInjectorMeta,
} from '@syncengine/http-core';
import { SyncEngineError, formatError, errors, CliCode } from '@syncengine/core';
import type { SyncengineConfig } from '@syncengine/core';

export interface HtmlHandlerOptions {
    /** Pre-read contents of dist/index.html. */
    readonly indexHtml: string;
    /** The user's syncengine config (imported from dist/server/config.mjs). */
    readonly config: SyncengineConfig;
    /** Shared provision cache (typically one per process). */
    readonly provisionCache: ProvisionCache;
    /** URL threaded into the client via meta tag. */
    readonly natsUrl: string;
    /** URL threaded into the client via meta tag. */
    readonly restateUrl: string;
    /** Optional gateway WS URL, omitted from meta if undefined. */
    readonly gatewayUrl?: string;
    /** Surface full platform error renders in 500 bodies (dev only). */
    readonly devMode: boolean;
    /** Override resolve() timeout (default 5000 per design §8). */
    readonly resolveTimeoutMs?: number;
}

const INDEX_HTML_HEADERS: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
};

/**
 * Build the HTML route handler. Single point of truth for:
 *   - GET/HEAD-only enforcement (405 otherwise)
 *   - Delegating the resolve/auth/provision pipeline to http-core
 *   - Injecting meta tags into dist/index.html
 *   - Mapping typed platform errors to HTTP status codes (design §3f)
 *   - Echoing / generating X-Request-Id
 */
export function createHtmlHandler(opts: HtmlHandlerOptions) {
    const injector = createHtmlInjector(opts.indexHtml);

    return async (req: Request): Promise<Response> => {
        const requestId =
            req.headers.get('x-request-id') ?? crypto.randomUUID();

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return new Response('method not allowed', {
                status: 405,
                headers: {
                    'content-type': 'text/plain; charset=utf-8',
                    allow: 'GET, HEAD',
                    'x-request-id': requestId,
                },
            });
        }

        let wsKey: string;
        try {
            const result = await resolveWorkspace(req, {
                config: opts.config,
                provisionCache: opts.provisionCache,
                resolveTimeoutMs: opts.resolveTimeoutMs,
            });
            wsKey = result.wsKey;
        } catch (err) {
            return renderError(err, opts.devMode, requestId);
        }

        const meta: HtmlInjectorMeta = {
            workspaceId: wsKey,
            natsUrl: opts.natsUrl,
            restateUrl: opts.restateUrl,
            ...(opts.gatewayUrl ? { gatewayUrl: opts.gatewayUrl } : {}),
        };
        const body = injector.inject(meta);

        if (req.method === 'HEAD') {
            return new Response(null, {
                status: 200,
                headers: { ...INDEX_HTML_HEADERS, 'x-request-id': requestId },
            });
        }
        return new Response(body, {
            status: 200,
            headers: { ...INDEX_HTML_HEADERS, 'x-request-id': requestId },
        });
    };
}

function statusFor(err: SyncEngineError): number {
    if (err.code === CliCode.RESOLVE_TIMEOUT) return 504;
    if (err.code === CliCode.RESOLVE_FAILED) return 500;
    // RESTATE_UNREACHABLE on the provision step is a bad gateway
    if (err.category === 'connection') return 502;
    return 500;
}

function renderError(
    rawErr: unknown,
    devMode: boolean,
    requestId: string,
): Response {
    const err: SyncEngineError = rawErr instanceof SyncEngineError
        ? rawErr
        : errors.cli(CliCode.RESOLVE_FAILED, {
            message: rawErr instanceof Error ? rawErr.message : String(rawErr),
            cause: rawErr instanceof Error ? rawErr : new Error(String(rawErr)),
        });

    const status = statusFor(err);
    const body = devMode
        ? formatError(err, { color: false })
        : 'workspace resolution failed — see server logs';

    return new Response(body, {
        status,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'x-request-id': requestId,
        },
    });
}
