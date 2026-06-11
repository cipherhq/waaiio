'use client';

import Link from 'next/link';
import Image from 'next/image';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';
import type { Product, CatalogSyncLog, ViewMode } from './types';
import SalesAnalytics from './SalesAnalytics';

interface ProductListProps {
  products: Product[];
  filtered: Product[];
  filter: 'all' | 'active' | 'inactive';
  setFilter: (filter: 'all' | 'active' | 'inactive') => void;
  setView: (view: ViewMode) => void;
  openAdd: () => void;
  openEdit: (product: Product) => void;
  handleDelete: (id: string) => void;
  toggleActive: (product: Product) => void;
  country: CountryCode;
  curr: string;
  labels: { personLabelPlural: string };
  capabilities: string[];
  business: { id: string; subscription_tier?: string; whatsapp_catalog_id?: string | null };
  // Sync
  hasWhatsAppChannel: boolean;
  syncing: boolean;
  syncMessage: { type: 'success' | 'error'; text: string } | null;
  setSyncMessage: (msg: { type: 'success' | 'error'; text: string } | null) => void;
  handleCatalogSync: () => void;
  syncLogs: CatalogSyncLog[];
  showSyncHistory: boolean;
  setShowSyncHistory: (v: boolean) => void;
  // Analytics
  orderStats: {
    totalOrders: number;
    totalRevenue: number;
    avgOrderValue: number;
    bestSellers: { name: string; qty: number; pct: number; revenue: number }[];
  } | null;
}

