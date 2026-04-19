import type { AnyService, AnyServiceOverride, ServiceDef, ServicePort } from '@syncengine/core';

export class ServiceContainer {
    private readonly services = new Map<string, AnyService>();
    private readonly overrides = new Map<string, AnyServiceOverride>();

    constructor(
        services: readonly AnyService[],
        overrides: readonly AnyServiceOverride[] = [],
    ) {
        for (const svc of services) {
            this.services.set(svc.$name, svc);
        }
        for (const ovr of overrides) {
            this.overrides.set(ovr.$targetName, ovr);
        }
    }

    resolve<TName extends string, TMethods extends Record<string, (...args: any[]) => Promise<any>>>(
        def: ServiceDef<TName, TMethods>,
    ): ServicePort<ServiceDef<TName, TMethods>> {
        const svc = this.services.get(def.$name);
        if (!svc) {
            throw new Error(
                `Service '${def.$name}' not registered. Available: ${[...this.services.keys()].join(', ') || '(none)'}`,
            );
        }

        const ovr = this.overrides.get(def.$name);
        if (!ovr) {
            return { ...svc.$methods } as ServicePort<ServiceDef<TName, TMethods>>;
        }

        if (ovr.$partial) {
            return { ...svc.$methods, ...ovr.$methods } as ServicePort<ServiceDef<TName, TMethods>>;
        }

        return { ...ovr.$methods } as ServicePort<ServiceDef<TName, TMethods>>;
    }

    resolveAll(defs: readonly AnyService[]): Record<string, Record<string, (...args: any[]) => Promise<any>>> {
        const out: Record<string, Record<string, (...args: any[]) => Promise<any>>> = {};
        for (const def of defs) {
            out[def.$name] = this.resolve(def);
        }
        return out;
    }
}
