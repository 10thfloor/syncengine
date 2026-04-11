import { memo, useState } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { allOrders } from '../schema';
import { order, NEXT_ACTION, STATUS_COLORS } from '../entities/order.actor';
import { cancelOrder } from '../workflows/cancel-order.workflow';

export const OrdersTab = memo(function OrdersTab({ userId }: { userId: string }) {
  const s = useStore<DB>();
  const { views } = s.useView({ allOrders });

  const orders = views.allOrders;

  // Group by productSlug to show quantity badges
  const slugCounts = new Map<string, number>();
  for (const o of orders) {
    const slug = String(o.productSlug);
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }

  return (
    <div>
      <div className="section-heading">
        Orders
        <span className="pattern-badge state-machine">state-machine</span>
      </div>
      {orders.length === 0 ? (
        <div className="card" style={{ color: '#71717a', textAlign: 'center', padding: '2rem' }}>
          No orders yet. Use the Checkout tab to place one.
        </div>
      ) : (
        <div className="order-list">
          {orders.map((o) => (
            <OrderRow
              key={String(o.orderId)}
              orderId={String(o.orderId)}
              productSlug={String(o.productSlug)}
              orderPrice={Number(o.price)}
              orderUserId={String(o.userId)}
              currentUserId={userId}
              quantity={slugCounts.get(String(o.productSlug)) ?? 1}
            />
          ))}
        </div>
      )}
    </div>
  );
});

const OrderRow = memo(function OrderRow({
  orderId, productSlug, orderPrice, orderUserId, currentUserId, quantity,
}: {
  orderId: string; productSlug: string; orderPrice: number;
  orderUserId: string; currentUserId: string; quantity: number;
}) {
  const s = useStore<DB>();
  const { state, actions, ready } = s.useEntity(order, orderId);
  const [error, setError] = useState<string | null>(null);
  const [showSyncInfo, setShowSyncInfo] = useState(false);

  // The order appears in allOrders because place() called emit(). If the
  // entity status is still 'draft' (the initial state), it means this
  // client's entity subscription hasn't received the server state yet.
  // This is the view/entity duality — the CRDT view is ahead of the
  // durable entity on this client.
  const status = state?.status || null;
  const awaitingSync = !ready || state == null || !status || status === 'draft';
  const nextAction = status && !awaitingSync ? NEXT_ACTION[status] : null;
  const isOwner = orderUserId === currentUserId;
  const canCancel = status === 'placed';

  async function handleAdvance() {
    if (!nextAction) return;
    setError(null);
    try {
      const fn = actions[nextAction as keyof typeof actions] as () => Promise<unknown>;
      await fn();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  async function handleCancel() {
    setError(null);
    try {
      await s.runWorkflow(cancelOrder, {
        userId: orderUserId,
        orderId,
        productSlug,
        price: orderPrice,
        timestamp: Date.now(),
      });
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  // ── Awaiting entity sync ──────────────────────────────────────
  if (awaitingSync) {
    return (
      <div className="order-row order-row-syncing">
        <div className="order-info">
          <span
            className="status-badge status-syncing"
            onClick={() => setShowSyncInfo((v) => !v)}
            title="Click to learn more"
          >
            <span className="sync-dot" />
            syncing
          </span>
          <span className="order-product">{productSlug}</span>
          <span className="order-price">${orderPrice}</span>
          <span className="order-user">{orderUserId}</span>
        </div>
        {showSyncInfo && (
          <div className="sync-explainer">
            <strong>View vs. Entity — two layers of state</strong>
            <p>
              This row appeared via a <em>CRDT view</em> — the order exists in the
              replicated <code>orderIndex</code> table. But the actor&rsquo;s
              authoritative state (status, transitions) comes from <em>Restate</em>,
              which hasn&rsquo;t delivered it to this client yet.
            </p>
            <p>
              The other browser tab may already show &ldquo;placed&rdquo; because
              its entity subscription connected first. This is the
              <strong> eventual consistency</strong> gap between CRDT views and
              durable entities — the framework resolves it automatically once the
              entity state arrives.
            </p>
          </div>
        )}
      </div>
    );
  }

  // ── Normal order row ──────────────────────────────────────────
  return (
    <div className="order-row">
      <div className="order-info">
        <span
          className="status-badge"
          style={{ background: `${STATUS_COLORS[status ?? 'draft']}22`, color: STATUS_COLORS[status ?? 'draft'] }}
        >
          {status}
        </span>
        <span className="order-product">
          {productSlug}
          {quantity > 1 && <span style={{ color: '#6366f1', fontWeight: 600, marginLeft: '0.25rem' }}>&times;{quantity}</span>}
        </span>
        <span className="order-price">${orderPrice}</span>
        <span className="order-user">{orderUserId}</span>
      </div>
      {isOwner && nextAction && (
        <button type="button" className="btn btn-sm" onClick={handleAdvance}>
          {nextAction}
        </button>
      )}
      {isOwner && canCancel && (
        <button type="button" className="btn btn-sm" onClick={handleCancel} style={{ color: '#ef4444' }}>
          cancel
        </button>
      )}
      {error && <span className="error-flash" style={{ fontSize: '0.7rem' }}>{error}</span>}
    </div>
  );
});
