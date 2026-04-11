import * as restate from "@restatedev/restate-sdk";
import { getJetStream, getJetStreamManager } from "./nats-client.js";
import { RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { ENTITY_OBJECT_PREFIX } from "../entity-keys.js";
import { WORKFLOW_OBJECT_PREFIX } from "../workflow.js";
import { errors, StoreCode, ConnectionCode } from "@syncengine/core";

// ── Types ──────────────────────────────────────────────────────────────────

interface WorkspaceState {
  workspaceId: string;
  tenantId: string;
  schemaVersion: number;
  streamName: string;
  createdAt: string;
  status: "provisioning" | "active" | "teardown" | "deleted";
}

interface PeerAck {
  lastSeq: number;
  userId?: string;
  lastAck: number;
}

interface Member {
  userId: string;
  role: string;
  addedAt: string;
}

// ── State key constants ────────────────────────────────────────────────────
// Single source of truth for all Restate ctx.get/set keys.

const Keys = {
  STATE: "state",
  MEMBERS: "members",
  GC_PEERS: "gc_peers",
  GC_WATERMARK: "gc_watermark",
  SNAPSHOT_META: "snapshot_meta",
  SNAPSHOT_TABLES: "snapshot_tables",
  SNAPSHOT_HLC: "snapshot_hlc",
  SNAPSHOT_MERGE_CLOCKS: "snapshot_merge_clocks",
  authoritySeq: (viewName: string) => `authority_seq_${viewName}`,
} as const;

// ── Configuration ──────────────────────────────────────────────────────────

const NATS_URL = process.env.NATS_URL || "nats://nats:4222";
const PEER_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_AGE_SECS = 7 * 24 * 60 * 60;

// ── Stream naming convention ───────────────────────────────────────────────

export function streamName(workspaceId: string): string {
  return `WS_${workspaceId.replace(/-/g, "_")}`;
}

function subjectPrefix(workspaceId: string): string {
  return `ws.${workspaceId}`;
}

// ── Stream helpers ────────────────────────────────────────────────────────

function streamConfig(stream: string, subjects: string, maxAgeSecs = DEFAULT_MAX_AGE_SECS) {
  return {
    name: stream,
    subjects: [subjects],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: maxAgeSecs * 1_000_000_000,
    max_bytes: 100 * 1024 * 1024,
    max_msgs: 100_000,
    discard: "old" as any,
    num_replicas: 1,
  };
}

async function deleteStreamIfExists(name: string): Promise<void> {
  const jsm = await getJetStreamManager();
  try {
    await jsm.streams.delete(name);
  } catch (e: any) {
    if (!e.message?.includes("not found")) throw e;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function requireActive(ctx: restate.ObjectContext): Promise<WorkspaceState> {
  const state = await ctx.get<WorkspaceState>(Keys.STATE);
  if (!state || state.status !== "active") {
    // Wrap in TerminalError (Restate retries non-terminal errors) but carry
    // the structured category::code into the message so clients can parse it.
    throw new restate.TerminalError(`[store::${StoreCode.WORKSPACE_NOT_ACTIVE}] Workspace not active`);
  }
  return state;
}

async function getMembers(ctx: restate.ObjectContext): Promise<Member[]> {
  return (await ctx.get<Member[]>(Keys.MEMBERS)) ?? [];
}

/** Publish a message to NATS inside a Restate side-effect. */
async function publishToNats(
  ctx: restate.ObjectContext,
  effectName: string,
  subject: string,
  message: unknown,
) {
  await ctx.run(effectName, async () => {
    const { connect } = await import("@nats-io/transport-node");
    const nc = await connect({ servers: NATS_URL });
    nc.publish(subject, JSON.stringify(message));
    await nc.flush();
    await nc.close();
  });
}

// ── Restate Virtual Object: Workspace ──────────────────────────────────────

export const workspace = restate.object({
  name: "workspace",
  handlers: {

    // ── Provisioning ──────────────────────────────────────────────────────

    async provision(
      ctx: restate.ObjectContext,
      req: { tenantId: string; maxAge?: number; creatorUserId?: string }
    ): Promise<WorkspaceState> {
      const workspaceId = ctx.key;

      const existing = await ctx.get<WorkspaceState>(Keys.STATE);
      if (existing && existing.status === "active") {
        ctx.console.log(`Workspace ${workspaceId} already active`);
        return existing;
      }

      const stream = streamName(workspaceId);
      const subjects = `${subjectPrefix(workspaceId)}.>`;

      const state: WorkspaceState = {
        workspaceId,
        tenantId: req.tenantId,
        schemaVersion: 1,
        streamName: stream,
        createdAt: new Date().toISOString(),
        status: "provisioning",
      };
      ctx.set(Keys.STATE, state);

      await ctx.run("create-stream", async () => {
        const jsm = await getJetStreamManager();
        await jsm.streams.add(streamConfig(stream, subjects, req.maxAge));
        console.log(`[nats] created stream ${stream} for subjects ${subjects}`);
      });

      state.status = "active";
      ctx.set(Keys.STATE, state);

      if (req.creatorUserId) {
        ctx.set(Keys.MEMBERS, [{ userId: req.creatorUserId, role: 'owner', addedAt: new Date().toISOString() }]);
      }

      await publishToNats(ctx, "broadcast-workspace-provisioned", "syncengine.workspaces", {
        type: "WORKSPACE_PROVISIONED",
        workspaceId,
        tenantId: req.tenantId,
        createdAt: state.createdAt,
      });

      ctx.console.log(`Workspace ${workspaceId} provisioned`);
      return state;
    },

    // ── State queries ─────────────────────────────────────────────────────

    async getState(ctx: restate.ObjectContext): Promise<WorkspaceState | null> {
      return await ctx.get<WorkspaceState>(Keys.STATE);
    },

    async bumpSchema(
      ctx: restate.ObjectContext,
      req: { version: number }
    ): Promise<WorkspaceState> {
      const state = await requireActive(ctx);
      state.schemaVersion = req.version;
      ctx.set(Keys.STATE, state);
      ctx.console.log(`Workspace ${ctx.key} schema → v${req.version}`);
      return state;
    },

    // ── Authority (CALM non-monotonic views) ──────────────────────────────

    async authority(
      ctx: restate.ObjectContext,
      req: { viewName: string; deltas: Array<{ record: Record<string, unknown>; weight: number; hlc?: { ts: number; count: number } }> }
    ): Promise<{ seq: number; viewName: string }> {
      await requireActive(ctx);

      const seqKey = Keys.authoritySeq(req.viewName);
      const currentSeq = (await ctx.get<number>(seqKey)) ?? 0;
      const nextSeq = currentSeq + 1;
      ctx.set(seqKey, nextSeq);

      const sortedDeltas = [...req.deltas].sort((a, b) => {
        if (!a.hlc || !b.hlc) return 0;
        if (a.hlc.ts !== b.hlc.ts) return a.hlc.ts - b.hlc.ts;
        return a.hlc.count - b.hlc.count;
      });

      const subject = `ws.${ctx.key}.authority.${req.viewName}`;
      await publishToNats(ctx, "publish-authority", subject, {
        type: "AUTHORITY_UPDATE",
        viewName: req.viewName,
        seq: nextSeq,
        deltas: sortedDeltas,
        timestamp: Date.now(),
      });

      ctx.console.log(`Authority seq ${nextSeq} for ${req.viewName} in ${ctx.key}`);
      return { seq: nextSeq, viewName: req.viewName };
    },

    async getAuthoritySeq(
      ctx: restate.ObjectContext,
      req: { viewName: string }
    ): Promise<{ seq: number }> {
      const seq = (await ctx.get<number>(Keys.authoritySeq(req.viewName))) ?? 0;
      return { seq };
    },

    // ── Snapshots ─────────────────────────────────────────────────────────

    async publishSnapshot(
      ctx: restate.ObjectContext,
      req: {
        seq: number;
        schemaVersion: number;
        tables: Record<string, Record<string, unknown>[]>;
        hlcState?: { ts: number; count: number };
        mergeClocks?: Record<string, Record<string, Record<string, { ts: number; count: number }>>>;
      }
    ): Promise<{ stored: boolean; seq: number }> {
      await requireActive(ctx);

      const existing = await ctx.get<{ seq: number }>(Keys.SNAPSHOT_META);
      if (existing && existing.seq >= req.seq) {
        ctx.console.log(`Snapshot at seq ${req.seq} is stale (current: ${existing.seq}), skipping`);
        return { stored: false, seq: existing.seq };
      }

      ctx.set(Keys.SNAPSHOT_META, { seq: req.seq, schemaVersion: req.schemaVersion, storedAt: Date.now() });
      ctx.set(Keys.SNAPSHOT_TABLES, req.tables);
      if (req.hlcState) ctx.set(Keys.SNAPSHOT_HLC, req.hlcState);
      if (req.mergeClocks) ctx.set(Keys.SNAPSHOT_MERGE_CLOCKS, req.mergeClocks);

      ctx.console.log(`Stored snapshot at seq ${req.seq} for workspace ${ctx.key}`);
      return { stored: true, seq: req.seq };
    },

    async getSnapshot(
      ctx: restate.ObjectContext,
      _req: Record<string, never>
    ): Promise<{
      seq: number;
      schemaVersion: number;
      tables: Record<string, Record<string, unknown>[]>;
      hlcState?: { ts: number; count: number };
      mergeClocks?: Record<string, Record<string, Record<string, { ts: number; count: number }>>>;
    } | null> {
      const meta = await ctx.get<{ seq: number; schemaVersion: number }>(Keys.SNAPSHOT_META);
      if (!meta) return null;

      const tables = await ctx.get<Record<string, Record<string, unknown>[]>>(Keys.SNAPSHOT_TABLES);
      if (!tables) return null;

      const hlcState = await ctx.get<{ ts: number; count: number }>(Keys.SNAPSHOT_HLC);
      const mergeClocks = await ctx.get<Record<string, Record<string, Record<string, { ts: number; count: number }>>>>(Keys.SNAPSHOT_MERGE_CLOCKS);

      return {
        seq: meta.seq,
        schemaVersion: meta.schemaVersion,
        tables,
        hlcState: hlcState ?? undefined,
        mergeClocks: mergeClocks ?? undefined,
      };
    },

    // ── Membership ────────────────────────────────────────────────────────

    async addMember(
      ctx: restate.ObjectContext,
      req: { userId: string; role: 'owner' | 'editor' | 'viewer' }
    ): Promise<{ added: boolean; workspaceId: string; userId: string; role: string }> {
      await requireActive(ctx);

      const members = await getMembers(ctx);
      const filtered = members.filter(m => m.userId !== req.userId);
      filtered.push({ userId: req.userId, role: req.role, addedAt: new Date().toISOString() });
      ctx.set(Keys.MEMBERS, filtered);

      ctx.console.log(`Added ${req.userId} as ${req.role} to workspace ${ctx.key}`);
      return { added: true, workspaceId: ctx.key, userId: req.userId, role: req.role };
    },

    async removeMember(
      ctx: restate.ObjectContext,
      req: { userId: string }
    ): Promise<{ removed: boolean; workspaceId: string; userId: string }> {
      const members = await getMembers(ctx);
      const filtered = members.filter(m => m.userId !== req.userId);
      const removed = filtered.length < members.length;
      ctx.set(Keys.MEMBERS, filtered);

      if (removed) ctx.console.log(`Removed ${req.userId} from workspace ${ctx.key}`);
      return { removed, workspaceId: ctx.key, userId: req.userId };
    },

    async listMembers(
      ctx: restate.ObjectContext,
      _req: Record<string, never>
    ): Promise<{ members: Member[] }> {
      return { members: await getMembers(ctx) };
    },

    async isMember(
      ctx: restate.ObjectContext,
      req: { userId: string }
    ): Promise<{ isMember: boolean; role?: string }> {
      const members = await getMembers(ctx);
      const member = members.find(m => m.userId === req.userId);
      return member ? { isMember: true, role: member.role } : { isMember: false };
    },

    // ── Garbage collection ────────────────────────────────────────────────

    async reportPeerSeq(
      ctx: restate.ObjectContext,
      req: { clientId: string; userId?: string; lastSeq: number }
    ): Promise<{ updated: boolean; gcWatermark: number }> {
      await requireActive(ctx);

      const peers = (await ctx.get<Record<string, PeerAck>>(Keys.GC_PEERS)) ?? {};
      peers[req.clientId] = { lastSeq: req.lastSeq, userId: req.userId, lastAck: Date.now() };
      ctx.set(Keys.GC_PEERS, peers);

      const now = Date.now();
      const activeSeqs = Object.values(peers)
        .filter(p => (now - p.lastAck) < PEER_STALE_MS)
        .map(p => p.lastSeq);
      const gcWatermark = activeSeqs.length > 0 ? Math.min(...activeSeqs) : 0;

      ctx.set(Keys.GC_WATERMARK, gcWatermark);
      return { updated: true, gcWatermark };
    },

    async triggerGC(
      ctx: restate.ObjectContext,
      _req: Record<string, never>
    ): Promise<{ purgedCount: number; newFirstSeq: number; gcWatermark: number; snapshotStored: boolean }> {
      const state = await requireActive(ctx);

      const gcWatermarkData = (await ctx.get<number>(Keys.GC_WATERMARK)) ?? 0;
      if (gcWatermarkData <= 0) {
        return { purgedCount: 0, newFirstSeq: 0, gcWatermark: 0, snapshotStored: false };
      }

      const purgeResult = await ctx.run("purge-stream", async () => {
        const jsm = await getJetStreamManager();
        try {
          await jsm.streams.purge(state.streamName, { seq: gcWatermarkData });
          const info = await jsm.streams.info(state.streamName);
          return { purged: true, firstSeq: Number(info.state.first_seq) };
        } catch (e: any) {
          console.warn(`[gc] purge failed: ${e.message}`);
          return { purged: false, firstSeq: 0 };
        }
      });

      const subject = `ws.${ctx.key}.gc`;
      await publishToNats(ctx, "notify-gc", subject, {
        type: "GC_COMPLETE",
        gcWatermark: gcWatermarkData,
        purgedCount: purgeResult.purged ? gcWatermarkData : 0,
        snapshotSeq: gcWatermarkData,
        timestamp: Date.now(),
      });

      ctx.console.log(`GC complete for ${ctx.key}: watermark=${gcWatermarkData}`);
      return {
        purgedCount: purgeResult.purged ? gcWatermarkData : 0,
        newFirstSeq: purgeResult.firstSeq,
        gcWatermark: gcWatermarkData,
        snapshotStored: false,
      };
    },

    // ── Teardown ──────────────────────────────────────────────────────────

    async teardown(ctx: restate.ObjectContext): Promise<{ deleted: boolean }> {
      const state = await ctx.get<WorkspaceState>(Keys.STATE);
      if (!state) return { deleted: false };

      state.status = "teardown";
      ctx.set(Keys.STATE, state);

      await ctx.run("delete-stream", () => deleteStreamIfExists(state.streamName));

      state.status = "deleted";
      ctx.set(Keys.STATE, state);

      await publishToNats(ctx, "broadcast-workspace-deleted", "syncengine.workspaces", {
        type: "WORKSPACE_DELETED",
        workspaceId: ctx.key,
      });

      ctx.console.log(`Workspace ${ctx.key} deleted`);
      return { deleted: true };
    },

    // ── Dev reset (single call replaces 4 sequential devtools steps) ─────

    async reset(
      ctx: restate.ObjectContext,
      req: { tenantId?: string },
    ): Promise<{ ok: boolean; message: string }> {
      if (process.env.NODE_ENV === "production") {
        throw new restate.TerminalError(
          `[store::${StoreCode.RESET_DISABLED}] reset is disabled in production. ` +
          `Set SYNCENGINE_ALLOW_RESET=1 to enable reset in production.`,
        );
      }

      const workspaceId = ctx.key;
      const adminUrl = process.env.RESTATE_ADMIN_URL ?? "http://127.0.0.1:9070";

      await ctx.run("reset-delete-stream", () => deleteStreamIfExists(streamName(workspaceId)));

      // Bulk-clear entity + workflow state: one SQL query for all keys,
      // then parallel state clears. Errors propagate so Restate retries.
      await ctx.run("reset-clear-entity-state", async () => {
        const qRes = await fetch(`${adminUrl}/query`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            query: `SELECT service_name, service_key FROM state WHERE service_name LIKE '${ENTITY_OBJECT_PREFIX}%' OR service_name LIKE '${WORKFLOW_OBJECT_PREFIX}%'`,
          }),
        });
        if (!qRes.ok) {
          throw errors.connection(ConnectionCode.HTTP_ERROR, {
            message: `Restate admin query failed: HTTP ${qRes.status}`,
            context: { status: qRes.status },
          });
        }

        const qData = (await qRes.json()) as {
          rows?: Array<{ service_name: string; service_key: string }>;
        };
        const rows = qData.rows ?? [];
        if (rows.length === 0) return;

        await Promise.all(
          rows.map((r) =>
            fetch(`${adminUrl}/services/${r.service_name}/state`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ object_key: r.service_key, new_state: {} }),
            }),
          ),
        );
        console.log(`[reset] cleared ${rows.length} entity/workflow state entries`);
      });

      ctx.clearAll();

      const stream = streamName(workspaceId);
      const subjects = `${subjectPrefix(workspaceId)}.>`;
      await ctx.run("reset-create-stream", async () => {
        const jsm = await getJetStreamManager();
        await jsm.streams.add(streamConfig(stream, subjects));
      });

      const state: WorkspaceState = {
        workspaceId,
        tenantId: req.tenantId ?? "default",
        schemaVersion: 1,
        streamName: stream,
        createdAt: new Date().toISOString(),
        status: "active",
      };
      ctx.set(Keys.STATE, state);

      // Publish a sys.reset message so every connected client clears
      // its local SQLite/OPFS and reloads. This lands on the freshly
      // created stream, so clients that reconnect after the reset will
      // also see it during replay.
      await ctx.run("reset-notify-clients", async () => {
        const js = await getJetStream();
        const subject = `${subjectPrefix(workspaceId)}.sys.reset`;
        await js.publish(subject, JSON.stringify({ type: "RESET", ts: Date.now() }));
      });

      ctx.console.log(`Workspace ${workspaceId} reset complete`);
      return { ok: true, message: `reset workspace ${workspaceId}` };
    },
  },
});
