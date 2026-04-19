/**
 * Framework-agnostic gateway orchestration.
 *
 * Owns per-workspace NATS bridges, the registry broadcast subscription,
 * and the per-client protocol dispatch. Transport-specific glue (Node
 * `ws`, Bun `ServerWebSocket`) lives in consumer packages and reaches
 * GatewayCore through the `GatewayClientWs` duck-typed interface.
 *
 * Wiring contract for the consumer:
 *   1. On WebSocket upgrade → `core.attach(clientWs)` → session handle.
 *   2. On message → `session.handleMessage(rawFrame)`.
 *   3. On close → `session.handleClose()`.
 *   4. At shutdown → `core.shutdown()`.
 */

import { type NatsConnection, type Subscription } from '@nats-io/transport-node';
import { instrument } from '@syncengine/observe';
import { ClientSession, type GatewayClientWs } from './client-session';
import { WorkspaceBridge } from './workspace-bridge';
import { connectNats } from './nats-connect';
import { isValidClientMsg } from './protocol';
import type { ClientInitMessage, ClientMsg } from './protocol';
import { PASSTHROUGH_AUTH_HOOK, type AuthHook } from './auth-hook';

export interface GatewayConfig {
    readonly natsUrl: string;
    readonly restateUrl: string;
    /** Auth injection point — defaults to PASSTHROUGH_AUTH_HOOK, which
     *  preserves pre-Plan-4 behavior (no token verification, every
     *  channel subscription allowed). Apps with auth declared in their
     *  SyncengineConfig wire a real hook via @syncengine/server. */
    readonly authHook?: AuthHook;
}

export interface GatewaySessionHandle {
    /** Forward a protocol frame the client just sent us. */
    handleMessage(raw: string | Buffer): Promise<void>;
    /** Called when the client's underlying WebSocket closes. */
    handleClose(): void;
}

export class GatewayCore {
    private readonly config: GatewayConfig;
    private readonly authHook: AuthHook;
    private readonly bridges = new Map<string, WorkspaceBridge>();
    private readonly bridgeCreating = new Map<string, Promise<WorkspaceBridge>>();
    private readonly allSessions = new Set<ClientSession>();
    private systemNc: NatsConnection | null = null;
    private systemSub: Subscription | null = null;

    constructor(config: GatewayConfig) {
        this.config = config;
        this.authHook = config.authHook ?? PASSTHROUGH_AUTH_HOOK;
        // Start the system-level workspace-registry broadcast
        // subscription in the background. If NATS is unreachable at
        // boot we log and keep going — new-workspace notifications
        // are a nice-to-have, not a blocker.
        this.subscribeWorkspaceRegistry().catch((err) => {
            console.warn('[gateway] workspace registry subscription failed:', err);
        });
    }

