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
    BusPublishAttrs,
    BusConsumeAttrs,
    WebhookInboundAttrs,
    WebhookRunAttrs,
    HeartbeatTickAttrs,
    GatewayMessageAttrs,
    RemoteHeaders,
    TraceCarrier,
} from './internal';

export { makeObservabilityCtx, type ObservabilityCtxScope } from './ctx';

// Declared metric factory — OTel-backed via the global meter provider.
// Safe to call before bootSdk: the API-level noop meter absorbs
// increments until the SDK is installed, at which point instruments
// are acquired lazily on the next call. See packages/observe/src/metric.ts.
export { metric } from './metric';
