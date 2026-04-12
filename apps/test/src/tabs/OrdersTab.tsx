import { memo, useState } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { allOrders } from '../schema';
import { order, NEXT_ACTION, STATUS_COLORS } from '../entities/order.actor';

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

  const status = state?.status ?? 'draft';
  const nextAction = NEXT_ACTION[status];
  const isOwner = orderUserId === currentUserId;
  const canCancel = status === 'draft' || status === 'placed';

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
      await actions.cancel();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="order-row">
      <div className="order-info">
        <span
          className="status-badge"
          style={{ background: `${STATUS_COLORS[status]}22`, color: STATUS_COLORS[status] }}
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
      {ready && isOwner && nextAction && (
        <button type="button" className="btn btn-sm" onClick={handleAdvance}>
          {nextAction}
        </button>
      )}
      {ready && isOwner && canCancel && (
        <button type="button" className="btn btn-sm" onClick={handleCancel} style={{ color: '#ef4444' }}>
          cancel
        </button>
      )}
      {error && <span className="error-flash" style={{ fontSize: '0.7rem' }}>{error}</span>}
    </div>
  );
});
