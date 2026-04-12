import { memo } from 'react';
import { useStore } from '@syncengine/client';
import type { DB } from '../App';
import { totalSales, salesByProduct, recentActivity } from '../schema';

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const ActivityTab = memo(function ActivityTab() {
  const s = useStore<DB>();
  const { views } = s.useView({ totalSales, salesByProduct, recentActivity });

  const stats = views.totalSales[0] ?? { revenue: 0, count: 0 };
  const byProduct = [...views.salesByProduct].sort((a, b) => b.total - a.total);
  const recent = views.recentActivity;

  return (
    <div>
      <div className="section-heading">
        Activity Dashboard
        <span className="pattern-badge emit">emit()</span>
      </div>

      <div className="stat-row">
        <div className="stat-card">
          <div className="label">Revenue</div>
          <div className="value">{fmt(stats.revenue)}</div>
        </div>
        <div className="stat-card">
          <div className="label">Orders</div>
          <div className="value">{stats.count}</div>
        </div>
        <div className="stat-card">
          <div className="label">Avg Order</div>
          <div className="value">{stats.count > 0 ? fmt(stats.revenue / stats.count) : '$0'}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div className="card">
          <div className="section-heading" style={{ fontSize: '0.8rem' }}>Sales by Product</div>
          {byProduct.length === 0 ? (
            <div style={{ color: '#71717a', fontSize: '0.8rem' }}>No sales yet</div>
          ) : (
            byProduct.map((row) => {
              const maxTotal = byProduct[0]?.total ?? 1;
              const pct = (row.total / maxTotal) * 100;
              return (
                <div key={String(row.productSlug)} style={{ marginBottom: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                    <span>{String(row.productSlug)}</span>
                    <span style={{ fontFamily: 'var(--mono)', color: '#71717a' }}>{fmt(row.total)} ({row.count})</span>
                  </div>
                  <div style={{ background: '#27272a', borderRadius: '2px', height: '4px' }}>
                    <div style={{ background: '#6366f1', borderRadius: '2px', height: '4px', width: `${pct}%` }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="card">
          <div className="section-heading" style={{ fontSize: '0.8rem' }}>Recent Activity</div>
          {recent.length === 0 ? (
            <div style={{ color: '#71717a', fontSize: '0.8rem' }}>No transactions yet</div>
          ) : (
            <div className="activity-feed">
              {recent.map((txn) => {
                const time = new Date(Number(txn.timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                return (
                  <div key={`${txn.userId}-${txn.productSlug}-${txn.timestamp}`} className="activity-row">
                    <span className="activity-time">{time}</span>
                    <span className="activity-user">{String(txn.userId)}</span>
                    <span>{String(txn.type)}</span>
                    <span style={{ fontFamily: 'var(--mono)' }}>{String(txn.productSlug)}</span>
                    <span style={{ fontFamily: 'var(--mono)', marginLeft: 'auto' }}>{fmt(Number(txn.amount))}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
