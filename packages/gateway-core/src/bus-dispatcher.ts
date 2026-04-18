/**
 * `BusDispatcher` — one durable JetStream consumer per subscriber.
 *
 * Retry ownership, locked (see `bus-backoff.ts`):
 *   1. JetStream delivers. NAKs pick the next slot from the
 *      `backoff[]` schedule derived from the caller's `RetryConfig`.
 *      `max_deliver = attempts + 1` caps total deliveries.
 *   2. Restate dedups per invocation. We POST to ingress with an
 *      invocation id of `<bus>:<seq>` — every redelivery lands on
 *      the same invocation, so Restate's idempotency absorbs the
 *      retry without running the workflow body twice.
 *   3. Workflow body's own `ctx.run` step retries live _inside_ the
 *      workflow invocation and never interact with the dispatcher.
 *
 * Restate's response maps to:
 *   - 2xx          → ack
 *   - terminal     → publish the event to the DLQ bus, then ack
 *                    (no further JetStream redelivery, regardless of
 *                    `max_deliver`)
 *   - 5xx / netw   → nak; JetStream picks the next backoff slot
 *
 * `x-request-id` flows front-to-back: read off the incoming NATS
 * message, forwarded to the Restate ingress POST, and attached to
 * any DLQ publish so the DLQ tail stays correlated with the request.
 */