export default function ProductList({
  products,
  filtered,
  filter,
  setFilter,
  setView,
  openAdd,
  openEdit,
  handleDelete,
  toggleActive,
  country,
  curr,
  labels,
  capabilities,
  business,
  hasWhatsAppChannel,
  syncing,
  syncMessage,
  setSyncMessage,
  handleCatalogSync,
  syncLogs,
  showSyncHistory,
  setShowSyncHistory,
  orderStats,
}: ProductListProps) {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <p className="mt-1 text-sm text-gray-500">
            {products.length === 0
              ? `Add your products so ${labels.personLabelPlural.toLowerCase()} can browse and order via WhatsApp`
              : `${products.length} product${products.length !== 1 ? 's' : ''} in your catalog`}
          </p>
        </div>
        <div className="flex gap-2">
          {hasWhatsAppChannel && products.length > 0 && business.subscription_tier === 'business' && (
            <button
              onClick={handleCatalogSync}
              disabled={syncing}
              className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {syncing ? 'Syncing...' : 'Sync to WhatsApp'}
            </button>
          )}
          <button
            onClick={() => setView('bulk')}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Bulk Upload
          </button>
          <button
            onClick={openAdd}
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + Add Product
          </button>
        </div>
      </div>

      <PageHelp
        pageKey="products"
        title="Your Products"
        description="This is your product catalog. Customers browse these items and add them to their cart on WhatsApp. Add photos, prices, and descriptions to help customers choose."
      />

      {/* Sync status banner */}
      {syncMessage && (
        <div className={`mt-3 flex items-center justify-between rounded-lg px-4 py-2.5 ${
          syncMessage.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          <p className="text-sm font-medium">{syncMessage.text}</p>
          <button onClick={() => setSyncMessage(null)} className="ml-2 text-sm opacity-60 hover:opacity-100">&times;</button>
        </div>
      )}

      {/* Shipping config link */}
      {capabilities.includes('ordering') && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-4 py-2.5">
          <svg aria-hidden="true" className="h-4 w-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-xs text-blue-700 dark:text-blue-400">
            Set up <Link href="/dashboard/settings" className="font-semibold underline">shipping rates and delivery zones</Link> in Settings to charge customers for delivery.
          </p>
        </div>
      )}

      {/* Filters */}
      {products.length > 3 && (
        <div className="mt-4 flex gap-2">
          {(['all', 'active', 'inactive'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                filter === f ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}{f === 'all' ? ` (${products.length})` : ''}
            </button>
          ))}
        </div>
      )}

      {/* Sales Analytics */}
      {orderStats && products.length > 0 && (
        <SalesAnalytics orderStats={orderStats} products={products} country={country} />
      )}

      {/* Empty state */}
      {products.length === 0 ? (
        <EmptyState
          icon="🛒"
          title="No products yet"
          description="Add your menu items or products. Customers can browse and order directly on WhatsApp."
          actionLabel="Add your first product"
          onAction={openAdd}
          tip="Add a photo to get 3x more orders."
        />
      ) : (
        /* Product grid */
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((product) => (
            <div
              key={product.id}
              data-product-id={product.id}
              className={`group cursor-pointer rounded-xl border bg-white overflow-hidden transition hover:shadow-sm ${
                product.is_active ? 'border-gray-100 hover:border-gray-200' : 'border-gray-100 opacity-60'
              }`}
              onClick={() => openEdit(product)}
            >
              {/* Image */}
              {product.image_url ? (
                <div className="relative h-44 w-full bg-gray-50 p-2">
                  <Image src={product.image_url} alt={product.name} fill className="object-contain p-2" sizes="(max-width: 768px) 50vw, 25vw" />
                </div>
              ) : (
                <div className="flex h-20 w-full items-center justify-center bg-gray-50">
                  <svg aria-hidden="true" className="h-6 w-6 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
              )}

              <div className="p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1 pr-2">
                    <h3 className="text-sm font-semibold text-gray-900">{product.name}</h3>
                    {product.category && (
                      <span className="mt-0.5 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">{product.category}</span>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {product.refundable && (
                      <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-600">Refundable</span>
                    )}
                    {!product.is_active && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Inactive</span>
                    )}
                  </div>
                </div>

                {product.description && (
                  <p className="mt-1.5 text-xs text-gray-500 line-clamp-2">{product.description}</p>
                )}

                <div className="mt-3 flex items-center justify-between">
                  <span className="text-sm font-bold text-gray-900">
                    {(() => {
                      if (!product.has_variants) return formatCurrency(product.price, country);
                      const ext = product as Product & { _price_min?: number; _price_max?: number };
                      return ext._price_min !== undefined
                        ? `${formatCurrency(ext._price_min, country)} \u2013 ${formatCurrency(ext._price_max!, country)}`
                        : 'Variants';
                    })()}
                  </span>
                  <div className="flex items-center gap-2">
                    {product.has_variants && (
                      <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs text-purple-600">Variants</span>
                    )}
                    {product.allow_promo && (
                      <span className="text-xs text-brand">Promo</span>
                    )}
                    {!product.has_variants && product.track_inventory && product.stock_quantity !== null ? (
                      <span className={`text-xs ${
                        product.stock_quantity <= 0 ? 'font-medium text-red-500'
                          : product.stock_quantity <= product.low_stock_threshold ? 'font-medium text-amber-600'
                          : 'text-gray-500'
                      }`}>
                        {product.stock_quantity <= 0 ? 'Out of stock'
                          : product.stock_quantity <= product.low_stock_threshold ? `Low (${product.stock_quantity})`
                          : `${product.stock_quantity} in stock`}
                      </span>
                    ) : !product.has_variants && product.stock_quantity !== null ? (
                      <span className="text-xs text-gray-500">{product.stock_quantity} in stock</span>
                    ) : null}
                  </div>
                </div>

                {/* Quick actions bar */}
                <div className="mt-3 flex items-center justify-between border-t border-gray-50 pt-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleActive(product); }}
                      className={`relative h-6 w-11 rounded-full transition ${product.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                    >
                      <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: product.is_active ? '22px' : '2px' }} />
                    </button>
                    {hasWhatsAppChannel && business.subscription_tier === 'business' && (
                      <span className={`flex items-center gap-1 text-xs ${product.catalog_synced_at ? 'text-green-600' : 'text-gray-400'}`}>
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${product.catalog_synced_at ? 'bg-green-500' : 'bg-gray-300'}`} />
                        {product.catalog_synced_at ? 'Synced' : 'Not synced'}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(product.id); }}
                    className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sync History */}
      {hasWhatsAppChannel && business.subscription_tier === 'business' && syncLogs.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowSyncHistory(!showSyncHistory)}
            className="flex items-center gap-2 text-sm font-semibold text-gray-700 hover:text-gray-900"
          >
            <svg
              aria-hidden="true"
              className={`h-4 w-4 transition-transform ${showSyncHistory ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Sync History
          </button>
          {showSyncHistory && (
            <div className="mt-3 rounded-xl border border-gray-100 bg-white divide-y divide-gray-50">
              {syncLogs.map((log) => (
                <div key={log.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className={`inline-block h-2 w-2 rounded-full ${
                      log.status === 'success' ? 'bg-green-500'
                        : log.status === 'partial' ? 'bg-amber-500'
                        : log.status === 'failed' ? 'bg-red-500'
                        : 'bg-gray-400'
                    }`} />
                    <div>
                      <p className="text-sm text-gray-900">
                        {log.synced_count} synced{log.failed_count > 0 ? `, ${log.failed_count} failed` : ''}
                      </p>
                      {log.error_message && (
                        <p className="text-xs text-red-500">{log.error_message}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      log.status === 'success' ? 'bg-green-50 text-green-700'
                        : log.status === 'partial' ? 'bg-amber-50 text-amber-700'
                        : log.status === 'failed' ? 'bg-red-50 text-red-700'
                        : 'bg-gray-50 text-gray-600'
                    }`}>
                      {log.status}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(log.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
