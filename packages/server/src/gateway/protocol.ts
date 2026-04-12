/**
 * WebSocket gateway protocol types
 *
 * The gateway speaks JSON over a plain WebSocket, filtering and forwarding
 * messages between browser clients and a NATS server based on client interest.
 */

// ============================================================================
// CLIENT -> GATEWAY MESSAGES
// ============================================================================

/**
 * Lifecycle: Initialize the connection
 */
export interface ClientInitMessage {
  type: 'init';
  workspaceId: string;
  channels: string[];
  clientId: string;
  authToken?: string;
}

/**
 * Interest registration: Subscribe to a channel
 */
export interface ClientSubscribeChannelMessage {
  type: 'subscribe';
  kind: 'channel';
  name: string;
  lastSeq?: number;
}

/**
 * Interest registration: Subscribe to an entity
 */
export interface ClientSubscribeEntityMessage {
  type: 'subscribe';
  kind: 'entity';
  entity: string;
  key: string;
}

/**
 * Interest registration: Subscribe to a topic
 */
export interface ClientSubscribeTopicMessage {
  type: 'subscribe';
  kind: 'topic';
  name: string;
  key: string;
}

/**
 * Interest registration: Unsubscribe from a channel
 */
export interface ClientUnsubscribeChannelMessage {
  type: 'unsubscribe';
  kind: 'channel';
  name: string;
}

/**
 * Interest registration: Unsubscribe from an entity
 */
export interface ClientUnsubscribeEntityMessage {
  type: 'unsubscribe';
  kind: 'entity';
  entity: string;
  key: string;
}

/**
 * Interest registration: Unsubscribe from a topic
 */
export interface ClientUnsubscribeTopicMessage {
  type: 'unsubscribe';
  kind: 'topic';
  name: string;
  key: string;
}

/**
 * Publishing: Publish a delta to NATS
 */
export interface ClientPublishDeltaMessage {
  type: 'publish';
  kind: 'delta';
  channel: string;             // channel name (not NATS subject)
  payload: Record<string, unknown>;
}

/**
 * Publishing: Publish a topic message to NATS
 */
export interface ClientPublishTopicMessage {
  type: 'publish';
  kind: 'topic';
  name: string;                // topic name
  key: string;                 // topic key
  payload: Record<string, unknown>;
}

/**
 * Publishing: Publish authority view deltas to NATS
 */
export interface ClientPublishAuthorityMessage {
  type: 'publish';
  kind: 'authority';
  viewName: string;
  deltas: Record<string, unknown>[];
}

/**
 * Union of all client->gateway message types
 */
export type ClientMsg =
  | ClientInitMessage
  | ClientSubscribeChannelMessage
  | ClientSubscribeEntityMessage
  | ClientSubscribeTopicMessage
  | ClientUnsubscribeChannelMessage
  | ClientUnsubscribeEntityMessage
  | ClientUnsubscribeTopicMessage
  | ClientPublishDeltaMessage
  | ClientPublishTopicMessage
  | ClientPublishAuthorityMessage;

// ============================================================================
// GATEWAY -> CLIENT MESSAGES
// ============================================================================

/**
 * Lifecycle: Connection ready for communication
 */
export interface ServerReadyMessage {
  type: 'ready';
}

/**
 * Lifecycle: Error occurred
 */
export interface ServerErrorMessage {
  type: 'error';
  message: string;
  code?: string;
}

/**
 * Forwarded: Delta message from a channel
 */
export interface ServerDeltaMessage {
  type: 'delta';
  channel: string;
  seq: number;
  payload: Record<string, unknown>;
}

/**
 * Forwarded: Entity write notification
 */
export interface ServerEntityWriteMessage {
  type: 'entity-write';
  payload: Record<string, unknown>;
  seq: number;
}

/**
 * Forwarded: Entity state snapshot
 */
export interface ServerEntityStateMessage {
  type: 'entity-state';
  entity: string;
  key: string;
  payload: Record<string, unknown>;
}

/**
 * Forwarded: Authority view deltas
 */
export interface ServerAuthorityMessage {
  type: 'authority';
  viewName: string;
  payload: Record<string, unknown>;
}

/**
 * Forwarded: Topic message
 */
export interface ServerTopicMessage {
  type: 'topic';
  name: string;
  key: string;
  payload: Record<string, unknown>;
}

/**
 * Forwarded: Garbage collection marker
 */
export interface ServerGcMessage {
  type: 'gc';
  payload: Record<string, unknown>;
}

/**
 * Replay boundary: Marks end of replay for a channel
 */
export interface ServerReplayEndMessage {
  type: 'replay-end';
  channel: string;
}

export interface ServerWorkspaceRegistryMessage {
  type: 'workspace-registry';
  [key: string]: unknown;
}

/**
 * Union of all gateway->client message types
 */
export type ServerMsg =
  | ServerReadyMessage
  | ServerErrorMessage
  | ServerDeltaMessage
  | ServerEntityWriteMessage
  | ServerEntityStateMessage
  | ServerAuthorityMessage
  | ServerTopicMessage
  | ServerGcMessage
  | ServerReplayEndMessage
  | ServerWorkspaceRegistryMessage;