import {
    AckPolicy,
    jetstream,
    jetstreamManager,
    type ConsumerConfig,
    type Consumer,
    type JetStreamClient,
    type JetStreamManager,
    type JsMsg,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import type { DeadEvent, RetryConfig, ConcurrencyConfig, RateConfig } from '@syncengine/core';
import { connectNats } from './nats-connect';
import { retryToBackoffArray } from './bus-backoff';
import { cursorToDeliverPolicy, type CursorConfig } from './bus-cursor';
import { publishDeadEvent } from './bus-dlq';

const CONSUMER_BOOT_RETRY_MS = 500;
const CONSUMER_BOOT_MAX_WAIT_MS = 15_000;

export interface BusDispatcherConfig {
    readonly natsUrl: string;
    readonly restateUrl: string;
    readonly workspaceId: string;
    readonly busName: string;
    readonly subscriberName: string;
    /** Optional server-side predicate. Events that fail it are ACK'd
     *  without being dispatched — JetStream moves past them. */
    readonly filterPredicate?: (event: unknown) => boolean;
    readonly cursor: CursorConfig;
    readonly retry: RetryConfig;
    /** Name of the DLQ bus to publish to when Restate returns a
     *  terminal error. Typically `${busName}.dlq`. */
    readonly dlqBusName: string;
    /** How to derive Restate's invocation id from the incoming event.
     *  The framework resolves the `Subscription<T>.keying` variant to
     *  a concrete function in `BusManager` before constructing the
     *  dispatcher — the dispatcher just calls it per message.
     *
     *  Default (when omitted): `${busName}:${seq}` — exactly-once
     *  processing per JetStream seq, no ordering. Matches Phase 2a
     *  behaviour. */
    readonly invocationIdOf?: (seq: bigint, event: unknown) => string;
    /** In-flight invocation cap. `kind: 'global'` maps to the JetStream
     *  durable consumer's `max_ack_pending`; `perKey` is an in-process
     *  counter that isn't wired yet (throws at dispatcher start). */
    readonly concurrency?: ConcurrencyConfig;
    /** Token-bucket throttle. Not wired yet; declared here so the
     *  BusManager → dispatcher contract is stable once the runtime
     *  lands. */
    readonly rate?: RateConfig;
}

type RestateOutcome =
    | { readonly kind: 'ok' }
    | { readonly kind: 'terminal'; readonly error: { message: string; code?: string } }
    | { readonly kind: 'retriable'; readonly reason: string };

export class BusDispatcher {
    private readonly config: BusDispatcherConfig;
    private nc: NatsConnection | null = null;
    private js: JetStreamClient | null = null;
    private jsm: JetStreamManager | null = null;
    private stopped = false;
    private activeLoop: Promise<void> | null = null;
    private messagesHandle: { stop(): void } | null = null;

    constructor(config: BusDispatcherConfig) {
        this.config = config;
        // Fail loud at construction — the BusManager constructs one
        // dispatcher per (workspace × subscriber) and a thrown error
        // here means the declaration is unrunnable. Better to surface
        // during boot than to silently drop packets.
        this.validateUnsupportedModifiers();
    }

    async start(): Promise<void> {
        if (this.nc) {
            throw new Error(
                `[bus-dispatcher:${this.config.busName}:${this.config.subscriberName}] start() called twice`,
            );
        }
        this.nc = await connectNats(this.config.natsUrl);
        this.js = jetstream(this.nc);
        this.jsm = await jetstreamManager(this.nc);

        const consumer = await this.ensureConsumer();
        const messages = await consumer.consume();
        this.messagesHandle = { stop: () => messages.stop() };
        this.activeLoop = this.runDispatchLoop(messages);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.messagesHandle) this.messagesHandle.stop();
        if (this.activeLoop) await this.activeLoop.catch(() => { /* loop unwinding */ });
        if (this.nc && !this.nc.isClosed()) {
            await this.nc.drain();
        }
    }

    private streamName(): string {
        return `WS_${this.config.workspaceId.replace(/-/g, '_')}`;
    }

    private consumerName(): string {
        // NATS durable consumer names reject '.', '>', '*', and whitespace —
        // so `orderEvents.dlq` → `orderEvents_dlq` for the purpose of the
        // durable name only. The bus name on the wire (subject filter
        // below) still uses the original dot form.
        const safeBus = this.config.busName.replace(/\./g, '_');
        return `bus:${safeBus}:${this.config.subscriberName}`;
    }

    private filterSubject(): string {
        return `ws.${this.config.workspaceId}.bus.${this.config.busName}`;
    }

    private buildConsumerConfig(): Partial<ConsumerConfig> {
        const { backoffNs, maxDeliver } = retryToBackoffArray(this.config.retry);
        // `Nanos[]` on ConsumerConfig is `number[]`; narrow here. The
        // bigint internal representation is what the helper exposes,
        // but the wire type is number — everything fits in safe
        // integer range for any realistic backoff schedule.
        const backoff = backoffNs.map((ns) => Number(ns));
        const base: Partial<ConsumerConfig> = {
            name: this.consumerName(),
            durable_name: this.consumerName(),
            filter_subjects: [this.filterSubject()],
            ack_policy: AckPolicy.Explicit,
            max_deliver: maxDeliver,
            backoff,
        };
        // Concurrency.global(n) → JetStream bounds the count of
        // unacknowledged messages the consumer holds. Combined with
        // explicit ack, this is a strict in-flight cap: workers only
        // pull the next message after acking the previous one, so
        // `n` in-flight at most. Concurrency.perKey requires an
        // in-process counter and is enforced in the dispatch loop —
        // rejected at start() until that landing.
        const concurrency = this.config.concurrency;
        if (concurrency?.kind === 'global') {
            base.max_ack_pending = concurrency.limit;
        }
        return { ...base, ...cursorToDeliverPolicy(this.config.cursor) };
    }

    private validateUnsupportedModifiers(): void {
        if (this.config.concurrency?.kind === 'perKey') {
            throw new Error(
                `[bus-dispatcher:${this.config.busName}:${this.config.subscriberName}] ` +
                `Concurrency.perKey is declared but not wired yet (Phase 2b-B2). ` +
                `Use Concurrency.global(n) for now, or remove the modifier.`,
            );
        }
        if (this.config.rate) {
            throw new Error(
                `[bus-dispatcher:${this.config.busName}:${this.config.subscriberName}] ` +
                `Rate.* is declared but the token-bucket throttle isn't wired yet (Phase 2b-B2). ` +
                `Track the limit externally or remove the .rate() modifier for now.`,
            );
        }
    }

    /**
     * Ensure the durable consumer exists, then return a handle to it.
     *
     * The workspace stream may not exist when the dispatcher boots —
     * `loadDefinitions` spawns dispatchers immediately, and the stream
     * is created lazily by `provisionWorkspace`. Retry `consumers.get`
     * for ~15 seconds before giving up.
     */
    private async ensureConsumer(): Promise<Consumer> {
        if (!this.js || !this.jsm) {
            throw new Error('[bus-dispatcher] ensureConsumer called before start()');
        }
        const stream = this.streamName();
        const name = this.consumerName();
        const config = this.buildConsumerConfig();

        const start = Date.now();
        let lastErr: unknown;
        while (Date.now() - start < CONSUMER_BOOT_MAX_WAIT_MS) {
            if (this.stopped) throw new Error('[bus-dispatcher] stopped before consumer was ready');
            try {
                // jsm.consumers.add is create-or-update; if the consumer
                // already exists with matching config JetStream treats it
                // as a no-op. If the stream is missing we throw and retry.
                await this.jsm.consumers.add(stream, config);
                return await this.js.consumers.get(stream, name);
            } catch (err) {
                lastErr = err;
                await sleep(CONSUMER_BOOT_RETRY_MS);
            }
        }
        throw new Error(
            `[bus-dispatcher:${this.config.busName}:${this.config.subscriberName}] ` +
            `gave up waiting for stream ${stream}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        );
    }

    private async runDispatchLoop(messages: AsyncIterable<JsMsg>): Promise<void> {
        try {
            for await (const m of messages) {
                if (this.stopped) {
                    m.nak();
                    break;
                }
                await this.handleMessage(m);
            }
        } catch (err) {
            if (!this.stopped) {
                console.warn(
                    `[bus-dispatcher:${this.config.busName}:${this.config.subscriberName}] ` +
                    `dispatch loop exited: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }

    private async handleMessage(m: JsMsg): Promise<void> {
        const busName = this.config.busName;
        const subscriber = this.config.subscriberName;
        let event: unknown;
        try {
            event = m.json<unknown>();
        } catch (err) {
            // Undecodable payloads never succeed on retry. Send to DLQ and ack.
            console.warn(`[bus-dispatcher:${busName}:${subscriber}] malformed payload — sending to DLQ`);
            const requestId = readRequestId(m);
            await this.sendToDlq(event, {
                message: err instanceof Error ? err.message : String(err),
                code: 'MALFORMED_PAYLOAD',
            }, m, requestId);
            m.ack();
            return;
        }

        const requestId = readRequestId(m);

        if (this.config.filterPredicate && !this.config.filterPredicate(event)) {
            // Predicate rejection — the subscriber opted out. ACK and move on.
            m.ack();
            return;
        }

        const invocationId = this.config.invocationIdOf
            ? this.config.invocationIdOf(BigInt(m.seq), event)
            : `${busName}:${m.seq}`;
        let outcome: RestateOutcome;
        try {
            outcome = await postToRestate(
                this.config.restateUrl,
                subscriber,
                this.config.workspaceId,
                invocationId,
                event,
                requestId,
            );
        } catch (err) {
            // Any thrown error here is treated as retriable — fetch()
            // already maps to a structured result below, so reaching
            // this catch means something truly unexpected (abort,
            // DNS, etc.).
            console.warn(
                `[bus-dispatcher:${busName}:${subscriber}] restate post threw: ${
                    err instanceof Error ? err.message : String(err)
                } — NAK`,
            );
            m.nak();
            return;
        }

        switch (outcome.kind) {
            case 'ok':
                m.ack();
                return;
            case 'terminal':
                await this.sendToDlq(event, outcome.error, m, requestId);
                m.ack();
                return;
            case 'retriable':
                // Don't pass an explicit delay — JetStream's
                // `backoff[]` schedule supplies the next wait.
                m.nak();
                return;
        }
    }

    private async sendToDlq(
        original: unknown,
        error: { message: string; code?: string },
        m: JsMsg,
        requestId: string | undefined,
    ): Promise<void> {
        if (!this.nc) return;
        const firstAttemptAtMs = Number(m.timestampNanos / 1_000_000n);
        const dead: DeadEvent<unknown> = {
            original,
            error: { message: error.message, ...(error.code ? { code: error.code } : {}) },
            attempts: m.info.deliveryCount,
            firstAttemptAt: firstAttemptAtMs,
            lastAttemptAt: Date.now(),
            workflow: this.config.subscriberName,
        };
        try {
            await publishDeadEvent(
                this.nc,
                this.config.workspaceId,
                this.config.dlqBusName,
                dead,
                requestId,
            );
        } catch (err) {
            console.error(
                `[bus-dispatcher:${this.config.busName}:${this.config.subscriberName}] ` +
                `DLQ publish failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}

function readRequestId(m: JsMsg): string | undefined {
    if (!m.headers) return undefined;
    try {
        if (m.headers.has('x-request-id')) {
            const v = m.headers.get('x-request-id');
            return v.length > 0 ? v : undefined;
        }
    } catch {
        // headers impl varies; defensive
    }
    return undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST the event to Restate's ingress for the subscriber workflow,
 * using `<bus>:<seq>` as the invocation id. Restate's dedup keys on
 * the invocation id — every redelivery lands on the same invocation
 * and the workflow body runs exactly once.
 *
 * URL shape matches the `workflow_` service prefix every user workflow
 * registers under (see `packages/server/src/workflow.ts` and the
 * resolveWorkflowTarget helper in http-core). The virtual-object key
 * is `${workspaceId}/${invocationId}` URL-encoded as a single segment
 * — same contract the `/rpc/workflow/<name>/<inv>` proxy already uses.
 *
 * Mapping (Restate 1.6 ingress):
 *   - 2xx                             → ok (workflow completed)
 *   - 500                             → terminal. Restate's ingress blocks
 *                                       until the workflow reaches a
 *                                       terminal state; a 500 means the
 *                                       workflow threw `TerminalError`
 *                                       (or exhausted Restate's own
 *                                       retries). JetStream must NOT
 *                                       redeliver — publish to DLQ.
 *   - 502 / 503 / 504                 → retriable. Restate cluster itself
 *                                       is unavailable / gateway-timing
 *                                       out / load-shedding. NAK; next
 *                                       backoff slot retries.
 *   - 429                             → retriable. Restate is throttling
 *                                       (rare, but first-class).
 *   - Other 4xx w/ terminal-error body → terminal (conservative — rare,
 *                                        e.g. bad payload shape rejected
 *                                        synchronously).
 *   - Other 4xx                       → retriable.
 *   - network / abort / DNS failure   → retriable.
 */
export async function postToRestate(
    restateUrl: string,
    subscriberName: string,
    workspaceId: string,
    invocationId: string,
    event: unknown,
    requestId: string | undefined,
): Promise<RestateOutcome> {
    const service = `workflow_${subscriberName}`;
    const key = `${workspaceId}/${invocationId}`;
    const url = `${restateUrl.replace(/\/$/, '')}/${encodeURIComponent(service)}/${encodeURIComponent(key)}/run`;
    // Restate workflow handlers reject `idempotency-key` — the workflow
    // key itself (${workspaceId}/${invocationId}) already disambiguates,
    // so Restate dedups on its own. Sending the header yields a 400
    // "cannot use the idempotency key with workflow handlers".
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    };
    if (requestId) headers['x-request-id'] = requestId;

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(event),
        });
    } catch (err) {
        return { kind: 'retriable', reason: err instanceof Error ? err.message : String(err) };
    }

    if (response.status >= 200 && response.status < 300) {
        try { await response.text(); } catch { /* drain socket */ }
        return { kind: 'ok' };
    }

    let body = '';
    try { body = await response.text(); } catch { /* body read failed */ }
    const contentType = response.headers.get('content-type') ?? '';

    return classifyErrorResponse(response.status, contentType, body);
}

/** Pure classification — split out so unit tests can hammer it without
 *  a real HTTP server. */
export function classifyErrorResponse(
    status: number,
    contentType: string,
    body: string,
): RestateOutcome {
    // Parse the body as JSON once up-front — Restate surfaces errors
    // as `{ message, code? }` for both terminal and infra failures; the
    // distinguishing signal is the status code, not the shape.
    let parsed: { message?: unknown; code?: unknown } | null = null;
    if (contentType.includes('json') || body.trimStart().startsWith('{')) {
        try {
            parsed = JSON.parse(body) as { message?: unknown; code?: unknown };
        } catch { /* non-JSON body */ }
    }
    const terminalError = {
        message:
            (parsed && typeof parsed.message === 'string' ? parsed.message : body.slice(0, 500)) ||
            `restate ${status}`,
        ...(parsed && typeof parsed.code === 'string' ? { code: parsed.code } : {}),
    };

    // Infra 5xx — Restate itself is unavailable. Retry.
    if (status === 502 || status === 503 || status === 504) {
        return { kind: 'retriable', reason: `restate ${status}: ${body.slice(0, 200)}` };
    }

    // 500 — Restate's ingress blocks until the workflow reaches a
    // terminal state, so a 500 response means the workflow failed
    // terminally. Every 500 is a DLQ candidate.
    if (status === 500) {
        return { kind: 'terminal', error: terminalError };
    }

    // Other 5xx — unknown; be conservative and retry.
    if (status >= 500) {
        return { kind: 'retriable', reason: `restate ${status}: ${body.slice(0, 200)}` };
    }

    // 429 — rate-limited by Restate. Retry.
    if (status === 429) {
        return { kind: 'retriable', reason: `restate ${status}: rate limited` };
    }

    // 4xx — legacy "terminal-error" content-type + body marker path
    // handles Restate versions that surface the terminal synchronously.
    const hasTerminalMarker =
        contentType.includes('application/terminal-error') ||
        /terminal[\s_-]?error/i.test(body);
    if (hasTerminalMarker) {
        return { kind: 'terminal', error: terminalError };
    }

    // Everything else 4xx — request shape bug, Restate didn't accept it.
    // Retry conservatively; a persistent 4xx will exhaust max_deliver.
    return { kind: 'retriable', reason: `restate ${status}: ${body.slice(0, 200)}` };
}
