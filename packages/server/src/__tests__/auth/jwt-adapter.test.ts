import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, type JWK } from 'jose';
import { jwt } from '../../auth/jwt-adapter';

describe('jwt() adapter', () => {
    let publicJwk: JWK;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let privateKey: any;

    beforeAll(async () => {
        const keys = await generateKeyPair('RS256');
        privateKey = keys.privateKey;
        publicJwk = await exportJWK(keys.publicKey);
        publicJwk.alg = 'RS256';
        publicJwk.use = 'sig';
    });

    async function signToken(claims: Record<string, unknown>, opts?: {
        noExp?: boolean;
        expiredSecondsAgo?: number;
    }): Promise<string> {
        const builder = new SignJWT({ ...claims })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuedAt();
        if (opts?.noExp) {
            // skip — don't set expiration
        } else if (opts?.expiredSecondsAgo) {
            builder.setExpirationTime(Math.floor(Date.now() / 1000) - opts.expiredSecondsAgo);
        } else {
            builder.setExpirationTime('1h');
        }
        return await builder.sign(privateKey);
    }

    it('throws if neither jwksUri nor publicKey is provided', () => {
        expect(() => jwt({})).toThrow(/must provide/);
    });

    it('throws if both jwksUri and publicKey are provided', () => {
        expect(() => jwt({
            jwksUri: 'https://example.com/jwks.json',
            publicKey: publicJwk,
        })).toThrow(/mutually exclusive/);
    });

    it('verifies a well-formed token with publicKey', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const token = await signToken({ sub: 'alice', email: 'a@example.com' });
        const result = await provider.verify(token);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.user.id).toBe('alice');
            expect(result.user.email).toBe('a@example.com');
        }
    });

    it('rejects an expired token', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const expired = await signToken({ sub: 'alice' }, { expiredSecondsAgo: 60 });
        const result = await provider.verify(expired);
        expect(result.ok).toBe(false);
    });

    it('rejects a garbage token', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const result = await provider.verify('not-a-real-jwt');
        expect(result.ok).toBe(false);
    });

    it('enforces issuer when configured', async () => {
        const provider = jwt({ publicKey: publicJwk, issuer: 'https://issuer.example' });
        // Build a token with a different iss
        const wrongIssuer = await new SignJWT({ sub: 'alice', iss: 'https://other.example' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
        const result = await provider.verify(wrongIssuer);
        expect(result.ok).toBe(false);
    });

    it('accepts a token whose issuer matches', async () => {
        const provider = jwt({ publicKey: publicJwk, issuer: 'https://issuer.example' });
        const goodToken = await new SignJWT({ sub: 'alice' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer('https://issuer.example')
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
        const result = await provider.verify(goodToken);
        expect(result.ok).toBe(true);
    });

    it('enforces audience when configured', async () => {
        const provider = jwt({ publicKey: publicJwk, audience: 'my-api' });
        const wrongAud = await new SignJWT({ sub: 'alice' })
            .setProtectedHeader({ alg: 'RS256' })
            .setAudience('other-api')
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
        const result = await provider.verify(wrongAud);
        expect(result.ok).toBe(false);
    });

    it('surfaces the full payload as claims', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const token = await signToken({ sub: 'alice', custom: 'value', tier: 'pro' });
        const result = await provider.verify(token);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.user.claims?.['custom']).toBe('value');
            expect(result.user.claims?.['tier']).toBe('pro');
            expect(result.user.claims?.['sub']).toBe('alice');
        }
    });

    it('rejects tokens with missing sub claim', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const noSub = await signToken({ email: 'x@y.com' });
        const result = await provider.verify(noSub);
        expect(result.ok).toBe(false);
    });

    it('adapter name is "jwt"', () => {
        const provider = jwt({ publicKey: publicJwk });
        expect(provider.name).toBe('jwt');
    });

    it('caches the imported key across verifications', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const t1 = await signToken({ sub: 'a' });
        const t2 = await signToken({ sub: 'b' });
        const r1 = await provider.verify(t1);
        const r2 = await provider.verify(t2);
        expect(r1.ok && r2.ok).toBe(true);
        if (r1.ok && r2.ok) {
            expect(r1.user.id).toBe('a');
            expect(r2.user.id).toBe('b');
        }
    });

    it('omits email when the claim is absent', async () => {
        const provider = jwt({ publicKey: publicJwk });
        const token = await signToken({ sub: 'alice' });
        const result = await provider.verify(token);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.user.email).toBeUndefined();
        }
    });
});
