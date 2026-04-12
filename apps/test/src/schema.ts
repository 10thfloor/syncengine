import {
  table, id, real, text, integer, view,
  sum, count, channel,
} from '@syncengine/core';

// ── Domain constants ──────────────────────────────────────────────

export const PRODUCT_SLUGS = [
  'headphones', 'keyboard', 'usb-hub', 'desk-mat', 'webcam', 'monitor-light',
] as const;

export type ProductSlug = typeof PRODUCT_SLUGS[number];

export const TXN_TYPES = ['sale', 'restock'] as const;

export const ORDER_STATUSES = [
  'draft', 'placed', 'packed', 'shipped', 'delivered', 'cancelled',
] as const;

export type OrderStatus = typeof ORDER_STATUSES[number];

// ── Tables ────────────────────────────────────────────────────────

export const products = table('products', {
  id: id(),
  name: text(),
  slug: text({ enum: PRODUCT_SLUGS }),
  price: real(),
  imageEmoji: text(),
});

export const transactions = table('transactions', {
  id: id(),
  productSlug: text({ enum: PRODUCT_SLUGS }),
  userId: text(),
  amount: real(),
  type: text({ enum: TXN_TYPES }),
  timestamp: integer(),
});

export const orderIndex = table('orderIndex', {
  id: id(),
  orderId: text(),
  productSlug: text({ enum: PRODUCT_SLUGS }),
  userId: text(),
  price: real(),
  createdAt: integer(),
});

// ── Views ─────────────────────────────────────────────────────────

export const salesByProduct = view(transactions)
  .filter(transactions.type, 'eq', 'sale')
  .aggregate([transactions.productSlug], {
    total: sum(transactions.amount),
    count: count(),
  });

export const recentActivity = view(transactions)
  .topN(transactions.timestamp, 10, 'desc');

export const totalSales = view(transactions)
  .filter(transactions.type, 'eq', 'sale')
  .aggregate([], {
    revenue: sum(transactions.amount),
    count: count(),
  });

export const allOrders = view(orderIndex).distinct();

// ── Channels ──────────────────────────────────────────────────────

export const catalogChannel = channel('catalog', [products]);
export const ledgerChannel = channel('ledger', [transactions, orderIndex]);

// ── Seed data ─────────────────────────────────────────────────────

export const PRODUCT_SEED = [
  { id: 1, name: 'Wireless Headphones', slug: 'headphones' as const,  price: 79,  imageEmoji: '\u{1F3A7}' },
  { id: 2, name: 'Mechanical Keyboard', slug: 'keyboard' as const,    price: 129, imageEmoji: '\u{2328}\u{FE0F}' },
  { id: 3, name: 'USB-C Hub',           slug: 'usb-hub' as const,     price: 49,  imageEmoji: '\u{1F50C}' },
  { id: 4, name: 'Standing Desk Mat',   slug: 'desk-mat' as const,    price: 35,  imageEmoji: '\u{1F5B1}\u{FE0F}' },
  { id: 5, name: 'Webcam HD',           slug: 'webcam' as const,      price: 65,  imageEmoji: '\u{1F4F7}' },
  { id: 6, name: 'Monitor Light',       slug: 'monitor-light' as const, price: 45, imageEmoji: '\u{1F4A1}' },
] as const;

export const INITIAL_STOCK: Record<ProductSlug, number> = {
  'headphones': 10,
  'keyboard': 8,
  'usb-hub': 15,
  'desk-mat': 12,
  'webcam': 6,
  'monitor-light': 10,
};
