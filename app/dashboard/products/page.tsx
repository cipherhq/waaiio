'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import type {
  Product,
  ProductVariant,
  ProductAddon,
  VolumeDiscountRule,
  OptionGroup,
  CatalogSyncLog,
  ViewMode,
} from './components/types';
import {
  EMPTY_PRODUCT,
  EMPTY_VARIANT,
  generateCombinations,
  optionsKey,
  labelFromOptions,
  parseCSV,
  mapCSVRow,
} from './components/types';
import ProductForm from './components/ProductForm';
import ProductList from './components/ProductList';
import BulkUpload from './components/BulkUpload';

export default function ProductsPage() {
  const business = useBusiness();
  const { capabilities } = useCapabilities();
  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;
  const curr = formatCurrency(0, country).charAt(0);

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<ViewMode>('list');
  const [scrollToProductId, setScrollToProductId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');

  // Sales analytics
  const [orderStats, setOrderStats] = useState<{
    totalOrders: number;
    totalRevenue: number;
    avgOrderValue: number;
    bestSellers: { name: string; qty: number; pct: number; revenue: number }[];
  } | null>(null);

  // Form state (shared for add + edit)
  const [form, setForm] = useState<Omit<Product, 'id'> & { id?: string }>(EMPTY_PRODUCT);
  const [saving, setSaving] = useState(false);
  const [promoCodes, setPromoCodes] = useState<Array<{ code: string; discount_type: string; discount_value: number; is_active: boolean }>>([]);
  const [promoCodesLoaded, setPromoCodesLoaded] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Variants
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [deletedVariantIds, setDeletedVariantIds] = useState<string[]>([]);
  const [optionGroups, setOptionGroups] = useState<OptionGroup[]>([]);
  const [bulkPrice, setBulkPrice] = useState<string>('');
  const [variantImageFiles, setVariantImageFiles] = useState<Record<number, File>>({});
  const variantImageRefs = useRef<Record<number, HTMLInputElement | null>>({});

  // Add-ons
  const [addons, setAddons] = useState<ProductAddon[]>([]);
  const [deletedAddonIds, setDeletedAddonIds] = useState<string[]>([]);
  const [hasAddons, setHasAddons] = useState(false);

  // Volume Discounts
  const [volumeDiscounts, setVolumeDiscounts] = useState<VolumeDiscountRule[]>([]);
  const [deletedDiscountIds, setDeletedDiscountIds] = useState<string[]>([]);
  const [hasVolumeDiscounts, setHasVolumeDiscounts] = useState(false);

  // Bulk
  const [bulkText, setBulkText] = useState('');
  const [bulkPreview, setBulkPreview] = useState<ReturnType<typeof mapCSVRow>[]>([]);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ imported: number; skipped: number; errors?: { row: number; reason: string }[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // WhatsApp Catalog Sync
  const [hasWhatsAppChannel, setHasWhatsAppChannel] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [syncLogs, setSyncLogs] = useState<CatalogSyncLog[]>([]);
  const [showSyncHistory, setShowSyncHistory] = useState(false);

  const fetchProducts = useCallback(async () => {
    try {
      setError(false);
      const supabase = createClient();
      const { data } = await supabase
        .from('products')
        .select('id, name, description, price, image_url, category, stock_quantity, is_active, sort_order, track_inventory, low_stock_threshold, refundable, allow_promo, has_variants, shipping_cost, min_order_qty, variant_options, catalog_synced_at')
        .eq('business_id', business.id)
        .is('deleted_at', null)
        .order('sort_order', { ascending: true });

      const productList = (data as Product[]) || [];

      // Fetch variant price ranges for products with variants
      const variantProductIds = productList.filter(p => p.has_variants).map(p => p.id);
      if (variantProductIds.length > 0) {
        const { data: variantData } = await supabase
          .from('product_variants')
          .select('product_id, price')
          .in('product_id', variantProductIds)
          .eq('is_active', true);

        if (variantData) {
          const priceMap: Record<string, { min: number; max: number; count: number }> = {};
          for (const v of variantData) {
            if (!priceMap[v.product_id]) {
              priceMap[v.product_id] = { min: v.price, max: v.price, count: 1 };
            } else {
              priceMap[v.product_id].min = Math.min(priceMap[v.product_id].min, v.price);
              priceMap[v.product_id].max = Math.max(priceMap[v.product_id].max, v.price);
              priceMap[v.product_id].count++;
            }
          }
          for (const p of productList) {
            if (priceMap[p.id]) {
              const ext = p as Product & { _price_min?: number; _price_max?: number; _variant_count?: number };
              ext._price_min = priceMap[p.id].min;
              ext._price_max = priceMap[p.id].max;
              ext._variant_count = priceMap[p.id].count;
            }
          }
        }
      }

      setProducts(productList);
    } catch {
      setError(true);
    }
    setLoading(false);
  }, [business.id]);

  const fetchAnalytics = useCallback(async () => {
    const supabase = createClient();
    const validStatuses = ['confirmed', 'processing', 'shipped', 'ready', 'delivered'];
    const { data: orders } = await supabase
      .from('orders')
      .select('id, total_amount')
      .eq('business_id', business.id)
      .in('status', validStatuses);

    if (!orders || orders.length === 0) { setOrderStats(null); return; }

    const orderIds = orders.map(o => o.id);
    const { data: items } = await supabase
      .from('order_items')
      .select('product_id, quantity, unit_price')
      .in('order_id', orderIds);

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((s, o) => s + (o.total_amount || 0), 0);
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    // Aggregate by product
    const productMap: Record<string, { qty: number; revenue: number }> = {};
    for (const item of items || []) {
      const pid = item.product_id;
      if (!productMap[pid]) productMap[pid] = { qty: 0, revenue: 0 };
      productMap[pid].qty += item.quantity;
      productMap[pid].revenue += item.unit_price * item.quantity;
    }

    const totalQty = Object.values(productMap).reduce((s, v) => s + v.qty, 0);
    const sorted = Object.entries(productMap)
      .sort(([, a], [, b]) => b.qty - a.qty)
      .slice(0, 5);

    setOrderStats({
      totalOrders,
      totalRevenue,
      avgOrderValue,
      bestSellers: sorted.map(([pid, v]) => ({
        name: pid, // placeholder — resolved in render using products array
        qty: v.qty,
        pct: totalQty > 0 ? Math.round((v.qty / totalQty) * 100) : 0,
        revenue: v.revenue,
      })),
    });
  }, [business.id]);

  // Check if business has a Meta Cloud WhatsApp channel
  const checkWhatsAppChannel = useCallback(async () => {
    const supabase = createClient();
    const { count } = await supabase
      .from('whatsapp_channels')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', business.id)
      .eq('provider', 'meta_cloud')
      .eq('is_active', true);
    setHasWhatsAppChannel((count || 0) > 0);
  }, [business.id]);

  // Fetch catalog sync logs
  const fetchSyncLogs = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('catalog_sync_logs')
      .select('id, catalog_id, synced_count, failed_count, error_message, status, created_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false })
      .limit(5);
    setSyncLogs((data as CatalogSyncLog[]) || []);
  }, [business.id]);

  // Handle catalog sync
  async function handleCatalogSync() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch('/api/catalog/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncMessage({ type: 'error', text: data.error || 'Sync failed' });
      } else {
        setSyncMessage({
          type: 'success',
          text: `Synced ${data.synced} product${data.synced !== 1 ? 's' : ''} to WhatsApp catalog${data.failed > 0 ? ` (${data.failed} failed)` : ''}`,
        });
        // Refresh products and sync logs to show updated sync status
        fetchProducts();
        fetchSyncLogs();
      }
    } catch {
      setSyncMessage({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setSyncing(false);
    }
  }

  // Auto-sync to WhatsApp catalog after product mutations (silent, non-blocking)
  async function triggerAutoSync() {
    if (!hasWhatsAppChannel || !business.whatsapp_catalog_id) return;
    try {
      await fetch('/api/catalog/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id }),
      });
    } catch { /* silent — auto-sync failure shouldn't block the UI */ }
  }

  useEffect(() => { fetchProducts(); fetchAnalytics(); checkWhatsAppChannel(); fetchSyncLogs(); }, [fetchProducts, fetchAnalytics, checkWhatsAppChannel, fetchSyncLogs]);

  // Scroll to edited product after save
  useEffect(() => {
    if (scrollToProductId && products.length > 0 && view === 'list') {
      const el = document.querySelector(`[data-product-id="${scrollToProductId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setScrollToProductId(null);
    }
  }, [scrollToProductId, products, view]);

  // Get unique categories for suggestions
  const categories = Array.from(new Set(products.map(p => p.category).filter(Boolean)));

  // Check if we're using multi-axis (option groups defined with >= 1 group)
  const isMultiAxis = optionGroups.length > 0 && optionGroups.some(g => g.name.trim() && g.values.length > 0);

  // ── Open add/edit form ──
  function openAdd() {
    setForm({ ...EMPTY_PRODUCT, sort_order: products.length });
    setImageFile(null);
    setImagePreview(null);
    setVariants([]);
    setDeletedVariantIds([]);
    setOptionGroups([]);
    setBulkPrice('');
    setVariantImageFiles({});
    setAddons([]);
    setDeletedAddonIds([]);
    setHasAddons(false);
    setVolumeDiscounts([]);
    setDeletedDiscountIds([]);
    setHasVolumeDiscounts(false);
    setView('add');
  }

  async function openEdit(product: Product) {
    setForm({ ...product });
    setImageFile(null);
    setImagePreview(product.image_url);
    setDeletedVariantIds([]);
    setBulkPrice('');
    setVariantImageFiles({});
    setDeletedAddonIds([]);
    setDeletedDiscountIds([]);

    // Restore option groups from product
    const groups = (product.variant_options as OptionGroup[]) || [];
    setOptionGroups(groups);

    const supabase = createClient();

    // Fetch variants if product has them
    if (product.has_variants) {
      const { data } = await supabase
        .from('product_variants')
        .select('id, label, price, stock_quantity, sku, is_active, sort_order, image_url, options')
        .eq('product_id', product.id)
        .order('sort_order', { ascending: true });
      setVariants((data as ProductVariant[]) || []);
    } else {
      setVariants([]);
    }

    // Fetch product-specific addons
    const { data: addonData } = await supabase
      .from('product_addons')
      .select('id, product_id, name, description, price, price_type, unit_label, min_quantity, max_quantity, is_required, is_negotiable, is_active, sort_order')
      .eq('product_id', product.id)
      .order('sort_order', { ascending: true });
    const productAddons = (addonData as ProductAddon[]) || [];
    setAddons(productAddons);
    setHasAddons(productAddons.length > 0);

    // Fetch product-specific volume discounts
    const { data: discountData } = await supabase
      .from('volume_discount_rules')
      .select('id, product_id, name, min_quantity, max_quantity, discount_type, discount_value, is_active, sort_order')
      .eq('product_id', product.id)
      .order('sort_order', { ascending: true });
    const productDiscounts = (discountData as VolumeDiscountRule[]) || [];
    setVolumeDiscounts(productDiscounts);
    setHasVolumeDiscounts(productDiscounts.length > 0);

    setView('edit');
  }

  // ── Image handling ──
  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function uploadImageFile(file: File): Promise<string | null> {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('business_id', business.id);
      const res = await fetch('/api/products/upload-image', { method: 'POST', body: formData });
      const json = await res.json();
      return json.url || null;
    } catch {
      return null;
    }
  }

  async function uploadImage(): Promise<string | null> {
    if (!imageFile) return form.image_url || null;
    setUploadingImage(true);
    const url = await uploadImageFile(imageFile);
    setUploadingImage(false);
    return url || form.image_url || null;
  }

  // ── Variant image handling ──
  function handleVariantImageSelect(idx: number, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setVariantImageFiles(prev => ({ ...prev, [idx]: file }));
    // Set preview immediately
    const reader = new FileReader();
    reader.onload = (ev) => {
      const updated = [...variants];
      updated[idx] = { ...updated[idx], image_url: ev.target?.result as string };
      setVariants(updated);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  // ── Generate variants from option groups ──
  function handleGenerateVariants() {
    const combos = generateCombinations(optionGroups);
    if (combos.length === 0) return;

    // Build a lookup of existing variants by their options key
    const existingMap = new Map<string, ProductVariant>();
    for (const v of variants) {
      if (v.options && Object.keys(v.options).length > 0) {
        existingMap.set(optionsKey(v.options), v);
      }
    }

    const newVariants: ProductVariant[] = combos.map((combo, idx) => {
      const key = optionsKey(combo);
      const existing = existingMap.get(key);
      if (existing) {
        return { ...existing, sort_order: idx, label: labelFromOptions(combo), options: combo };
      }
      return {
        ...EMPTY_VARIANT,
        label: labelFromOptions(combo),
        options: combo,
        sort_order: idx,
        price: bulkPrice ? Number(bulkPrice) : 0,
      };
    });

    // Mark removed variants for deletion
    const newKeys = new Set(combos.map(c => optionsKey(c)));
    for (const v of variants) {
      if (v.id && v.options && Object.keys(v.options).length > 0 && !newKeys.has(optionsKey(v.options))) {
        setDeletedVariantIds(prev => [...prev, v.id!]);
      }
    }

    setVariants(newVariants);
  }

  // ── Apply bulk price ──
  function applyBulkPrice() {
    const price = Number(bulkPrice);
    if (!price || price <= 0) return;
    setVariants(variants.map(v => ({ ...v, price })));
  }

  // ── Save (create or update) ──
  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);

    const imageUrl = await uploadImage();

    const payload: Record<string, unknown> = {
      business_id: business.id,
      name: form.name.trim(),
      description: form.description?.trim() || null,
      price: form.has_variants ? 0 : (form.price || 0),
      image_url: imageUrl,
      category: form.category?.trim() || null,
      stock_quantity: form.has_variants ? null : form.stock_quantity,
      is_active: form.is_active,
      sort_order: form.sort_order,
      track_inventory: form.track_inventory,
      low_stock_threshold: form.low_stock_threshold,
      refundable: form.refundable,
      allow_promo: form.allow_promo,
      has_variants: form.has_variants,
      shipping_cost: form.shipping_cost || null,
      min_order_qty: form.min_order_qty || 1,
    };

    // Only include variant_options if the column exists (migration 032)
    if (isMultiAxis) {
      payload.variant_options = optionGroups.filter(g => g.name.trim() && g.values.length > 0);
    }

    const supabase = createClient();
    let productId = form.id;

    if (view === 'add') {
      const { data, error } = await supabase.from('products').insert(payload).select('id').single();
      if (error) {
        // Retry without variant_options in case migration not applied
        if (error.message?.includes('variant_options')) {
          delete payload.variant_options;
          const { data: retryData } = await supabase.from('products').insert(payload).select('id').single();
          productId = retryData?.id;
        } else {
          console.error('Product save error:', error);
          setSaving(false);
          return;
        }
      } else {
        productId = data?.id;
      }
    } else {
      const { error } = await supabase.from('products').update(payload).eq('id', form.id);
      if (error?.message?.includes('variant_options')) {
        delete payload.variant_options;
        await supabase.from('products').update(payload).eq('id', form.id);
      }
    }

    // Upsert variants
    if (productId && form.has_variants) {
      // Delete removed variants
      if (deletedVariantIds.length > 0) {
        await supabase.from('product_variants').delete().in('id', deletedVariantIds);
      }

      // Upload variant images in parallel
      const imageUploads = Object.entries(variantImageFiles).map(async ([idxStr, file]) => {
        const idx = Number(idxStr);
        const url = await uploadImageFile(file);
        return { idx, url };
      });
      const uploadResults = await Promise.all(imageUploads);
      const uploadedUrls: Record<number, string | null> = {};
      for (const r of uploadResults) {
        uploadedUrls[r.idx] = r.url;
      }

      // Upsert each variant
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        // Determine image_url: newly uploaded > existing (non-data-uri) > null
        let variantImageUrl = v.image_url;
        if (uploadedUrls[i] !== undefined) {
          variantImageUrl = uploadedUrls[i];
        } else if (variantImageUrl && variantImageUrl.startsWith('data:')) {
          variantImageUrl = null; // data URI preview without upload — shouldn't happen but safety
        }

        const variantPayload: Record<string, unknown> = {
          product_id: productId,
          label: v.label.trim() || labelFromOptions(v.options || {}),
          price: v.price || 0,
          stock_quantity: v.stock_quantity,
          sku: v.sku?.trim() || null,
          is_active: v.is_active,
          sort_order: i,
        };

        // Only include new columns if they have values (graceful if migration not applied)
        if (variantImageUrl) variantPayload.image_url = variantImageUrl;
        if (v.options && Object.keys(v.options).length > 0) variantPayload.options = v.options;

        if (v.id) {
          const { error } = await supabase.from('product_variants').update(variantPayload).eq('id', v.id);
          if (error?.message?.includes('image_url') || error?.message?.includes('options')) {
            delete variantPayload.image_url;
            delete variantPayload.options;
            await supabase.from('product_variants').update(variantPayload).eq('id', v.id);
          }
        } else {
          const { error } = await supabase.from('product_variants').insert(variantPayload);
          if (error?.message?.includes('image_url') || error?.message?.includes('options')) {
            delete variantPayload.image_url;
            delete variantPayload.options;
            await supabase.from('product_variants').insert(variantPayload);
          }
        }
      }
    }

    // If variants were disabled, clean up any existing variants
    if (productId && !form.has_variants && view === 'edit') {
      await supabase.from('product_variants').delete().eq('product_id', productId);
    }

    // Save addons
    if (productId && hasAddons) {
      // Delete removed addons
      if (deletedAddonIds.length > 0) {
        await supabase.from('product_addons').delete().in('id', deletedAddonIds);
      }

      for (let i = 0; i < addons.length; i++) {
        const addon = addons[i];
        if (!addon.name.trim()) continue;
        const addonPayload = {
          business_id: business.id,
          product_id: productId,
          name: addon.name.trim(),
          description: addon.description?.trim() || null,
          price: addon.price_type === 'quote' ? 0 : (addon.price || 0),
          price_type: addon.price_type,
          unit_label: addon.unit_label || null,
          min_quantity: addon.min_quantity || null,
          max_quantity: addon.max_quantity || null,
          is_required: addon.is_required,
          is_negotiable: addon.is_negotiable,
          is_active: addon.is_active,
          sort_order: i,
        };
        if (addon.id) {
          await supabase.from('product_addons').update(addonPayload).eq('id', addon.id);
        } else {
          await supabase.from('product_addons').insert(addonPayload);
        }
      }
    }

    // If addons were disabled, clean up existing product-specific addons
    if (productId && !hasAddons && view === 'edit') {
      await supabase.from('product_addons').delete().eq('product_id', productId);
    }

    // Save volume discounts
    if (productId && hasVolumeDiscounts) {
      // Delete removed discounts
      if (deletedDiscountIds.length > 0) {
        await supabase.from('volume_discount_rules').delete().in('id', deletedDiscountIds);
      }

      for (let i = 0; i < volumeDiscounts.length; i++) {
        const rule = volumeDiscounts[i];
        if (!rule.name.trim()) continue;
        const discountPayload = {
          business_id: business.id,
          product_id: productId,
          name: rule.name.trim(),
          min_quantity: rule.min_quantity,
          max_quantity: rule.max_quantity || null,
          discount_type: rule.discount_type,
          discount_value: rule.discount_value,
          is_active: rule.is_active,
          sort_order: i,
        };
        if (rule.id) {
          await supabase.from('volume_discount_rules').update(discountPayload).eq('id', rule.id);
        } else {
          await supabase.from('volume_discount_rules').insert(discountPayload);
        }
      }
    }

    // If volume discounts were disabled, clean up existing product-specific discounts
    if (productId && !hasVolumeDiscounts && view === 'edit') {
      await supabase.from('volume_discount_rules').delete().eq('product_id', productId);
    }

    setSaving(false);
    setScrollToProductId(form.id || null);
    setView('list');
    fetchProducts();
    triggerAutoSync(); // Background sync to WhatsApp catalog
  }

  // ── Delete / Toggle ──
  async function handleDelete(id: string) {
    if (!confirm('Delete this product?')) return;
    const supabase = createClient();
    await supabase.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    fetchProducts();
    triggerAutoSync(); // Background sync to WhatsApp catalog
  }

  async function toggleActive(product: Product) {
    const supabase = createClient();
    await supabase.from('products').update({ is_active: !product.is_active }).eq('id', product.id);
    fetchProducts();
    triggerAutoSync(); // Background sync to WhatsApp catalog
  }

  // ── Bulk ──
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setBulkText(text);
      setBulkPreview(parseCSV(text).map(mapCSVRow).filter(r => r.name));
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleBulkTextChange(text: string) {
    setBulkText(text);
    setBulkResult(null);
    setBulkPreview(text.trim().split('\n').length >= 2 ? parseCSV(text).map(mapCSVRow).filter(r => r.name) : []);
  }

  async function handleBulkImport() {
    if (bulkPreview.length === 0) return;
    setBulkImporting(true);
    try {
      const res = await fetch('/api/products/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, products: bulkPreview }),
      });
      const json = await res.json();
      setBulkResult(json);
      if (json.imported > 0) { fetchProducts(); setBulkPreview([]); setBulkText(''); triggerAutoSync(); }
    } catch {
      setBulkResult({ imported: 0, skipped: bulkPreview.length, errors: [{ row: 0, reason: 'Network error' }] });
    }
    setBulkImporting(false);
  }

  // ── Filtered ──
  const filtered = products.filter(p => {
    if (filter === 'active') return p.is_active;
    if (filter === 'inactive') return !p.is_active;
    return true;
  });

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // ADD / EDIT — Single screen, all fields
  // ═══════════════════════════════════════════
  if (view === 'add' || view === 'edit') {
    return (
      <ProductForm
        view={view}
        form={form}
        setForm={setForm}
        saving={saving}
        uploadingImage={uploadingImage}
        imagePreview={imagePreview}
        imageInputRef={imageInputRef}
        handleImageSelect={handleImageSelect}
        handleSave={handleSave}
        handleDelete={handleDelete}
        setView={setView}
        curr={curr}
        labels={labels}
        business={business}
        country={country}
        categories={categories}
        variants={variants}
        setVariants={setVariants}
        deletedVariantIds={deletedVariantIds}
        setDeletedVariantIds={setDeletedVariantIds}
        optionGroups={optionGroups}
        setOptionGroups={setOptionGroups}
        bulkPrice={bulkPrice}
        setBulkPrice={setBulkPrice}
        variantImageFiles={variantImageFiles}
        setVariantImageFiles={setVariantImageFiles}
        variantImageRefs={variantImageRefs}
        isMultiAxis={isMultiAxis}
        handleGenerateVariants={handleGenerateVariants}
        applyBulkPrice={applyBulkPrice}
        handleVariantImageSelect={handleVariantImageSelect}
        addons={addons}
        setAddons={setAddons}
        deletedAddonIds={deletedAddonIds}
        setDeletedAddonIds={setDeletedAddonIds}
        hasAddons={hasAddons}
        setHasAddons={setHasAddons}
        volumeDiscounts={volumeDiscounts}
        setVolumeDiscounts={setVolumeDiscounts}
        deletedDiscountIds={deletedDiscountIds}
        setDeletedDiscountIds={setDeletedDiscountIds}
        hasVolumeDiscounts={hasVolumeDiscounts}
        setHasVolumeDiscounts={setHasVolumeDiscounts}
        promoCodes={promoCodes}
        setPromoCodes={setPromoCodes}
        promoCodesLoaded={promoCodesLoaded}
        setPromoCodesLoaded={setPromoCodesLoaded}
      />
    );
  }

  // ═══════════════════════════════════════════
  // BULK UPLOAD VIEW
  // ═══════════════════════════════════════════
  if (view === 'bulk') {
    return (
      <BulkUpload
        setView={setView}
        curr={curr}
        bulkText={bulkText}
        setBulkText={setBulkText}
        bulkPreview={bulkPreview}
        setBulkPreview={setBulkPreview}
        bulkImporting={bulkImporting}
        bulkResult={bulkResult}
        setBulkResult={setBulkResult}
        handleFileSelect={handleFileSelect}
        handleBulkTextChange={handleBulkTextChange}
        handleBulkImport={handleBulkImport}
        fileInputRef={fileInputRef}
      />
    );
  }

  // ═══════════════════════════════════════════
  // PRODUCT LIST
  // ═══════════════════════════════════════════
  return (
    <>
    {error && (
      <div className="mb-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
        Something went wrong loading data. <button onClick={() => { setError(false); fetchProducts(); }} className="font-medium underline hover:no-underline">Try again</button>
      </div>
    )}
    <ProductList
      products={products}
      filtered={filtered}
      filter={filter}
      setFilter={setFilter}
      setView={setView}
      openAdd={openAdd}
      openEdit={openEdit}
      handleDelete={handleDelete}
      toggleActive={toggleActive}
      country={country}
      curr={curr}
      labels={labels}
      capabilities={capabilities}
      business={business}
      hasWhatsAppChannel={hasWhatsAppChannel}
      syncing={syncing}
      syncMessage={syncMessage}
      setSyncMessage={setSyncMessage}
      handleCatalogSync={handleCatalogSync}
      syncLogs={syncLogs}
      showSyncHistory={showSyncHistory}
      setShowSyncHistory={setShowSyncHistory}
      orderStats={orderStats}
    />
    </>
  );
}
