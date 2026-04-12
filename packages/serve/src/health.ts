/**
 * Liveness + readiness handlers.
 *
 * `/_health` (liveness): always returns 200. Confirms the process is
 * alive and responding to HTTP. Kubernetes uses this for livenessProbe.
 *
 * `/_ready` (readiness): returns 503 until `markReady()` is called,
 * then 200. Kubernetes uses this for readinessProbe so traffic is held
 * off until config has loaded and initial provisioning has succeeded.
 */

const START_TS = Date.now();

export async function healthHandler(req: Request): Promise<Response> {
    if (req.method === 'HEAD') {
        return new Response(null, {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    return Response.json({ ok: true, uptime_ms: Date.now() - START_TS });
}

export interface ReadinessHandle {
    readonly handler: (req: Request) => Promise<Response>;
    readonly markReady: () => void;
}

/**
 * Build a readiness handler whose state flips from 503 → 200 when
 * `markReady()` is called. Each handle owns its own state so tests can
 * instantiate independent probes.
 */
export function createReadinessHandler(): ReadinessHandle {
    let ready = false;
    return {
        async handler(req: Request): Promise<Response> {
            if (req.method === 'HEAD') {
                return new Response(null, {
                    status: ready ? 200 : 503,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return Response.json(
                { ok: ready },
                { status: ready ? 200 : 503 },
            );
        },
        markReady() {
            ready = true;
        },
    };
}
