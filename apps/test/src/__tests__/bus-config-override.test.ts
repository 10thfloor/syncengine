// Proof that `services.overrides` → `override(bus, { mode: inMemory })`
// reaches `bootBusRuntime`. Runs the loader directly (no docker) and
// checks the resolved mode for the production bus.

import { describe, it, expect } from 'vitest';
import appConfig from '../../syncengine.config';
import { loadConfigOverrides, busOverridesToModeOf } from '@syncengine/server';
import { orderEvents } from '../events/orders.bus';

describe('apps/test config overrides — orderEvents flips to inMemory under NODE_ENV=test', () => {
    it('loadConfigOverrides picks up the bus override when NODE_ENV=test', async () => {
        // Guard the test behind the env the config itself checks. Running
        // this under NODE_ENV !== 'test' is fine — overrides is undefined
        // and the loader returns empty; vitest sets NODE_ENV=test by
        // default, so the normal case exercises the happy path.
        const { serviceOverrides, busOverrides } = await loadConfigOverrides(appConfig);
        expect(serviceOverrides).toHaveLength(0);

        if (process.env.NODE_ENV === 'test') {
            expect(busOverrides).toHaveLength(1);
            expect(busOverrides[0]!.$targetName).toBe('orderEvents');
            expect(busOverrides[0]!.mode?.kind).toBe('inMemory');
        } else {
            expect(busOverrides).toHaveLength(0);
        }
    });

    it('busOverridesToModeOf flips orderEvents to inMemory', async () => {
        const { busOverrides } = await loadConfigOverrides(appConfig);
        const modeOf = busOverridesToModeOf(busOverrides);

        if (process.env.NODE_ENV === 'test') {
            expect(modeOf('orderEvents')).toBe('inMemory');
            expect(modeOf('otherBus')).toBeNull(); // fall through to declared mode
        } else {
            expect(modeOf('orderEvents')).toBeNull();
        }

        // The production declaration itself stays NATS — only overrides flip.
        expect(orderEvents.$mode.kind).toBe('nats');
    });
});