    attach(ws: GatewayClientWs): GatewaySessionHandle {
        let session: ClientSession | null = null;
        let bridge: WorkspaceBridge | null = null;
        let authToken: string | undefined;

        const closeWith = (message: string, code: string): void => {
            try {
                ws.send(JSON.stringify({ type: 'error', message, code }));
            } catch { /* ws already dead */ }
            try { ws.close(1011, code); } catch { /* best effort */ }
        };

        return {
            handleMessage: async (raw: string | Buffer) => {
                // Parse the frame before spinning a span — invalid
                // JSON / bad shape gets an inline error reply, no
                // span emitted.
                let msg: ClientMsg;
                try {
                    const parsed: unknown = JSON.parse(raw.toString());
                    if (!isValidClientMsg(parsed)) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
                        return;
                    }
                    msg = parsed;
                } catch {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
                    return;
                }

                // Every throw inside the dispatch becomes a graceful
                // `error` frame + close instead of an unhandled
                // rejection that would crash the host process. Wrap
                // the dispatch in a per-message span — session id and
                // workspace may be absent for the first message (the
                // init) so the attrs are optional.
                await instrument.gatewayMessage(
                    {
                        messageType: msg.type,
                        ...(session?.clientId !== undefined && { sessionId: session.clientId }),
                        ...(session?.workspaceId !== undefined && { workspace: session.workspaceId }),
                    },
                    async () => {
                        try {
                            if (msg.type === 'init') {
                                if (session) {
                                    ws.send(JSON.stringify({ type: 'error', message: 'Already initialized', code: 'REINIT' }));
                                    return;
                                }
                                const init = msg as ClientInitMessage;

                                // Plan 4: verify the auth token via the injected
                                // hook. Fail closed if a token was provided but
                                // the hook rejects it. Absence of a token is OK
                                // — the session stays anonymous (user = null) and
                                // only Access.public channels will subscribe.
                                const verifiedUser = await this.authHook.verifyInit(
                                    init.authToken,
                                    init.workspaceId,
                                );
                                if (init.authToken && verifiedUser === null) {
                                    closeWith('Unauthorized', 'UNAUTHORIZED');
                                    return;
                                }

                                session = new ClientSession(init.clientId, ws);
                                session.user = verifiedUser;
                                session.workspaceId = init.workspaceId;
                                authToken = init.authToken;
                                bridge = await this.getOrCreateBridge(init.workspaceId);
                                bridge.addSession(session);

                                await bridge.ensureEntityWritesConsumer();
                                // Authorize each init-time channel BEFORE spinning
                                // up its consumer. Rejected channels are silently
                                // skipped — the client's `channels` config is a
                                // hint, not a contract.
                                for (const ch of init.channels) {
                                    const allowed = await this.authHook.authorizeChannel(
                                        verifiedUser,
                                        init.workspaceId,
                                        ch,
                                    );
                                    if (!allowed) {
                                        ws.send(JSON.stringify({
                                            type: 'error',
                                            message: `Access denied for channel '${ch}'`,
                                            code: 'ACCESS_DENIED',
                                        }));
                                        continue;
                                    }
                                    await bridge.ensureChannelConsumer(ch);
                                }

                                this.allSessions.add(session);
                                ws.send(JSON.stringify({ type: 'ready' }));
                                return;
                            }

                            if (!session || !bridge) {
                                ws.send(JSON.stringify({ type: 'error', message: 'Must send init first', code: 'NO_INIT' }));
                                return;
                            }

                            switch (msg.type) {
                                case 'subscribe':
                                    if (msg.kind === 'channel') {
                                        // Plan 4: authorize the channel subscription
                                        // before any NATS consumer spins up. If the
                                        // policy rejects, send ACCESS_DENIED and
                                        // skip — no data flows to this session for
                                        // this channel.
                                        const allowed = await this.authHook.authorizeChannel(
                                            session.user,
                                            session.workspaceId,
                                            msg.name,
                                        );
                                        if (!allowed) {
                                            ws.send(JSON.stringify({
                                                type: 'error',
                                                message: `Access denied for channel '${msg.name}'`,
                                                code: 'ACCESS_DENIED',
                                            }));
                                            break;
                                        }
                                        // Mark replaying BEFORE subscribing so the live
                                        // consumer skips this session until replay-end.
                                        if (msg.lastSeq != null && msg.lastSeq > 0) {
                                            session.replayingChannels.add(msg.name);
                                        }
                                        session.subscribeChannel(msg.name);
                                        await bridge.ensureChannelConsumer(msg.name);
                                        if (msg.lastSeq != null && msg.lastSeq > 0) {
                                            bridge.replayChannel(session, msg.name, msg.lastSeq);
                                            session.replayingChannels.delete(msg.name);
                                        } else {
                                            session.send({ type: 'replay-end', channel: msg.name });
                                        }
                                    } else if (msg.kind === 'entity') {
                                        session.subscribeEntity(msg.entity, msg.key);
                                    } else if (msg.kind === 'topic') {
                                        session.subscribeTopic(msg.name, msg.key);
                                    }
                                    break;

                                case 'unsubscribe':
                                    if (msg.kind === 'channel') session.unsubscribeChannel(msg.name);
                                    else if (msg.kind === 'entity') session.unsubscribeEntity(msg.entity, msg.key);
                                    else if (msg.kind === 'topic') session.unsubscribeTopic(msg.name, msg.key);
                                    break;

                                case 'publish':
                                    if (msg.kind === 'delta') {
                                        const subject = `ws.${bridge.workspaceId}.ch.${msg.channel}.deltas`;
                                        bridge.publishDelta(subject, msg.payload);
                                    } else if (msg.kind === 'topic') {
                                        bridge.publishTopicLocal(msg.name, msg.key, msg.payload, session.clientId);
                                    } else if (msg.kind === 'authority') {
                                        void bridge.publishAuthority(msg.viewName, msg.deltas, authToken);
                                    }
                                    break;
                            }
                        } catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            console.warn(`[gateway] session error: ${message}`);
                            closeWith(`gateway bridge failed: ${message}`, 'BRIDGE_FAILED');
                        }
                    },
                );
            },
            handleClose: () => {
                if (session) this.allSessions.delete(session);
                if (session && bridge) bridge.removeSession(session);
            },
        };
    }

    async shutdown(): Promise<void> {
        if (this.systemSub) this.systemSub.unsubscribe();
        if (this.systemNc && !this.systemNc.isClosed()) await this.systemNc.drain();
        for (const [, bridge] of this.bridges) {
            await bridge.stop();
        }
        this.bridges.clear();
        this.allSessions.clear();
    }

    private getOrCreateBridge(workspaceId: string): Promise<WorkspaceBridge> {
        const existing = this.bridges.get(workspaceId);
        if (existing) return Promise.resolve(existing);

        let inflight = this.bridgeCreating.get(workspaceId);
        if (!inflight) {
            inflight = this.createBridge(workspaceId).finally(() => {
                this.bridgeCreating.delete(workspaceId);
            });
            this.bridgeCreating.set(workspaceId, inflight);
        }
        return inflight;
    }

    private async createBridge(workspaceId: string): Promise<WorkspaceBridge> {
        const bridge = new WorkspaceBridge({
            natsUrl: this.config.natsUrl,
            restateUrl: this.config.restateUrl,
            workspaceId,
        });
        bridge.onEmpty = () => {
            void bridge.stop();
            this.bridges.delete(workspaceId);
        };
        await bridge.start();
        this.bridges.set(workspaceId, bridge);
        return bridge;
    }

    private async subscribeWorkspaceRegistry(): Promise<void> {
        this.systemNc = await connectNats(this.config.natsUrl);
        this.systemSub = this.systemNc.subscribe('syncengine.workspaces');
        (async () => {
            for await (const msg of this.systemSub!) {
                try {
                    const data = msg.json<Record<string, unknown>>();
                    // Revocation: close any connected session belonging to
                    // the removed member so their view of the workspace
                    // drops fast instead of waiting for the next channel
                    // subscribe to fail (Plan 4 / Gap 3).
                    if (data['type'] === 'WORKSPACE_ACCESS_REVOKED') {
                        const revokedWs = typeof data['workspaceId'] === 'string' ? data['workspaceId'] : '';
                        const revokedUser = typeof data['userId'] === 'string' ? data['userId'] : '';
                        for (const session of this.allSessions) {
                            if (
                                session.workspaceId === revokedWs &&
                                session.user?.id === revokedUser
                            ) {
                                session.send({
                                    type: 'error',
                                    code: 'WORKSPACE_ACCESS_REVOKED',
                                    message: `Membership in workspace '${revokedWs}' was revoked`,
                                });
                                // The WS close is best-effort — ClientSession
                                // doesn't own the underlying socket, the host
                                // adapter does. An error frame + the client
                                // reading code === WORKSPACE_ACCESS_REVOKED
                                // is the defined contract.
                            }
                        }
                        continue;
                    }
                    for (const session of this.allSessions) {
                        session.send({ type: 'workspace-registry', ...data });
                    }
                } catch { /* decode error */ }
            }
        })().catch(() => { /* sub closed */ });
    }
}
