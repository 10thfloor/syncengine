# Migrating `trigger()` → `publish()` + bus subscriber

**Status:** `trigger()` is deprecated. It still works, but emits a one-time runtime warning and will be removed in a future release. Replace every call at your earliest convenience.

## Why

`trigger()` was a 1:1 direct coupling from an entity handler to a single named workflow. It's cheap and explicit, but it locks the emitter to exactly one consumer. The hex framework's new `bus()` primitive lets you emit a typed domain event and have any number of subscribers (or none) react — the emitter doesn't know the consumer list.

That unlocks fan-out, DLQ, replay, compensating sagas, and pluggable observability. `publish()` + a `defineWorkflow({ on: on(bus) })` subscriber is the replacement.

## Before (deprecated)

```ts
// src/entities/order.actor.ts
import { defineEntity, emit, trigger } from '@syncengine/core';
import { processPayment } from '../workflows/process-payment.workflow';

export const order = defineEntity('order', {
    state: { status: text(), total: integer() },
    handlers: {
        place(state) {
            return emit({
                state: { ...state, status: 'pending_payment' },
                effects: [
                    trigger(processPayment, { orderKey: state.id, total: state.total }),
                ],
            });
        },
    },
});
```

## After

### 1. Declare a bus for the domain event

```ts
// src/events/orders.bus.ts
import { bus } from '@syncengine/core';
import { z } from 'zod';

export const OrderEvent = z.enum(['placed', 'paid', 'shipped', 'cancelled']);

export const orderEvents = bus('orderEvents', {
    schema: z.object({
        orderId: z.string(),
        event: OrderEvent,
        total: z.number(),
        at: z.number(),
    }),
});
```

### 2. Replace `trigger()` with `publish()` in the entity

```ts
// src/entities/order.actor.ts
import { defineEntity, emit, publish } from '@syncengine/core';
import { orderEvents, OrderEvent } from '../events/orders.bus';

export const order = defineEntity('order', {
    state: { status: text(), total: integer() },
    handlers: {
        place(state) {
            return emit({
                state: { ...state, status: 'pending_payment' },
                effects: [
                    publish(orderEvents, {
                        orderId: state.id,
                        event: OrderEvent.enum.placed,
                        total: state.total,
                        at: Date.now(),
                    }),
                ],
            });
        },
    },
});
```

### 3. Convert the workflow to a bus subscriber

```ts
// src/workflows/process-payment.workflow.ts
import { defineWorkflow, on } from '@syncengine/server';
import { orderEvents, OrderEvent } from '../events/orders.bus';
import { payments } from '../services/payments';

export const processPayment = defineWorkflow(
    'processPayment',
    {
        on: on(orderEvents).where((e) => e.event === OrderEvent.enum.placed),
        services: [payments],
    },
    async (ctx, event) => {
        await ctx.services.payments.charge(event.total, 'usd');
    },
);
```

## What you gain

- **Fan-out for free.** Add a second subscriber (analytics, audit log, notifications) without touching the entity.
- **Auto-DLQ.** Failures that exhaust retries land on `orderEvents.dlq` — subscribe to it to get observability or automated remediation.
- **Replay.** `on(orderEvents).from(From.beginning())` lets a new subscriber bootstrap a projection from the full event history.
- **Compensating sagas.** On failure, `throw new TerminalError(...)` to short-circuit retries and land on the DLQ.

## Timeline

- **Current release:** `trigger()` works, logs a one-time warning, docs point here.
- **Next release:** `trigger()` is removed. `grep -r 'trigger(' src/` before upgrading.

## Common mistakes

- **Entity name collision with bus name.** Bus names follow `/^[a-z][a-z0-9_-]*$/i` and may not contain dots. Pick distinct names.
- **Forgetting to subscribe.** An orphan bus (declared but no `defineWorkflow({ on })`) now prints a warning at boot; migrate fully or delete the bus.
- **Schema drift.** Old `trigger()` inputs passed anything. `publish()` validates against the zod schema — tighten payloads as you go.
