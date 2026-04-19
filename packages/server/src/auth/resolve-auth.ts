import type { AuthProvider, AuthUser } from '@syncengine/core';

/**
 * Verify an incoming `Authorization: Bearer …` header and enrich the
 * resulting user with their per-workspace role. Returns `null` when:
 *   - no provider is configured (pre-auth app — Access.public handlers
 *     still work; other policies fail closed)
 *   - no Authorization header is present
 *   - the provider rejects the token
 *
 * The null path intentionally does NOT throw. Access.public is the only
 * policy that permits null users; all other policies reject the null
 * user themselves via their check() semantics (see packages/core/auth.ts).
 */
export async function resolveAuth(input: {
    provider: AuthProvider | undefined;
    authHeader: string | undefined;
    workspaceId: string;
    lookupRole: (userId: string, workspaceId: string) => Promise<string | null>;
}): Promise<AuthUser | null> {
    if (!input.provider) return null;

    const token = extractBearer(input.authHeader);
    if (!token) return null;

    const result = await input.provider.verify(token);
    if (!result.ok) return null;

    const role = await input.lookupRole(result.user.id, input.workspaceId);
    return {
        ...result.user,
        roles: role ? [role] : [],
    };
}

/** Parse `Authorization: Bearer <token>`, case-insensitive prefix. */
function extractBearer(header: string | undefined): string | null {
    if (!header) return null;
    const match = header.match(/^bearer\s+(.+)$/i);
    return match && match[1] ? match[1].trim() : null;
}
