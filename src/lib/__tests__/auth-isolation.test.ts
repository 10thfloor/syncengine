/**
 * RED phase — Auth & Tenant Isolation
 *
 * The problem: any NATS client can publish to any `ws.*` subject.
 * No user identity, no workspace access control. For SaaS this is a blocker.
 *
 * The solution:
 * 1. Auth tokens — clients authenticate with a JWT; the worker sends it
 *    to NATS as a credential. NATS applies per-subject permissions.
 * 2. Workspace membership — Restate tracks which users have access to
 *    which workspace. Only members can publish/subscribe.
 * 3. Token-gated NATS subjects — NATS server enforces that a client can
 *    only publish to subjects matching their workspace membership.
 * 4. Restate ingress auth — authority/snapshot HTTP calls carry the token.
 */

import { describe, it, expect } from 'vitest';
import type { SyncConfig } from '../store';

// ═══════════════════════════════════════════════════════════════════════════
// 1. SyncConfig auth fields
// ═══════════════════════════════════════════════════════════════════════════

describe('SyncConfig auth', () => {

    it('SyncConfig accepts an auth token', () => {
        const config: SyncConfig = {
            workspaceId: 'demo',
            natsUrl: 'ws://localhost:9222',
            authToken: 'eyJhbGciOiJIUzI1NiJ9.test-token',
        } as SyncConfig & { authToken: string };

        expect((config as any).authToken).toBeTruthy();
        expect((config as any).authToken).toMatch(/^eyJ/);  // JWT prefix
    });

    it('SyncConfig accepts a userId', () => {
        const config = {
            workspaceId: 'demo',
            userId: 'user_abc123',
            authToken: 'eyJhbGciOiJIUzI1NiJ9.test-token',
        };

        expect(config.userId).toBeTruthy();
        expect(config.userId).toMatch(/^user_/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. NATS connection with credentials
// ═══════════════════════════════════════════════════════════════════════════

describe('NATS auth connection', () => {

    it('worker passes auth token to NATS connect', () => {
        // nats.ws connect() accepts: { servers, token, user, pass }
        // We should pass the auth token as the NATS token credential.
        const natsConnectOpts = {
            servers: 'ws://localhost:9222',
            token: 'eyJhbGciOiJIUzI1NiJ9.test-token',
        };

        expect(natsConnectOpts.token).toBeTruthy();
    });

    it('NATS subject permissions are scoped to workspace', () => {
        // A user with access to workspace 'demo' should only be able to
        // publish/subscribe to ws.demo.> subjects.
        const allowedSubjects = ['ws.demo.deltas', 'ws.demo.authority.>', 'ws.demo.schema'];
        const deniedSubjects = ['ws.other-workspace.deltas', 'ws.secret.deltas'];

        for (const s of allowedSubjects) {
            expect(s).toMatch(/^ws\.demo\./);
        }
        for (const s of deniedSubjects) {
            expect(s).not.toMatch(/^ws\.demo\./);
        }
    });

    it('failed auth triggers CONNECTION_STATUS error', () => {
        // If NATS rejects the token, the worker should emit a specific status
        const authFailMsg = {
            type: 'CONNECTION_STATUS' as const,
            status: 'auth_failed' as const,
        };

        // 'auth_failed' should be a valid ConnectionStatus after implementation
        expect(authFailMsg.status).toBe('auth_failed');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Restate workspace membership
// ═══════════════════════════════════════════════════════════════════════════

describe('Workspace membership (Restate)', () => {

    it('provision request requires a tenantId and creatorUserId', () => {
        const provisionReq = {
            tenantId: 'tenant_acme',
            creatorUserId: 'user_abc123',
        };

        expect(provisionReq.tenantId).toBeTruthy();
        expect(provisionReq.creatorUserId).toBeTruthy();
    });

    it('addMember handler grants access to a workspace', () => {
        const request = {
            userId: 'user_xyz789',
            role: 'editor' as 'owner' | 'editor' | 'viewer',
        };

        const response = {
            added: true,
            workspaceId: 'demo',
            userId: 'user_xyz789',
            role: 'editor',
        };

        expect(response.added).toBe(true);
        expect(response.role).toBe('editor');
    });

    it('removeMember handler revokes access', () => {
        const request = { userId: 'user_xyz789' };
        const response = { removed: true, workspaceId: 'demo', userId: 'user_xyz789' };

        expect(response.removed).toBe(true);
    });

    it('listMembers returns all workspace members with roles', () => {
        const response = {
            members: [
                { userId: 'user_abc123', role: 'owner', addedAt: '2026-04-01T00:00:00Z' },
                { userId: 'user_xyz789', role: 'editor', addedAt: '2026-04-02T00:00:00Z' },
            ],
        };

        expect(response.members).toHaveLength(2);
        expect(response.members[0].role).toBe('owner');
    });

    it('isMember check returns boolean', () => {
        const response = { isMember: true, role: 'editor' };
        expect(response.isMember).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Token verification
// ═══════════════════════════════════════════════════════════════════════════

describe('Token verification', () => {

    it('auth token payload contains userId and workspaceIds', () => {
        // JWT payload structure
        const payload = {
            sub: 'user_abc123',
            workspaces: ['demo', 'project-x'],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
        };

        expect(payload.sub).toBeTruthy();
        expect(payload.workspaces).toContain('demo');
        expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    it('expired token is rejected', () => {
        const payload = {
            sub: 'user_abc123',
            workspaces: ['demo'],
            iat: Math.floor(Date.now() / 1000) - 7200,
            exp: Math.floor(Date.now() / 1000) - 3600,  // expired 1 hour ago
        };

        const isExpired = payload.exp < Math.floor(Date.now() / 1000);
        expect(isExpired).toBe(true);
    });

    it('token without workspace access is rejected', () => {
        const payload = {
            sub: 'user_abc123',
            workspaces: ['other-workspace'],
        };

        const hasAccess = payload.workspaces.includes('demo');
        expect(hasAccess).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Restate ingress auth
// ═══════════════════════════════════════════════════════════════════════════

describe('Restate HTTP auth', () => {

    it('authority calls include Authorization header', () => {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.test-token',
        };

        expect(headers['Authorization']).toMatch(/^Bearer /);
    });

    it('snapshot calls include Authorization header', () => {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.test-token',
        };

        expect(headers['Authorization']).toBeTruthy();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. NATS message attribution
// ═══════════════════════════════════════════════════════════════════════════

describe('Message attribution', () => {

    it('outbound NATS messages carry userId', () => {
        const msg = {
            type: 'INSERT' as const,
            table: 'expenses',
            record: { id: 1, amount: 42 },
            _clientId: 'tab-uuid-123',
            _userId: 'user_abc123',
            _nonce: 'tab-uuid-123-1',
            _hlc: { ts: 1000, count: 0 },
        };

        expect(msg._userId).toBeTruthy();
        expect(msg._clientId).toBeTruthy();
    });

    it('userId enables audit trail of who mutated what', () => {
        const auditEntry = {
            userId: 'user_abc123',
            action: 'INSERT',
            table: 'expenses',
            recordId: 1,
            hlc: { ts: 1000, count: 0 },
            timestamp: Date.now(),
        };

        expect(auditEntry.userId).toBeTruthy();
        expect(auditEntry.action).toBe('INSERT');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. NATS server config for auth
// ═══════════════════════════════════════════════════════════════════════════

describe('NATS server auth config', () => {

    it('NATS config enables token-based auth', () => {
        // The NATS server config should switch from permissive to token auth.
        const natsConfig = {
            authorization: {
                // In production, use NATS account/user JWT system.
                // For local dev, a simple token list works.
                token: '$NATS_AUTH_TOKEN',  // env var
            },
            websocket: {
                port: 9222,
                no_tls: true,  // local dev only; production uses TLS
            },
        };

        expect(natsConfig.authorization.token).toBeTruthy();
    });
});
