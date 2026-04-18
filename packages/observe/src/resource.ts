// Build the OTel Resource — the set of attributes that describes the
// process/service behind every exported span and metric.
//
// Strategy:
//   1. Start from `@opentelemetry/resources`'s default detectors (env vars,
//      process info) so OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME are
//      honored with no explicit code.
//   2. Layer the user's `serviceName` on top so an explicit config wins
//      over whatever the detectors picked up.
//   3. Layer the user's `resource` bag last so explicit keys in config
//      override any auto-detected value.

import {
    defaultResource,
    resourceFromAttributes,
    type Resource,
} from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import type { ObservabilityConfig } from './types';

export function buildResource(config: ObservabilityConfig | undefined): Resource {
    let resource = defaultResource();

    if (config?.serviceName !== undefined) {
        resource = resource.merge(
            resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
        );
    }

    if (config?.resource !== undefined) {
        resource = resource.merge(resourceFromAttributes({ ...config.resource }));
    }

    return resource;
}
