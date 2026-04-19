// Public surface for `@syncengine/observe`.
//
// Phase A (scaffolding) — this file only re-exports the semantic
// constants, types, and a `metric` factory that points at the noop
// implementation. Later phases swap `metric` over to a real OTel-backed
// factory once `bootSdk` (A2) has run; call sites don't need to change.

export {
    ATTR_WORKSPACE,
    ATTR_USER,
    ATTR_PRIMITIVE,
    ATTR_NAME,
    ATTR_OP,
    ATTR_TOPIC,
    ATTR_INVOCATION,
    ATTR_DEDUP_HIT,
} from './semantic';
export type { Primitive, SyncengineAttrKey } from './semantic';

export type {
    Attrs,
    AttrValue,
    CounterHandle,
    HistogramHandle,
    GaugeHandle,
    MetricFactory,
    MetricOptions,
    ObservabilityCtx,
    ObservabilityConfig,
} from './types';

export { bootSdk, type SdkHandle, type BootSdkOptions } from './sdk';

export { instrument } from './internal';
export type {
    EntityEffectAttrs,
    RequestAttrs,
    RpcAttrs,
    RpcKind,
} from './internal';

export { makeObservabilityCtx, type ObservabilityCtxScope } from './ctx';

import { noopMetric } from './noop';
import type { MetricFactory } from './types';

/**
 * Declared metric factory. Phase A binds this to the noop factory so
 * call sites compile and run; Phase D1 swaps in the OTel-backed
 * implementation that routes through the global meter provider.
 */
export const metric: MetricFactory = noopMetric;
