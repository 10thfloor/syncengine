import { describe, it, expect, vi } from 'vitest';
import { resolveWorkspace } from '../resolve.ts';
import { ProvisionCache } from '../provision-cache.ts';
import { SyncEngineError } from '@syncengine/core';
import type { SyncengineConfig, SyncengineUser } from '@syncengine/core';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeRequest(url = 'http://localhost/', headers: Record<string, string> = {}): Request {
    return new Request(url, { headers });
}

function makeConfig(overrides: {
    resolve?: SyncengineConfig['workspaces']['resolve'];
    verify?: SyncengineConfig['auth'] extends infer A ? A extends { verify: infer V } ? V : never : never;
} = {}): SyncengineConfig {
    return {
        workspaces: {
            resolve: overrides.resolve ?? (() => 'default'),
        },
        ...(overrides.verify ? { auth: { verify: overrides.verify as never } } : {}),
    };
}

function makeCache(): ProvisionCache {
    return new ProvisionCache(async () => {});
}

// ── Happy path ─────────────────────────────────────────────────────────────

describe('resolveWorkspace — happy path', () => {
    it('returns workspaceId, wsKey, and user for a valid resolve', async () => {
        const cache = makeCache();
        const config = makeConfig({ resolve: () => 'team-b' });

        const result = await resolveWorkspace(makeRequest(), { config, provisionCache: cache });

        expect(result.workspaceId).toBe('team-b');
        expect(result.wsKey).toHaveLength(16);
        expect(result.wsKey).toMatch(/^[a-f0-9]{16}$/);
        expect(result.user.id).toBe('anonymous');
    });

    it('hashes the workspaceId deterministically (same id → same wsKey)', async () => {
        const cache = makeCache();
        const config = makeConfig({ resolve: () => 'alice' });

        const r1 = await resolveWorkspace(makeRequest(), { config, provisionCache: cache });
        const r2 = await resolveWorkspace(makeRequest(), { config, provisionCache: cache });

        expect(r1.wsKey).toBe(r2.wsKey);
    });

    it('produces different wsKeys for different workspaceIds', async () => {
        const cache = makeCache();
        const alice = await resolveWorkspace(makeRequest(), {
            config: makeConfig({ resolve: () => 'alice' }),
            provisionCache: cache,
        });
        const bob = await resolveWorkspace(makeRequest(), {
            config: makeConfig({ resolve: () => 'bob' }),
            provisionCache: cache,
        });

        expect(alice.wsKey).not.toBe(bob.wsKey);
    });

    it('awaits async resolve() functions', async () => {
        const config = makeConfig({
            resolve: async () => {
                await new Promise((r) => setTimeout(r, 5));
                return 'later';
            },
        });

        const result = await resolveWorkspace(makeRequest(), {
            config,
            provisionCache: makeCache(),
        });
        expect(result.workspaceId).toBe('later');
    });

    it('passes the request to resolve()', async () => {
        const spy = vi.fn((_ctx: { request: Request; user: SyncengineUser }) => 'ok');
        const config = makeConfig({ resolve: spy });
        const request = makeRequest('http://localhost/dashboard?foo=bar');

        await resolveWorkspace(request, { config, provisionCache: makeCache() });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0].request.url).toContain('/dashboard?foo=bar');
    });
});

// ── Provisioning ───────────────────────────────────────────────────────────

describe('resolveWorkspace — provisioning', () => {
    it('calls ensureProvisioned with the derived wsKey', async () => {
        const calls: string[] = [];
        const cache = new ProvisionCache(async (wsKey) => {
            calls.push(wsKey);
        });

        const result = await resolveWorkspace(makeRequest(), {
            config: makeConfig({ resolve: () => 'alice' }),
            provisionCache: cache,
        });

        expect(calls).toEqual([result.wsKey]);
    });

    it('throws RESTATE_UNREACHABLE when provisioning fails', async () => {
        const cache = new ProvisionCache(async () => {
            throw new Error('restate down');
        });

        await expect(
            resolveWorkspace(makeRequest(), {
                config: makeConfig({ resolve: () => 'alice' }),
                provisionCache: cache,
            }),
        ).rejects.toMatchObject({
            code: 'RESTATE_UNREACHABLE',
            category: 'connection',
        });
    });

    it('calls onProvisionError instead of throwing when the callback is supplied', async () => {
        const cache = new ProvisionCache(async () => {
            throw new Error('restate down');
        });
        const onProvisionError = vi.fn();

        const result = await resolveWorkspace(makeRequest(), {
            config: makeConfig({ resolve: () => 'alice' }),
            provisionCache: cache,
            onProvisionError,
        });

        expect(result.workspaceId).toBe('alice');
        expect(result.wsKey).toHaveLength(16);
        expect(onProvisionError).toHaveBeenCalledTimes(1);
        const [err, wsKey] = onProvisionError.mock.calls[0]!;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('restate down');
        expect(wsKey).toBe(result.wsKey);
    });

    it('does not call onProvisionError on success', async () => {
        const onProvisionError = vi.fn();
        await resolveWorkspace(makeRequest(), {
            config: makeConfig({ resolve: () => 'alice' }),
            provisionCache: makeCache(),
            onProvisionError,
        });
        expect(onProvisionError).not.toHaveBeenCalled();
    });
});

