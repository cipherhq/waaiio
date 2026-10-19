'use client';

import { useRef } from 'react';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';
import type { CountryCode } from '@/lib/constants';
import type {
  Product,
  ProductVariant,
  ProductAddon,
  VolumeDiscountRule,
  OptionGroup,
  ViewMode,
} from './types';
import {
  EMPTY_ADDON,
  EMPTY_DISCOUNT,
  EMPTY_VARIANT,
  generateCombinations,
} from './types';
import ToggleRow from './ToggleRow';
import OptionValueInput from './OptionValueInput';

interface ProductFormProps {
  view: 'add' | 'edit';
  form: Omit<Product, 'id'> & { id?: string };
  setForm: (form: Omit<Product, 'id'> & { id?: string }) => void;
  saving: boolean;
  uploadingImage: boolean;
  imagePreview: string | null;
  imageInputRef: React.RefObject<HTMLInputElement>;
  handleImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSave: () => void;
  handleDelete: (id: string) => void;
  setView: (view: ViewMode) => void;
  curr: string;
  labels: { personLabelPlural: string };
  business: { id: string };
  country: CountryCode;
  categories: (string | null)[];
  // Variants
  variants: ProductVariant[];
  setVariants: (variants: ProductVariant[]) => void;
  deletedVariantIds: string[];
  setDeletedVariantIds: React.Dispatch<React.SetStateAction<string[]>>;
  optionGroups: OptionGroup[];
  setOptionGroups: (groups: OptionGroup[]) => void;
  bulkPrice: string;
  setBulkPrice: (price: string) => void;
  variantImageFiles: Record<number, File>;
  setVariantImageFiles: React.Dispatch<React.SetStateAction<Record<number, File>>>;
  variantImageRefs: React.MutableRefObject<Record<number, HTMLInputElement | null>>;
  isMultiAxis: boolean;
  handleGenerateVariants: () => void;
  applyBulkPrice: () => void;
  handleVariantImageSelect: (idx: number, e: React.ChangeEvent<HTMLInputElement>) => void;
  // Add-ons
  addons: ProductAddon[];
  setAddons: (addons: ProductAddon[]) => void;
  deletedAddonIds: string[];
  setDeletedAddonIds: React.Dispatch<React.SetStateAction<string[]>>;
  hasAddons: boolean;
  setHasAddons: (v: boolean) => void;
  // Volume Discounts
  volumeDiscounts: VolumeDiscountRule[];
  setVolumeDiscounts: (rules: VolumeDiscountRule[]) => void;
  deletedDiscountIds: string[];
  setDeletedDiscountIds: React.Dispatch<React.SetStateAction<string[]>>;
  hasVolumeDiscounts: boolean;
  setHasVolumeDiscounts: (v: boolean) => void;
  // Promo codes
  promoCodes: Array<{ code: string; discount_type: string; discount_value: number; is_active: boolean }>;
  setPromoCodes: (codes: Array<{ code: string; discount_type: string; discount_value: number; is_active: boolean }>) => void;
  promoCodesLoaded: boolean;
  setPromoCodesLoaded: (v: boolean) => void;
}

