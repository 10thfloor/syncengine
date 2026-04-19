import { defineEntity, integer, emit, insert } from '@syncengine/core';
import { notes } from '../schema';

/**
 * Inbox entity — the server-side ingest point used by the webhook.
 *
 * Webhook handlers run as Restate workflows, which can't write directly
 * to the table pipeline. They `entityRef` an entity like this one;
 * the entity's handler serializes the insert and `emit()`s a row into
 * the `notes` table so every client materializes it through the same
 * CRDT path as a typed note.
 *
 * Why bother with an entity at all? Because the entity runtime owns
 * the bridge from Restate to the sync stream (NATS subject publishing
 * with deterministic nonces). Routing webhook payloads through a
 * named entity keeps the `emit` contract obvious and testable.
 */
export const inbox = defineEntity('inbox', {
  state: {
    received: integer(),
  },
  handlers: {
    /** Called by the webhook workflow with a body pre-formatted string. */
    receive(state, body: string, author: string, createdAt: number) {
      return emit({
        state: { received: state.received + 1 },
        effects: [
          insert(notes, { body, author, createdAt }),
        ],
      });
    },
  },
});