// ── Auth ───────────────────────────────────────────────────────────────────

describe('resolveWorkspace — auth.verify', () => {
    it('uses anonymous user when no auth config is declared', async () => {
        const spy = vi.fn(() => 'ok');
        await resolveWorkspace(makeRequest(), {
            config: makeConfig({ resolve: spy }),
            provisionCache: makeCache(),
        });

        expect(spy.mock.calls[0]?.[0].user).toEqual({ id: 'anonymous' });
    });

    it('passes the verified user into resolve() when auth.verify returns one', async () => {
        const spy = vi.fn(() => 'ok');
        await resolveWorkspace(makeRequest(), {
            config: makeConfig({
                resolve: spy,
                verify: async () => ({ id: 'alice', email: 'a@b' }),
            }),
            provisionCache: makeCache(),
        });

        expect(spy.mock.calls[0]?.[0].user).toEqual({ id: 'alice', email: 'a@b' });
    });

    it('soft-fails to anonymous when auth.verify returns null', async () => {
        const spy = vi.fn(() => 'ok');
        await resolveWorkspace(makeRequest(), {
            config: makeConfig({
                resolve: spy,
                verify: async () => null,
            }),
            provisionCache: makeCache(),
        });

        expect(spy.mock.calls[0]?.[0].user).toEqual({ id: 'anonymous' });
    });

    it('soft-fails to anonymous when auth.verify throws', async () => {
        const spy = vi.fn(() => 'ok');
        await resolveWorkspace(makeRequest(), {
            config: makeConfig({
                resolve: spy,
                verify: async () => {
                    throw new Error('token expired');
                },
            }),
            provisionCache: makeCache(),
        });

        expect(spy.mock.calls[0]?.[0].user).toEqual({ id: 'anonymous' });
    });

    it('calls verify before resolve (verify can gate what resolve sees)', async () => {
        const order: string[] = [];
        await resolveWorkspace(makeRequest(), {
            config: makeConfig({
                resolve: () => {
                    order.push('resolve');
                    return 'ok';
                },
                verify: async () => {
                    order.push('verify');
                    return { id: 'alice' };
                },
            }),
            provisionCache: makeCache(),
        });

        expect(order).toEqual(['verify', 'resolve']);
    });
});

// ── Error handling ─────────────────────────────────────────────────────────

describe('resolveWorkspace — errors', () => {
    it('throws RESOLVE_FAILED when resolve() throws', async () => {
        await expect(
            resolveWorkspace(makeRequest(), {
                config: makeConfig({
                    resolve: () => {
                        throw new Error('bad state');
                    },
                }),
                provisionCache: makeCache(),
            }),
        ).rejects.toMatchObject({
            code: 'RESOLVE_FAILED',
            category: 'cli',
        });
    });

    it('preserves the original error as cause when resolve() throws', async () => {
        const original = new Error('bad state');
        try {
            await resolveWorkspace(makeRequest(), {
                config: makeConfig({
                    resolve: () => {
                        throw original;
                    },
                }),
                provisionCache: makeCache(),
            });
            expect.unreachable();
        } catch (err) {
            expect((err as SyncEngineError).cause).toBe(original);
        }
    });

    it('throws RESOLVE_FAILED on empty string return', async () => {
        await expect(
            resolveWorkspace(makeRequest(), {
                config: makeConfig({ resolve: () => '' }),
                provisionCache: makeCache(),
            }),
        ).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
    });

    it('throws RESOLVE_FAILED on non-string return', async () => {
        await expect(
            resolveWorkspace(makeRequest(), {
                config: makeConfig({ resolve: () => 42 as unknown as string }),
                provisionCache: makeCache(),
            }),
        ).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
    });

    it('throws RESOLVE_TIMEOUT when resolve() exceeds the configured timeout', async () => {
        const config = makeConfig({
            resolve: () => new Promise<string>((r) => setTimeout(() => r('late'), 200)),
        });

        await expect(
            resolveWorkspace(makeRequest(), {
                config,
                provisionCache: makeCache(),
                resolveTimeoutMs: 20,
            }),
        ).rejects.toMatchObject({
            code: 'RESOLVE_TIMEOUT',
            category: 'cli',
        });
    });

    it('does not time out when resolve() finishes inside the budget', async () => {
        const config = makeConfig({
            resolve: () => new Promise<string>((r) => setTimeout(() => r('ok'), 10)),
        });

        const result = await resolveWorkspace(makeRequest(), {
            config,
            provisionCache: makeCache(),
            resolveTimeoutMs: 100,
        });
        expect(result.workspaceId).toBe('ok');
    });
});
