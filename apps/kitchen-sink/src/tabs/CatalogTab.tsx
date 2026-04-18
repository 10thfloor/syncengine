import { memo, useState, useRef, useEffect } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { PRODUCT_SEED, INITIAL_STOCK, type ProductSlug } from '../schema';
import { inventory } from '../entities/inventory.actor';

export const CatalogTab = memo(function CatalogTab({ userId }: { userId: string }) {
  return (
    <div>
      <div className="section-heading">
        Products
        <span className="pattern-badge invariant">invariant</span>
        <span className="pattern-badge emit">emit()</span>
      </div>
      <div className="card-grid">
        {PRODUCT_SEED.map((p) => (
          <ProductCard key={p.slug} slug={p.slug} name={p.name} price={p.price} emoji={p.imageEmoji} userId={userId} />
        ))}
      </div>
    </div>
  );
});

const ProductCard = memo(function ProductCard({
  slug, name, price, emoji, userId,
}: {
  slug: ProductSlug; name: string; price: number; emoji: string; userId: string;
}) {
  const s = useStore<DB>();
  const { state, actions, ready } = s.useEntity(inventory, slug);
  const [error, setError] = useState<string | null>(null);
  const seededRef = useRef(false);

  const stock = state?.stock ?? 0;
  const totalSold = state?.totalSold ?? 0;
  const initialStock = INITIAL_STOCK[slug];

  async function handleRestock(amount: number) {
    setError(null);
    try {
      await actions.restock(amount);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  // Auto-seed stock on first use (guarded against StrictMode double-mount)
  useEffect(() => {
    if (ready && stock === 0 && totalSold === 0 && !seededRef.current) {
      seededRef.current = true;
      void handleRestock(initialStock);
    }
  }, [ready, stock, totalSold]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card product-card">
      <div className="emoji">{emoji}</div>
      <div className="name">{name}</div>
      <div className="price">${price}</div>
      <div className="stock">
        {ready ? (
          <>
            <strong>{stock}</strong> in stock
            {totalSold > 0 && <> &middot; {totalSold} sold</>}
          </>
        ) : '...'}
      </div>
      {error && <div className="error-flash">{error}</div>}
      <button type="button" className="btn btn-sm" onClick={() => handleRestock(5)} disabled={!ready}>
        Restock +5
      </button>
    </div>
  );
});
