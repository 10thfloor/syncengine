import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { PRODUCT_SEED, type ProductSlug } from '../schema';
import { inventory } from '../entities/inventory.actor';
import { checkout } from '../workflows/checkout.workflow';

const RESERVATION_TTL_MS = 30_000;

export const CheckoutTab = memo(function CheckoutTab({ userId }: { userId: string }) {
  const [selectedSlug, setSelectedSlug] = useState<ProductSlug>(PRODUCT_SEED[0].slug);
  const product = PRODUCT_SEED.find((p) => p.slug === selectedSlug)!;

  return (
    <div>
      <div className="section-heading">
        Checkout
        <span className="pattern-badge saga">saga</span>
        <span className="pattern-badge lease">lease</span>
      </div>
      <div className="checkout-flow">
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <label style={{ fontSize: '0.85rem', color: '#71717a' }}>Product:</label>
          <select
            className="select"
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value as ProductSlug)}
          >
            {PRODUCT_SEED.map((p) => (
              <option key={p.slug} value={p.slug}>{p.imageEmoji} {p.name} — ${p.price}</option>
            ))}
          </select>
        </div>
        <CheckoutFlow slug={selectedSlug} price={product.price} userId={userId} />
      </div>
    </div>
  );
});

const CheckoutFlow = memo(function CheckoutFlow({
  slug, price, userId,
}: {
  slug: ProductSlug; price: number; userId: string;
}) {
  const s = useStore<DB>();
  const { state, actions, ready } = s.useEntity(inventory, slug);
  const [error, setError] = useState<string | null>(null);
  const [reservedAt, setReservedAt] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [buying, setBuying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stock = state?.stock ?? 0;
  const reserved = state?.reserved ?? 0;
  const reservedBy = state?.reservedBy ?? '';
  const isReservedByMe = reservedBy === userId;
  const available = stock - reserved;

  // Sync reservation state from entity
  useEffect(() => {
    if (isReservedByMe && state?.reservedAt) {
      setReservedAt(state.reservedAt);
    } else {
      setReservedAt(null);
    }
  }, [isReservedByMe, state?.reservedAt]);

  // Countdown timer
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!reservedAt) { setTimeLeft(0); return; }

    function tick() {
      const remaining = Math.max(0, RESERVATION_TTL_MS - (Date.now() - reservedAt!));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        void actions.releaseReservation(userId).catch(() => {});
        setReservedAt(null);
      }
    }
    tick();
    timerRef.current = setInterval(tick, 100);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [reservedAt, userId]); // eslint-disable-line react-hooks/exhaustive-deps — actions is a stable proxy

  const handleReserve = useCallback(async () => {
    setError(null);
    try {
      await actions.reserve(userId, Date.now());
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, [actions, userId]);

  const handleRelease = useCallback(async () => {
    setError(null);
    try {
      await actions.releaseReservation(userId);
      setReservedAt(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }, [actions, userId]);

  const handleBuy = useCallback(async () => {
    setError(null);
    setBuying(true);
    const orderId = crypto.randomUUID();
    try {
      await s.runWorkflow(checkout, { userId, orderId, productSlug: slug, price });
      setReservedAt(null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setBuying(false);
    }
  }, [s, userId, price, slug]);

  const timerSeconds = (timeLeft / 1000).toFixed(1);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.85rem' }}>
        <span>Stock: <strong>{stock}</strong></span>
        <span style={{ color: '#71717a' }}>Available: <strong>{available}</strong></span>
        {reservedBy && !isReservedByMe && (
          <span style={{ color: '#ef4444' }}>Reserved by {reservedBy}</span>
        )}
      </div>

      {!isReservedByMe ? (
        <button type="button" className="btn btn-primary" onClick={handleReserve} disabled={!ready || available <= 0}>
          Reserve 1 unit
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span className={`timer${timeLeft <= 5000 ? ' expired' : ''}`}>
              {timerSeconds}s
            </span>
            <span style={{ fontSize: '0.8rem', color: '#71717a' }}>reservation active</span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn-primary" onClick={handleBuy} disabled={buying}>
              {buying ? 'Processing...' : `Buy for $${price}`}
            </button>
            <button type="button" className="btn" onClick={handleRelease}>
              Release
            </button>
          </div>
        </>
      )}

      {error && <div className="error-flash">{error}</div>}
    </div>
  );
});
