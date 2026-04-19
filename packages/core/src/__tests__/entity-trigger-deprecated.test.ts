import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-deprecated
import { trigger, __resetTriggerDeprecation } from '../entity';

describe('trigger() deprecation', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let warn: any;

    beforeEach(() => {
        __resetTriggerDeprecation();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
    });

    it('logs warn on first call', () => {
        trigger({ $tag: 'workflow', $name: 'x' }, { a: 1 });
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = warn.mock.calls[0]![0] as string;
        expect(msg).toMatch(/deprecated/i);
        expect(msg).toMatch(/publish/);
        expect(msg).toMatch(/trigger-to-publish\.md/);
    });

    it('does NOT log on subsequent calls in the same process', () => {
        trigger({ $tag: 'workflow', $name: 'x' }, { a: 1 });
        trigger({ $tag: 'workflow', $name: 'y' }, { b: 2 });
        trigger({ $tag: 'workflow', $name: 'z' }, { c: 3 });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('still returns the correct effect shape', () => {
        const wf = { $tag: 'workflow' as const, $name: 'myWorkflow' };
        const eff = trigger(wf, { foo: 42 });
        expect(eff).toEqual({ $effect: 'trigger', workflow: wf, input: { foo: 42 } });
    });

    it('__resetTriggerDeprecation allows subsequent tests to observe the first warn', () => {
        trigger({ $tag: 'workflow', $name: 'x' }, { a: 1 });
        expect(warn).toHaveBeenCalledTimes(1);
        __resetTriggerDeprecation();
        trigger({ $tag: 'workflow', $name: 'x' }, { a: 1 });
        expect(warn).toHaveBeenCalledTimes(2);
    });
});
