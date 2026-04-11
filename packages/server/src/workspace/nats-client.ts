import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";

let nc: NatsConnection | null = null;
let jsm: JetStreamManager | null = null;
let js: JetStreamClient | null = null;

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

export async function getNatsConnection(): Promise<NatsConnection> {
  if (nc && !nc.isClosed()) return nc;
  nc = await connect({ servers: NATS_URL });
  console.log(`[nats] connected to ${NATS_URL}`);
  return nc;
}

export async function getJetStreamManager(): Promise<JetStreamManager> {
  if (jsm) return jsm;
  const conn = await getNatsConnection();
  jsm = await jetstreamManager(conn);
  return jsm;
}

export async function getJetStream(): Promise<JetStreamClient> {
  if (js) return js;
  const conn = await getNatsConnection();
  js = jetstream(conn);
  return js;
}
