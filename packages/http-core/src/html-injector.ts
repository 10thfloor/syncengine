import { injectMetaTags } from '@syncengine/core/http';

export interface HtmlInjectorMeta {
    workspaceId: string;
    natsUrl: string;
    restateUrl: string;
    gatewayUrl?: string;
}

/**
 * Builds a reusable injector that splices syncengine meta tags into a
 * pre-read HTML document. The input HTML is captured once at construction
 * so every subsequent `inject()` call is a pure transform.
 *
 * The underlying `injectMetaTags` in `@syncengine/core/http` handles the
 * idempotency check (re-injecting HTML that already carries our marker
 * returns the input unchanged) and the fallback when `</head>` is absent.
 * This wrapper exists to give consumers a single cached-HTML closure and
 * a typed entrypoint that reads nicely at call sites.
 */
export function createHtmlInjector(html: string): {
    inject(meta: HtmlInjectorMeta): string;
} {
    // Capture once. Every inject() call starts from this base so there's
    // no accumulating state across requests.
    const base = html;

    return {
        inject(meta) {
            return injectMetaTags(base, meta);
        },
    };
}
