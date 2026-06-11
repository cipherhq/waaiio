'use client';

import { formatCurrency, type CountryCode } from '@/lib/constants';
import type { Product } from './types';

interface SalesAnalyticsProps {
  orderStats: {
    totalOrders: number;
    totalRevenue: number;
    avgOrderValue: number;
    bestSellers: { name: string; qty: number; pct: number; revenue: number }[];
  };
  products: Product[];
  country: CountryCode;
}

export default function SalesAnalytics({ orderStats, products, country }: SalesAnalyticsProps) {
  const productNameMap: Record<string, string> = {};
  for (const p of products) productNameMap[p.id] = p.name;
  const bestSellers = orderStats.bestSellers
    .map(s => ({ ...s, name: productNameMap[s.name] || '' }))
    .filter(s => s.name); // Hide deleted products from best sellers
  const topProductName = bestSellers[0]?.name || '—';

  return (
    <div className="mt-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-blue-600">Total Orders</p>
          <p className="mt-1 text-2xl font-bold text-blue-900">{orderStats.totalOrders}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-green-600">Product Revenue</p>
          <p className="mt-1 text-2xl font-bold text-green-900">{formatCurrency(orderStats.totalRevenue, country)}</p>
        </div>
        <div className="rounded-xl border border-orange-100 bg-orange-50 p-4">
          <p className="text-xs font-medium text-orange-600">Avg Order Value</p>
          <p className="mt-1 text-2xl font-bold text-orange-900">{formatCurrency(Math.round(orderStats.avgOrderValue), country)}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Top Product</p>
          <p className="mt-1 text-lg font-bold text-gray-900 truncate">{topProductName}</p>
        </div>
      </div>

      {/* Best Sellers */}
      {bestSellers.length > 0 && (
        <div className="mt-4 rounded-xl border border-gray-100 bg-white">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-sm font-semibold text-gray-900">Best Sellers</p>
          </div>
          <div className="divide-y divide-gray-50">
            {bestSellers.map((item, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <p className="truncate text-sm font-medium text-gray-900">{item.name}</p>
                    <p className="shrink-0 text-sm font-semibold text-gray-900">{formatCurrency(item.revenue, country)}</p>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-gray-100">
                      <div className="h-1.5 rounded-full bg-brand" style={{ width: `${item.pct}%` }} />
                    </div>
                    <span className="shrink-0 text-xs text-gray-500">{item.qty} sold ({item.pct}%)</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