export default function ProductForm({
  view,
  form,
  setForm,
  saving,
  uploadingImage,
  imagePreview,
  imageInputRef,
  handleImageSelect,
  handleSave,
  handleDelete,
  setView,
  curr,
  labels,
  business,
  categories,
  variants,
  setVariants,
  setDeletedVariantIds,
  optionGroups,
  setOptionGroups,
  bulkPrice,
  setBulkPrice,
  variantImageRefs,
  isMultiAxis,
  handleGenerateVariants,
  applyBulkPrice,
  handleVariantImageSelect,
  addons,
  setAddons,
  setDeletedAddonIds,
  hasAddons,
  setHasAddons,
  volumeDiscounts,
  setVolumeDiscounts,
  setDeletedDiscountIds,
  hasVolumeDiscounts,
  setHasVolumeDiscounts,
  promoCodes,
  setPromoCodes,
  promoCodesLoaded,
  setPromoCodesLoaded,
}: ProductFormProps) {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setView('list')}
          className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
        >
          <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          {view === 'add' ? 'Add Product' : 'Edit Product'}
        </h1>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
        {/* ── Left column: Main details ── */}
        <div className="space-y-4">
          {/* Image */}
          <div
            onClick={() => imageInputRef.current?.click()}
            className="relative cursor-pointer overflow-hidden rounded-xl border-2 border-dashed border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 transition hover:border-brand hover:bg-gray-100"
          >
            {imagePreview ? (
              <div className="relative h-48 w-full bg-gray-100">
                <Image src={imagePreview} alt="Product" fill className="object-contain" sizes="(max-width: 768px) 100vw, 50vw" />
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition hover:bg-black/30">
                  <span className="rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-gray-700 opacity-0 transition hover:opacity-100">
                    Change Photo
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex h-36 flex-col items-center justify-center gap-2">
                <svg aria-hidden="true" className="h-8 w-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="text-sm text-gray-400 dark:text-gray-500">Tap to add product photo</span>
                <span className="text-xs text-gray-300 dark:text-gray-600">JPEG, PNG, WebP — max 5MB</span>
              </div>
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/heic,.jpg,.jpeg,.png,.webp,.gif,.svg,.heic"
              onChange={handleImageSelect}
              className="hidden"
            />
          </div>

          {/* Product Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Product Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Jollof Rice, Men's T-Shirt, Movie Ticket"
              className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
              autoFocus
            />
          </div>

          {/* Price + Stock — side by side (hidden when variants enabled) */}
          {!form.has_variants && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Price ({curr}) <span className="text-red-400">*</span>
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 dark:text-gray-500">{curr}</span>
                  <input
                    type="number"
                    min={0}
                    value={form.price || ''}
                    onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
                    placeholder="Enter amount"
                    className="w-full rounded-lg border border-gray-200 py-2.5 pl-7 pr-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Stock Quantity</label>
                <input
                  type="number"
                  min={0}
                  value={form.stock_quantity ?? ''}
                  onChange={(e) => setForm({ ...form, stock_quantity: e.target.value ? Number(e.target.value) : null })}
                  placeholder="Unlimited"
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                />
                <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">Leave empty = unlimited</p>
              </div>
            </div>
          )}
          {form.has_variants && (
            <div className="rounded-lg bg-blue-50 p-3">
              <p className="text-xs text-blue-700">
                Price and stock are set per variant below.
              </p>
            </div>
          )}

          {/* Description */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
            <textarea
              value={form.description || ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              placeholder="Brief description of the product (optional)"
              className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
            />
          </div>

          {/* Category */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Category</label>
            <input
              type="text"
              value={form.category || ''}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              placeholder="e.g. Food, Drinks, Tickets, Accessories"
              className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
              list="product-categories"
            />
            {categories.length > 0 && (
              <datalist id="product-categories">
                {categories.map(c => <option key={c} value={c!} />)}
              </datalist>
            )}
          </div>

          {/* Shipping Cost */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Shipping Cost ({curr})</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 dark:text-gray-500">{curr}</span>
              <input
                type="number"
                min={0}
                value={form.shipping_cost ?? ''}
                onChange={(e) => setForm({ ...form, shipping_cost: e.target.value ? Number(e.target.value) : null })}
                placeholder="Enter amount"
                className="w-full rounded-lg border border-gray-200 py-2.5 pl-7 pr-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
              />
            </div>
            <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">Per-product shipping cost (optional)</p>
          </div>

          {/* Add-ons */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Product Add-ons</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">E.g. extra servers, ice, gift wrapping, setup fee</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const newHasAddons = !hasAddons;
                  setHasAddons(newHasAddons);
                  if (newHasAddons && addons.length === 0) {
                    setAddons([{ ...EMPTY_ADDON, sort_order: 0 }]);
                  }
                }}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${hasAddons ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: hasAddons ? '22px' : '2px' }} />
              </button>
            </div>

            {hasAddons && (
              <div className="mt-4 space-y-3">
                {addons.map((addon, idx) => (
                  <div key={addon.id || idx} className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-3 space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Add-on Name</label>
                        <input
                          type="text"
                          value={addon.name}
                          onChange={(e) => {
                            const updated = [...addons];
                            updated[idx] = { ...updated[idx], name: e.target.value };
                            setAddons(updated);
                          }}
                          placeholder="e.g. Extra Servers"
                          className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                        />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Price ({curr})</label>
                          <input
                            type="number"
                            min={0}
                            value={addon.price || ''}
                            onChange={(e) => {
                              const updated = [...addons];
                              updated[idx] = { ...updated[idx], price: Number(e.target.value) || 0 };
                              setAddons(updated);
                            }}
                            placeholder="Enter amount"
                            disabled={addon.price_type === 'quote'}
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand disabled:bg-gray-50 disabled:text-gray-400"
                          />
                        </div>
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Type</label>
                          <select
                            value={addon.price_type}
                            onChange={(e) => {
                              const updated = [...addons];
                              updated[idx] = { ...updated[idx], price_type: e.target.value as ProductAddon['price_type'] };
                              setAddons(updated);
                            }}
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          >
                            <option value="fixed">Fixed</option>
                            <option value="per_unit">Per Unit</option>
                            <option value="quote">Price Request</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {addon.price_type === 'per_unit' && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Unit Label</label>
                          <input
                            type="text"
                            value={addon.unit_label || ''}
                            onChange={(e) => {
                              const updated = [...addons];
                              updated[idx] = { ...updated[idx], unit_label: e.target.value || null };
                              setAddons(updated);
                            }}
                            placeholder="per person"
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                        </div>
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Min Qty</label>
                          <input
                            type="number"
                            min={0}
                            value={addon.min_quantity ?? ''}
                            onChange={(e) => {
                              const updated = [...addons];
                              updated[idx] = { ...updated[idx], min_quantity: e.target.value ? Number(e.target.value) : null };
                              setAddons(updated);
                            }}
                            placeholder="None"
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                        </div>
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Max Qty</label>
                          <input
                            type="number"
                            min={0}
                            value={addon.max_quantity ?? ''}
                            onChange={(e) => {
                              const updated = [...addons];
                              updated[idx] = { ...updated[idx], max_quantity: e.target.value ? Number(e.target.value) : null };
                              setAddons(updated);
                            }}
                            placeholder="None"
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-1">
                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-1.5 text-xs text-gray-600">
                          <input
                            type="checkbox"
                            checked={addon.is_required}
                            onChange={(e) => {
                              const updated = [...addons];
                              updated[idx] = { ...updated[idx], is_required: e.target.checked };
                              setAddons(updated);
                            }}
                            className="rounded border-gray-300 text-brand focus:ring-brand"
                          />
                          Required
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-gray-600">
                          <input
                            type="checkbox"
                            checked={addon.is_negotiable}
                            onChange={(e) => {
                              const updated = [...addons];
                              updated[idx] = { ...updated[idx], is_negotiable: e.target.checked };
                              setAddons(updated);
                            }}
                            className="rounded border-gray-300 text-brand focus:ring-brand"
                          />
                          Negotiable
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (addon.id) setDeletedAddonIds(prev => [...prev, addon.id!]);
                          setAddons(addons.filter((_, i) => i !== idx));
                        }}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      >
                        <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}

                {addons.length < 10 && (
                  <button
                    type="button"
                    onClick={() => setAddons([...addons, { ...EMPTY_ADDON, sort_order: addons.length }])}
                    className="w-full rounded-lg border border-dashed border-gray-300 dark:border-gray-600 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:border-brand hover:text-brand"
                  >
                    + Add Add-on
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Volume Discounts */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Volume Discounts</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">Auto-apply discounts when customers order in bulk</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const newHas = !hasVolumeDiscounts;
                  setHasVolumeDiscounts(newHas);
                  if (newHas && volumeDiscounts.length === 0) {
                    setVolumeDiscounts([{ ...EMPTY_DISCOUNT, sort_order: 0 }]);
                  }
                }}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${hasVolumeDiscounts ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: hasVolumeDiscounts ? '22px' : '2px' }} />
              </button>
            </div>

            {hasVolumeDiscounts && (
              <div className="mt-4 space-y-3">
                {volumeDiscounts.map((rule, idx) => (
                  <div key={rule.id || idx} className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-3 space-y-2">
                    {/* Preview */}
                    {rule.name && rule.discount_value > 0 && (
                      <div className="rounded bg-brand-50 px-2.5 py-1.5">
                        <p className="text-xs font-medium text-brand">
                          {rule.min_quantity}{rule.max_quantity ? `\u2013${rule.max_quantity}` : '+'} units {'\u2192'} {rule.discount_type === 'percentage' ? `${rule.discount_value}% off` : rule.discount_type === 'fixed_per_unit' ? `${curr}${rule.discount_value} off each` : `${curr}${rule.discount_value} off total`}
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Rule Name</label>
                        <input
                          type="text"
                          value={rule.name}
                          onChange={(e) => {
                            const updated = [...volumeDiscounts];
                            updated[idx] = { ...updated[idx], name: e.target.value };
                            setVolumeDiscounts(updated);
                          }}
                          placeholder="e.g. Bulk Order Discount"
                          className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                        />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Min Qty</label>
                          <input
                            type="number"
                            min={1}
                            value={rule.min_quantity || ''}
                            onFocus={e => e.target.select()}
                            onChange={(e) => {
                              const updated = [...volumeDiscounts];
                              updated[idx] = { ...updated[idx], min_quantity: Number(e.target.value) || 1 };
                              setVolumeDiscounts(updated);
                            }}
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                        </div>
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Max Qty</label>
                          <input
                            type="number"
                            min={0}
                            value={rule.max_quantity ?? ''}
                            onChange={(e) => {
                              const updated = [...volumeDiscounts];
                              updated[idx] = { ...updated[idx], max_quantity: e.target.value ? Number(e.target.value) : null };
                              setVolumeDiscounts(updated);
                            }}
                            placeholder="No cap"
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">Discount Type</label>
                        <select
                          value={rule.discount_type}
                          onChange={(e) => {
                            const updated = [...volumeDiscounts];
                            updated[idx] = { ...updated[idx], discount_type: e.target.value as VolumeDiscountRule['discount_type'] };
                            setVolumeDiscounts(updated);
                          }}
                          className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                        >
                          <option value="percentage">Percentage (%)</option>
                          <option value="fixed_per_unit">Fixed per unit ({curr})</option>
                          <option value="fixed_total">Fixed total ({curr})</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-0.5 block text-xs font-medium text-gray-600 dark:text-gray-400">
                          {rule.discount_type === 'percentage' ? 'Discount (%)' : `Discount (${curr})`}
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={rule.discount_type === 'percentage' ? 0.5 : 1}
                          value={rule.discount_value || ''}
                          onChange={(e) => {
                            const updated = [...volumeDiscounts];
                            updated[idx] = { ...updated[idx], discount_value: Number(e.target.value) || 0 };
                            setVolumeDiscounts(updated);
                          }}
                          placeholder="Enter amount"
                          className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const updated = [...volumeDiscounts];
                            updated[idx] = { ...updated[idx], is_active: !updated[idx].is_active };
                            setVolumeDiscounts(updated);
                          }}
                          className={`relative h-5 w-9 shrink-0 rounded-full transition ${rule.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                        >
                          <div className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition" style={{ left: rule.is_active ? '18px' : '2px' }} />
                        </button>
                        <span className="text-xs text-gray-500 dark:text-gray-400">{rule.is_active ? 'Active' : 'Inactive'}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (rule.id) setDeletedDiscountIds(prev => [...prev, rule.id!]);
                          setVolumeDiscounts(volumeDiscounts.filter((_, i) => i !== idx));
                        }}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      >
                        <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}

                {volumeDiscounts.length < 10 && (
                  <button
                    type="button"
                    onClick={() => setVolumeDiscounts([...volumeDiscounts, { ...EMPTY_DISCOUNT, sort_order: volumeDiscounts.length }])}
                    className="w-full rounded-lg border border-dashed border-gray-300 dark:border-gray-600 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:border-brand hover:text-brand"
                  >
                    + Add Discount Rule
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Variants */}
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Product Variants</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">E.g. different sizes, lengths, colors with different prices</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const newHasVariants = !form.has_variants;
                  setForm({ ...form, has_variants: newHasVariants });
                  if (newHasVariants && variants.length === 0 && optionGroups.length === 0) {
                    setOptionGroups([{ name: '', values: [] }]);
                  }
                }}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.has_variants ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.has_variants ? '22px' : '2px' }} />
              </button>
            </div>

            {form.has_variants && (
              <div className="mt-4 space-y-4">
                {/* Option Groups Editor */}
                <div className="space-y-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Option Groups</p>
                  {optionGroups.map((group, gIdx) => (
                    <div key={gIdx} className="rounded-lg border border-gray-200 bg-white p-3">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 space-y-2">
                          <input
                            type="text"
                            value={group.name}
                            onChange={(e) => {
                              const updated = [...optionGroups];
                              updated[gIdx] = { ...updated[gIdx], name: e.target.value };
                              setOptionGroups(updated);
                            }}
                            placeholder={`Option name (e.g. ${gIdx === 0 ? 'Length' : gIdx === 1 ? 'Color' : 'Size'})`}
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm font-medium outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                          <div className="rounded border border-gray-100 px-2 py-1.5">
                            <OptionValueInput
                              values={group.values}
                              onChange={(values) => {
                                const updated = [...optionGroups];
                                updated[gIdx] = { ...updated[gIdx], values };
                                setOptionGroups(updated);
                              }}
                              maxValues={10}
                            />
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setOptionGroups(optionGroups.filter((_, i) => i !== gIdx));
                          }}
                          className="mt-1.5 shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                        >
                          <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                  {optionGroups.length < 3 && (
                    <button
                      type="button"
                      onClick={() => setOptionGroups([...optionGroups, { name: '', values: [] }])}
                      className="w-full rounded-lg border border-dashed border-gray-300 dark:border-gray-600 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:border-brand hover:text-brand"
                    >
                      + Add Option Group
                    </button>
                  )}
                </div>

                {/* Generate button */}
                {optionGroups.some(g => g.name.trim() && g.values.length > 0) && (
                  <button
                    type="button"
                    onClick={handleGenerateVariants}
                    className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
                  >
                    Generate Variants ({generateCombinations(optionGroups).length} combinations)
                  </button>
                )}

                {/* Variant Grid */}
                {variants.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Variants ({variants.length})
                      </p>
                      {/* Bulk price setter */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Set all prices:</span>
                        <div className="relative w-24">
                          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-gray-500">{curr}</span>
                          <input
                            type="number"
                            min={0}
                            value={bulkPrice || ''}
                            onChange={(e) => setBulkPrice(e.target.value)}
                            placeholder="Enter amount"
                            className="w-full rounded border border-gray-200 py-1.5 pl-5 pr-1 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={applyBulkPrice}
                          disabled={!bulkPrice || Number(bulkPrice) <= 0}
                          className="rounded bg-gray-100 px-2 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200 disabled:opacity-50"
                        >
                          Apply
                        </button>
                      </div>
                    </div>

                    {/* Variant rows */}
                    <div className="max-h-[400px] space-y-2 overflow-auto">
                      {variants.map((v, idx) => (
                        <div key={idx} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-2">
                          {/* Options chips (read-only if multi-axis) */}
                          {isMultiAxis && v.options && Object.keys(v.options).length > 0 ? (
                            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                              {Object.entries(v.options).map(([key, val]) => (
                                <span key={key} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                                  {val}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={v.label}
                              onChange={(e) => {
                                const updated = [...variants];
                                updated[idx] = { ...updated[idx], label: e.target.value };
                                setVariants(updated);
                              }}
                              placeholder="Label (e.g. 8 inches)"
                              className="min-w-0 flex-1 rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                            />
                          )}
                          <div className="relative w-24 shrink-0">
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-gray-500">{curr}</span>
                            <input
                              type="number"
                              min={0}
                              value={v.price || ''}
                              onChange={(e) => {
                                const updated = [...variants];
                                updated[idx] = { ...updated[idx], price: Number(e.target.value) };
                                setVariants(updated);
                              }}
                              placeholder="Price"
                              className="w-full rounded border border-gray-100 py-1.5 pl-6 pr-1 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                            />
                          </div>
                          <input
                            type="number"
                            min={0}
                            value={v.stock_quantity ?? ''}
                            onChange={(e) => {
                              const updated = [...variants];
                              updated[idx] = { ...updated[idx], stock_quantity: e.target.value ? Number(e.target.value) : null };
                              setVariants(updated);
                            }}
                            placeholder="Stock"
                            className="w-16 shrink-0 rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                          <input
                            type="text"
                            value={v.sku}
                            onChange={(e) => {
                              const updated = [...variants];
                              updated[idx] = { ...updated[idx], sku: e.target.value };
                              setVariants(updated);
                            }}
                            placeholder="SKU"
                            className="w-20 shrink-0 rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
                          />
                          {/* Variant image */}
                          <button
                            type="button"
                            onClick={() => variantImageRefs.current[idx]?.click()}
                            className="relative h-8 w-8 shrink-0 overflow-hidden rounded border border-gray-200 bg-gray-50 hover:border-brand"
                            title="Upload variant image"
                          >
                            {v.image_url ? (
                              <Image src={v.image_url} alt={v.label || 'Variant image'} fill className="object-cover" sizes="32px" />
                            ) : (
                              <svg aria-hidden="true" className="mx-auto mt-1 h-5 w-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                              </svg>
                            )}
                            <input
                              ref={(el) => { variantImageRefs.current[idx] = el; }}
                              type="file"
                              accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/heic,.jpg,.jpeg,.png,.webp,.gif,.svg,.heic"
                              onChange={(e) => handleVariantImageSelect(idx, e)}
                              className="hidden"
                            />
                          </button>
                          {/* Active toggle */}
                          <button
                            type="button"
                            onClick={() => {
                              const updated = [...variants];
                              updated[idx] = { ...updated[idx], is_active: !updated[idx].is_active };
                              setVariants(updated);
                            }}
                            className={`relative h-5 w-9 shrink-0 rounded-full transition ${v.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                            title={v.is_active ? 'Active' : 'Inactive'}
                          >
                            <div className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition" style={{ left: v.is_active ? '18px' : '2px' }} />
                          </button>
                          {/* Delete variant (only for non-multi-axis or manual) */}
                          {!isMultiAxis && (
                            <button
                              type="button"
                              onClick={() => {
                                if (v.id) setDeletedVariantIds(prev => [...prev, v.id!]);
                                setVariants(variants.filter((_, i) => i !== idx));
                              }}
                              className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                            >
                              <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Add manual variant (only when not using option groups) */}
                    {!isMultiAxis && (
                      <button
                        type="button"
                        onClick={() => setVariants([...variants, { ...EMPTY_VARIANT, sort_order: variants.length }])}
                        className="w-full rounded-lg border border-dashed border-gray-300 dark:border-gray-600 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:border-brand hover:text-brand"
                      >
                        + Add Variant
                      </button>
                    )}
                  </div>
                )}

                {/* Legacy: show add variant button if no option groups and no variants */}
                {!isMultiAxis && variants.length === 0 && optionGroups.every(g => !g.name.trim() || g.values.length === 0) && (
                  <button
                    type="button"
                    onClick={() => setVariants([{ ...EMPTY_VARIANT }])}
                    className="w-full rounded-lg border border-dashed border-gray-300 dark:border-gray-600 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:border-brand hover:text-brand"
                  >
                    + Add Variant Manually
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Right column: Toggles & Settings ── */}
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">Settings</p>

          {/* Refund Available */}
          <ToggleRow
            label="Refund Available"
            description={`${labels.personLabelPlural} can request a refund`}
            checked={form.refundable}
            onChange={(v) => setForm({ ...form, refundable: v })}
          />

          {/* Promo Code Eligible */}
          <ToggleRow
            label="Promo Codes Allowed"
            description="Promo/discount codes work on this product"
            checked={form.allow_promo}
            onChange={async (v) => {
              setForm({ ...form, allow_promo: v });
              if (v && !promoCodesLoaded) {
                const supabase = createClient();
                const { data } = await supabase
                  .from('promo_codes')
                  .select('code, discount_type, discount_value, is_active')
                  .eq('business_id', business.id)
                  .eq('is_active', true);
                setPromoCodes(data || []);
                setPromoCodesLoaded(true);
              }
            }}
          />
          {form.allow_promo && (
            <div className="ml-1 mt-1 mb-2">
              {!promoCodesLoaded ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">Loading promo codes...</p>
              ) : promoCodes.length > 0 ? (
                <div className="rounded-lg bg-green-50 px-3 py-2">
                  <p className="text-xs font-medium text-green-700 mb-1">Active promo codes:</p>
                  {promoCodes.map(p => (
                    <p key={p.code} className="text-xs text-green-600">
                      <span className="font-mono font-semibold">{p.code}</span> — {p.discount_type === 'percentage' ? `${p.discount_value}% off` : `₦${p.discount_value} off`}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg bg-amber-50 px-3 py-2">
                  <p className="text-xs text-amber-700">
                    No promo codes set up yet. <a href="/dashboard/promo-codes" className="font-semibold underline">Create one →</a>
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Track Inventory */}
          <ToggleRow
            label="Track Inventory"
            description="Alert when stock is low"
            checked={form.track_inventory}
            onChange={(v) => setForm({ ...form, track_inventory: v })}
          />

          {form.track_inventory && (
            <div className="rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3">
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Low Stock Alert At</label>
              <input
                type="number"
                min={1}
                value={form.low_stock_threshold || ''}
                onFocus={e => e.target.select()}
                onChange={(e) => setForm({ ...form, low_stock_threshold: Number(e.target.value) || 5 })}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
              />
            </div>
          )}

          {/* Active */}
          <ToggleRow
            label="Active"
            description={`Visible to ${labels.personLabelPlural.toLowerCase()} on WhatsApp`}
            checked={form.is_active}
            onChange={(v) => setForm({ ...form, is_active: v })}
          />

          {/* Min Order Quantity (per product) */}
          <div className="mt-2 rounded-lg border border-gray-100 bg-white p-3">
            <label className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Min Order Qty</label>
            <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">Minimum units a customer must buy</p>
            <input
              type="number"
              min={1}
              value={form.min_order_qty || ''}
              onFocus={e => e.target.select()}
              onChange={(e) => setForm({ ...form, min_order_qty: Number(e.target.value) || 1 })}
              placeholder="1"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
            />
          </div>
        </div>
      </div>

      {/* Save / Cancel */}
      <div className="mt-6 flex gap-3 border-t border-gray-100 dark:border-gray-700 pt-4">
        <button
          onClick={handleSave}
          disabled={saving || uploadingImage || !form.name.trim()}
          className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {saving || uploadingImage
            ? uploadingImage ? 'Uploading photo...' : 'Saving...'
            : view === 'add' ? 'Add Product' : 'Save Changes'}
        </button>
        <button
          onClick={() => setView('list')}
          className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        {view === 'edit' && form.id && (
          <button
            onClick={() => { handleDelete(form.id!); setView('list'); }}
            className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
          >
            Delete Product
          </button>
        )}
      </div>
    </div>
  );
}
