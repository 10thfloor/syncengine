// Declared metric factory.
//
// `metric.counter / histogram / gauge` are the user-facing primitives
// for metrics that don't belong to the framework's own seams. Every
// handle acquires its OTel instrument lazily on each call so the
// factory survives SDK boot → shutdown → boot cycles cleanly, and so
// `metric.counter(...)` is safe to call at module-load time before
// `bootSdk` runs (the handle is inert until the global meter provider
// becomes real).
//
// Auto-tagging: `currentScope()` pulls workspace / user / primitive /
// name out of the ALS frame the seam helpers install. User-supplied
// attrs merge UNDER the auto-tags so a handler can't accidentally
// relabel the primitive or spoof the workspace. Outside a seam's
// scope, only user-supplied attrs are attached — clean standalone
// metrics.

import { metrics, type Attributes } from '@opentelemetry/api';

import { currentScope } from './scope';
import {
    ATTR_NAME,
    ATTR_PRIMITIVE,
    ATTR_USER,
    ATTR_WORKSPACE,
} from './semantic';
import type {
    Attrs,
    CounterHandle,
    GaugeHandle,
    HistogramHandle,
    MetricFactory,
    MetricOptions,
} from './types';

const METER_NAME = '@syncengine/observe';

/** Merge the current observe-scope auto-tags on top of caller attrs.
 *  Auto-tags win — framework's source of truth for workspace/user. */
function mergeWithScope(userAttrs: Attrs | undefined): Attributes {
    const merged: Attributes = userAttrs ? { ...userAttrs } as Attributes : {};
    const scope = currentScope();
    if (!scope) return merged;
    if (scope.workspace !== undefined) merged[ATTR_WORKSPACE] = scope.workspace;
    if (scope.user !== undefined) merged[ATTR_USER] = scope.user;
    if (scope.primitive !== undefined) merged[ATTR_PRIMITIVE] = scope.primitive;
    if (scope.name !== undefined) merged[ATTR_NAME] = scope.name;
    return merged;
}

function meter() {
    return metrics.getMeter(METER_NAME);
}

export const metric: MetricFactory = {
    counter(name: string, opts?: MetricOptions): CounterHandle {
        return {
            add(value = 1, attrs) {
                meter().createCounter(name, opts).add(value, mergeWithScope(attrs));
            },
        };
    },

    histogram(name: string, opts?: MetricOptions): HistogramHandle {
        return {
            observe(value, attrs) {
                meter().createHistogram(name, opts).record(value, mergeWithScope(attrs));
            },
        };
    },

    gauge(name: string, opts?: MetricOptions): GaugeHandle {
        return {
            record(value, attrs) {
                meter().createGauge(name, opts).record(value, mergeWithScope(attrs));
            },
        };
    },
};
