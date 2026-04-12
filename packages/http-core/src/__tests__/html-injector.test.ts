import { describe, it, expect } from 'vitest';
import { createHtmlInjector } from '../html-injector.ts';

const BASE_HTML = `<!doctype html>
<html>
  <head>
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

describe('createHtmlInjector', () => {
    it('injects workspace/nats/restate meta tags before </head>', () => {
        const inject = createHtmlInjector(BASE_HTML).inject;
        const out = inject({
            workspaceId: 'abc123',
            natsUrl: 'ws://localhost:9222',
            restateUrl: 'http://localhost:8080',
        });

        expect(out).toContain('<meta name="syncengine-workspace-id" content="abc123">');
        expect(out).toContain('<meta name="syncengine-nats-url" content="ws://localhost:9222">');
        expect(out).toContain('<meta name="syncengine-restate-url" content="http://localhost:8080">');
        // Meta tags land inside <head>, not after </body>
        expect(out.indexOf('syncengine-workspace-id')).toBeLessThan(out.indexOf('</head>'));
    });

    it('includes gatewayUrl when provided, omits it when not', () => {
        const inject = createHtmlInjector(BASE_HTML).inject;

        const withGw = inject({
            workspaceId: 'w',
            natsUrl: 'ws://n',
            restateUrl: 'http://r',
            gatewayUrl: 'ws://g',
        });
        expect(withGw).toContain('syncengine-gateway-url');
        expect(withGw).toContain('content="ws://g"');

        const withoutGw = inject({
            workspaceId: 'w',
            natsUrl: 'ws://n',
            restateUrl: 'http://r',
        });
        expect(withoutGw).not.toContain('syncengine-gateway-url');
    });

    it('escapes double-quotes and HTML special chars in attribute values', () => {
        const inject = createHtmlInjector(BASE_HTML).inject;
        const out = inject({
            workspaceId: 'a"b<c>d&e',
            natsUrl: 'ws://n',
            restateUrl: 'http://r',
        });

        // Raw chars must not appear inside attribute content
        expect(out).not.toContain('content="a"b<c>d&e"');
        // Escaped form must appear
        expect(out).toContain('a&quot;b&lt;c&gt;d&amp;e');
    });

    it('preserves the body content verbatim', () => {
        const inject = createHtmlInjector(BASE_HTML).inject;
        const out = inject({
            workspaceId: 'w',
            natsUrl: 'ws://n',
            restateUrl: 'http://r',
        });

        expect(out).toContain('<div id="root"></div>');
        expect(out).toContain('<title>App</title>');
    });

    it('is safe to call many times without re-injecting or duplicating', () => {
        const inject = createHtmlInjector(BASE_HTML).inject;
        const out1 = inject({ workspaceId: 'a', natsUrl: 'ws://n', restateUrl: 'http://r' });
        const out2 = inject({ workspaceId: 'b', natsUrl: 'ws://n', restateUrl: 'http://r' });

        // Each call produces its own output — different workspaces
        expect(out1).toContain('content="a"');
        expect(out2).toContain('content="b"');

        // And no cumulative state between calls — out2 doesn't carry 'a'
        expect(out2).not.toContain('content="a"');

        // No duplicate meta tags within a single output
        const tagCount = (s: string, needle: string) =>
            s.split(needle).length - 1;
        expect(tagCount(out1, 'syncengine-workspace-id')).toBe(1);
    });

    it('does not re-inject when base html already has the meta marker (defensive)', () => {
        const alreadyInjected = BASE_HTML.replace(
            '</head>',
            '    <meta name="syncengine-workspace-id" content="old">\n  </head>',
        );
        const inject = createHtmlInjector(alreadyInjected).inject;
        const out = inject({ workspaceId: 'new', natsUrl: 'ws://n', restateUrl: 'http://r' });

        // Marker check kicks in; file returned unchanged
        expect(out).toBe(alreadyInjected);
        expect(out).toContain('content="old"');
        expect(out).not.toContain('content="new"');
    });

    it('falls back to injecting after <head> when </head> is missing', () => {
        const headlessHtml = `<!doctype html><html><head><body><div id="root"></div></body></html>`;
        const inject = createHtmlInjector(headlessHtml).inject;
        const out = inject({ workspaceId: 'w', natsUrl: 'ws://n', restateUrl: 'http://r' });

        expect(out).toContain('syncengine-workspace-id');
    });
});
