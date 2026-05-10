'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface OptionGroup {
  name: string;
  values: string[];
}

interface ProductVariant {
  id?: string;
  label: string;
  price: number;
  stock_quantity: number | null;
  sku: string;
  is_active: boolean;
  sort_order: number;
  image_url?: string | null;
  options?: Record<string, string>;
}

interface ProductAddon {
  id?: string;
  product_id: string | null;
  name: string;
  description: string | null;
  price: number;
  price_type: 'fixed' | 'per_unit' | 'quote';
  unit_label: string | null;
  min_quantity: number | null;
  max_quantity: number | null;
  is_required: boolean;
  is_negotiable: boolean;
  is_active: boolean;
  sort_order: number;
}

const EMPTY_ADDON: Omit<ProductAddon, 'sort_order'> = {
  product_id: null,
  name: '',
  description: null,
  price: 0,
  price_type: 'fixed',
  unit_label: null,
  min_quantity: null,
  max_quantity: null,
  is_required: false,
  is_negotiable: false,
  is_active: true,
};

interface VolumeDiscountRule {
  id?: string;
  product_id: string | null;
  name: string;
  min_quantity: number;
  max_quantity: number | null;
  discount_type: 'percentage' | 'fixed_per_unit' | 'fixed_total';
  discount_value: number;
  is_active: boolean;
  sort_order: number;
}

const EMPTY_DISCOUNT: Omit<VolumeDiscountRule, 'sort_order'> = {
  product_id: null,
  name: '',
  min_quantity: 10,
  max_quantity: null,
  discount_type: 'percentage',
  discount_value: 0,
  is_active: true,
};

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  category: string | null;
  stock_quantity: number | null;
  is_active: boolean;
  sort_order: number;
  track_inventory: boolean;
  low_stock_threshold: number;
  refundable: boolean;
  allow_promo: boolean;
  has_variants: boolean;
  shipping_cost: number | null;
  min_order_qty: number;
  variant_options?: OptionGroup[];
}

const EMPTY_PRODUCT: Omit<Product, 'id'> = {
  name: '',
  description: null,
  price: 0,
  image_url: null,
  category: null,
  stock_quantity: null,
  is_active: true,
  sort_order: 0,
  track_inventory: false,
  low_stock_threshold: 5,
  refundable: false,
  allow_promo: false,
  has_variants: false,
  shipping_cost: null,
  min_order_qty: 1,
  variant_options: [],
};

const EMPTY_VARIANT: ProductVariant = {
  label: '',
  price: 0,
  stock_quantity: null,
  sku: '',
  is_active: true,
  sort_order: 0,
  image_url: null,
  options: {},
};

type ViewMode = 'list' | 'add' | 'edit' | 'bulk';

// ── Helpers ──

function generateCombinations(groups: OptionGroup[]): Record<string, string>[] {
  const validGroups = groups.filter(g => g.name.trim() && g.values.length > 0);
  if (validGroups.length === 0) return [];
  return validGroups.reduce<Record<string, string>[]>(
    (combos, group) => {
      if (combos.length === 0) return group.values.map(v => ({ [group.name]: v }));
      const result: Record<string, string>[] = [];
      for (const combo of combos) {
        for (const value of group.values) {
          result.push({ ...combo, [group.name]: value });
        }
      }
      return result;
    }, []
  );
}

function optionsKey(options: Record<string, string>): string {
  return Object.entries(options).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join('|');
}

function labelFromOptions(options: Record<string, string>): string {
  return Object.values(options).join(' / ');
}

// ── CSV helpers ──
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

function mapCSVRow(row: Record<string, string>) {
  return {
    name: (row.name || row.product || row.item || '').trim(),
    price: parseFloat(row.price || row.amount || '0') || 0,
    description: (row.description || row.desc || '').trim() || undefined,
    category: (row.category || row.type || '').trim() || undefined,
    stock_quantity: (row.stock || row.quantity || row.qty) ? parseInt(row.stock || row.quantity || row.qty) : undefined,
  };
}

export default function ProductsPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;
  const curr = formatCurrency(0, country).charAt(0);

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
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

  const fetchProducts = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('products')
      .select('*')
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

  useEffect(() => { fetchProducts(); fetchAnalytics(); }, [fetchProducts, fetchAnalytics]);

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
      .select('*')
      .eq('product_id', product.id)
      .order('sort_order', { ascending: true });
    const productAddons = (addonData as ProductAddon[]) || [];
    setAddons(productAddons);
    setHasAddons(productAddons.length > 0);

    // Fetch product-specific volume discounts
    const { data: discountData } = await supabase
      .from('volume_discount_rules')
      .select('*')
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
      shipping_cost: form.shipping_cost,
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
  }

  // ── Delete / Toggle ──
  async function handleDelete(id: string) {
    if (!confirm('Delete this product?')) return;
    const supabase = createClient();
    await supabase.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    fetchProducts();
  }

  async function toggleActive(product: Product) {
    const supabase = createClient();
    await supabase.from('products').update({ is_active: !product.is_active }).eq('id', product.id);
    fetchProducts();
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
      if (json.imported > 0) { fetchProducts(); setBulkText(''); setBulkPreview([]); }
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
      <div>
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('list')}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {view === 'add' ? 'Add Product' : 'Edit Product'}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* ── Left column: Main details ── */}
          <div className="space-y-4">
            {/* Image */}
            <div
              onClick={() => imageInputRef.current?.click()}
              className="relative cursor-pointer overflow-hidden rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 transition hover:border-brand hover:bg-gray-100"
            >
              {imagePreview ? (
                <div className="relative h-48 w-full bg-gray-100">
                  <img src={imagePreview} alt="Product" className="h-full w-full object-contain" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition hover:bg-black/30">
                    <span className="rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-gray-700 opacity-0 transition hover:opacity-100">
                      Change Photo
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex h-36 flex-col items-center justify-center gap-2">
                  <svg className="h-8 w-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span className="text-sm text-gray-400">Tap to add product photo</span>
                  <span className="text-xs text-gray-300">JPEG, PNG, WebP — max 5MB</span>
                </div>
              )}
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={handleImageSelect}
                className="hidden"
              />
            </div>

            {/* Product Name */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Product Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Jollof Rice, Men's T-Shirt, Movie Ticket"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                autoFocus
              />
            </div>

            {/* Price + Stock — side by side (hidden when variants enabled) */}
            {!form.has_variants && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Price ({curr}) <span className="text-red-400">*</span>
                  </label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{curr}</span>
                    <input
                      type="number"
                      min={0}
                      value={form.price || ''}
                      onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
                      placeholder="0"
                      className="w-full rounded-lg border border-gray-200 py-2.5 pl-7 pr-3 text-sm outline-none focus:border-brand"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Stock Quantity</label>
                  <input
                    type="number"
                    min={0}
                    value={form.stock_quantity ?? ''}
                    onChange={(e) => setForm({ ...form, stock_quantity: e.target.value ? Number(e.target.value) : null })}
                    placeholder="Unlimited"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                  />
                  <p className="mt-0.5 text-xs text-gray-400">Leave empty = unlimited</p>
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
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={form.description || ''}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
                placeholder="Brief description of the product (optional)"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            </div>

            {/* Category */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Category</label>
              <input
                type="text"
                value={form.category || ''}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="e.g. Food, Drinks, Tickets, Accessories"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
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
              <label className="mb-1 block text-sm font-medium text-gray-700">Shipping Cost ({curr})</label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{curr}</span>
                <input
                  type="number"
                  min={0}
                  value={form.shipping_cost ?? ''}
                  onChange={(e) => setForm({ ...form, shipping_cost: e.target.value ? Number(e.target.value) : null })}
                  placeholder="0"
                  className="w-full rounded-lg border border-gray-200 py-2.5 pl-7 pr-3 text-sm outline-none focus:border-brand"
                />
              </div>
              <p className="mt-0.5 text-xs text-gray-400">Per-product shipping cost (optional)</p>
            </div>

            {/* Add-ons */}
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-800">Product Add-ons</p>
                  <p className="text-xs text-gray-400">E.g. extra servers, ice, gift wrapping, setup fee</p>
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
                    <div key={addon.id || idx} className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600">Add-on Name</label>
                          <input
                            type="text"
                            value={addon.name}
                            onChange={(e) => {
                              const updated = [...addons];
                              updated[idx] = { ...updated[idx], name: e.target.value };
                              setAddons(updated);
                            }}
                            placeholder="e.g. Extra Servers"
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="mb-0.5 block text-xs font-medium text-gray-600">Price ({curr})</label>
                            <input
                              type="number"
                              min={0}
                              value={addon.price || ''}
                              onChange={(e) => {
                                const updated = [...addons];
                                updated[idx] = { ...updated[idx], price: Number(e.target.value) || 0 };
                                setAddons(updated);
                              }}
                              placeholder="0"
                              disabled={addon.price_type === 'quote'}
                              className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand disabled:bg-gray-50 disabled:text-gray-400"
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-xs font-medium text-gray-600">Type</label>
                            <select
                              value={addon.price_type}
                              onChange={(e) => {
                                const updated = [...addons];
                                updated[idx] = { ...updated[idx], price_type: e.target.value as ProductAddon['price_type'] };
                                setAddons(updated);
                              }}
                              className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                            >
                              <option value="fixed">Fixed</option>
                              <option value="per_unit">Per Unit</option>
                              <option value="quote">Price Request</option>
                            </select>
                          </div>
                        </div>
                      </div>

                      {addon.price_type === 'per_unit' && (
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="mb-0.5 block text-xs font-medium text-gray-600">Unit Label</label>
                            <input
                              type="text"
                              value={addon.unit_label || ''}
                              onChange={(e) => {
                                const updated = [...addons];
                                updated[idx] = { ...updated[idx], unit_label: e.target.value || null };
                                setAddons(updated);
                              }}
                              placeholder="per person"
                              className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-xs font-medium text-gray-600">Min Qty</label>
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
                              className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-xs font-medium text-gray-600">Max Qty</label>
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
                              className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
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
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                      className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-sm font-medium text-gray-500 hover:border-brand hover:text-brand"
                    >
                      + Add Add-on
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Volume Discounts */}
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-800">Volume Discounts</p>
                  <p className="text-xs text-gray-400">Auto-apply discounts when customers order in bulk</p>
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
                    <div key={rule.id || idx} className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
                      {/* Preview */}
                      {rule.name && rule.discount_value > 0 && (
                        <div className="rounded bg-brand-50 px-2.5 py-1.5">
                          <p className="text-xs font-medium text-brand">
                            {rule.min_quantity}{rule.max_quantity ? `\u2013${rule.max_quantity}` : '+'} units {'\u2192'} {rule.discount_type === 'percentage' ? `${rule.discount_value}% off` : rule.discount_type === 'fixed_per_unit' ? `${curr}${rule.discount_value} off each` : `${curr}${rule.discount_value} off total`}
                          </p>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600">Rule Name</label>
                          <input
                            type="text"
                            value={rule.name}
                            onChange={(e) => {
                              const updated = [...volumeDiscounts];
                              updated[idx] = { ...updated[idx], name: e.target.value };
                              setVolumeDiscounts(updated);
                            }}
                            placeholder="e.g. Bulk Order Discount"
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="mb-0.5 block text-xs font-medium text-gray-600">Min Qty</label>
                            <input
                              type="number"
                              min={1}
                              value={rule.min_quantity}
                              onChange={(e) => {
                                const updated = [...volumeDiscounts];
                                updated[idx] = { ...updated[idx], min_quantity: Number(e.target.value) || 1 };
                                setVolumeDiscounts(updated);
                              }}
                              className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-xs font-medium text-gray-600">Max Qty</label>
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
                              className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600">Discount Type</label>
                          <select
                            value={rule.discount_type}
                            onChange={(e) => {
                              const updated = [...volumeDiscounts];
                              updated[idx] = { ...updated[idx], discount_type: e.target.value as VolumeDiscountRule['discount_type'] };
                              setVolumeDiscounts(updated);
                            }}
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                          >
                            <option value="percentage">Percentage (%)</option>
                            <option value="fixed_per_unit">Fixed per unit ({curr})</option>
                            <option value="fixed_total">Fixed total ({curr})</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-0.5 block text-xs font-medium text-gray-600">
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
                            placeholder="0"
                            className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
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
                          <span className="text-xs text-gray-500">{rule.is_active ? 'Active' : 'Inactive'}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (rule.id) setDeletedDiscountIds(prev => [...prev, rule.id!]);
                            setVolumeDiscounts(volumeDiscounts.filter((_, i) => i !== idx));
                          }}
                          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                      className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-sm font-medium text-gray-500 hover:border-brand hover:text-brand"
                    >
                      + Add Discount Rule
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Variants */}
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-800">Product Variants</p>
                  <p className="text-xs text-gray-400">E.g. different sizes, lengths, colors with different prices</p>
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
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Option Groups</p>
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
                              className="w-full rounded border border-gray-100 px-2 py-1.5 text-sm font-medium outline-none focus:border-brand"
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
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                        className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-sm font-medium text-gray-500 hover:border-brand hover:text-brand"
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
                        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                          Variants ({variants.length})
                        </p>
                        {/* Bulk price setter */}
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Set all prices:</span>
                          <div className="relative w-24">
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">{curr}</span>
                            <input
                              type="number"
                              min={0}
                              value={bulkPrice}
                              onChange={(e) => setBulkPrice(e.target.value)}
                              placeholder="0"
                              className="w-full rounded border border-gray-200 py-1.5 pl-5 pr-1 text-sm outline-none focus:border-brand"
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
                                className="min-w-0 flex-1 rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                              />
                            )}
                            <div className="relative w-24 shrink-0">
                              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">{curr}</span>
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
                                className="w-full rounded border border-gray-100 py-1.5 pl-6 pr-1 text-sm outline-none focus:border-brand"
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
                              className="w-16 shrink-0 rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
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
                              className="w-20 shrink-0 rounded border border-gray-100 px-2 py-1.5 text-sm outline-none focus:border-brand"
                            />
                            {/* Variant image */}
                            <button
                              type="button"
                              onClick={() => variantImageRefs.current[idx]?.click()}
                              className="relative h-8 w-8 shrink-0 overflow-hidden rounded border border-gray-200 bg-gray-50 hover:border-brand"
                              title="Upload variant image"
                            >
                              {v.image_url ? (
                                <img src={v.image_url} alt="" className="h-full w-full object-cover" />
                              ) : (
                                <svg className="mx-auto mt-1 h-5 w-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                              )}
                              <input
                                ref={(el) => { variantImageRefs.current[idx] = el; }}
                                type="file"
                                accept="image/jpeg,image/png,image/webp,image/gif"
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
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                          className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-sm font-medium text-gray-500 hover:border-brand hover:text-brand"
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
                      className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-sm font-medium text-gray-500 hover:border-brand hover:text-brand"
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
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>

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
              onChange={(v) => setForm({ ...form, allow_promo: v })}
            />

            {/* Track Inventory */}
            <ToggleRow
              label="Track Inventory"
              description="Alert when stock is low"
              checked={form.track_inventory}
              onChange={(v) => setForm({ ...form, track_inventory: v })}
            />

            {form.track_inventory && (
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <label className="mb-1 block text-xs font-medium text-gray-600">Low Stock Alert At</label>
                <input
                  type="number"
                  min={1}
                  value={form.low_stock_threshold}
                  onChange={(e) => setForm({ ...form, low_stock_threshold: Number(e.target.value) || 5 })}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand"
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
              <label className="mb-1 block text-sm font-medium text-gray-800">Min Order Qty</label>
              <p className="mb-2 text-xs text-gray-400">Minimum units a customer must buy</p>
              <input
                type="number"
                min={1}
                value={form.min_order_qty || 1}
                onChange={(e) => setForm({ ...form, min_order_qty: Number(e.target.value) || 1 })}
                placeholder="1"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>
        </div>

        {/* Save / Cancel */}
        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
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
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          {view === 'edit' && form.id && (
            <button
              onClick={() => { handleDelete(form.id!); setView('list'); }}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
            >
              Delete Product
            </button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // BULK UPLOAD VIEW
  // ═══════════════════════════════════════════
  if (view === 'bulk') {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">Bulk Upload Products</h1>
        </div>

        <div className="mt-5 space-y-4">
          {/* Drop zone */}
          <div className="rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-6">
            <div className="text-center">
              <svg className="mx-auto h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="mt-2 text-sm font-medium text-gray-700">Upload a CSV file or paste products below</p>
              <p className="mt-1 text-xs text-gray-400">
                Columns: <strong>name</strong> (required), <strong>price</strong>, description, category, stock
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Choose CSV File
              </button>
              <input ref={fileInputRef} type="file" accept=".csv,.txt" onChange={handleFileSelect} className="hidden" />
            </div>
          </div>

          {/* Paste area */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Or paste your products</label>
            <textarea
              value={bulkText}
              onChange={(e) => handleBulkTextChange(e.target.value)}
              rows={6}
              placeholder={`name, price, category\nJollof Rice, 2500, Food\nChapman Drink, 1500, Drinks\nMen's T-Shirt, 5000, Clothing`}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm outline-none focus:border-brand"
            />
          </div>

          {/* Preview */}
          {bulkPreview.length > 0 && (
            <div className="rounded-xl border border-gray-100 bg-white">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <p className="text-sm font-semibold text-gray-900">
                  Preview: {bulkPreview.length} product{bulkPreview.length !== 1 ? 's' : ''}
                </p>
                <button
                  onClick={handleBulkImport}
                  disabled={bulkImporting}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {bulkImporting ? 'Importing...' : `Import ${bulkPreview.length} Products`}
                </button>
              </div>
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2">#</th>
                      <th className="px-4 py-2">Name</th>
                      <th className="px-4 py-2">Price</th>
                      <th className="px-4 py-2">Category</th>
                      <th className="px-4 py-2">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkPreview.map((p, i) => (
                      <tr key={i} className="border-t border-gray-50">
                        <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                        <td className="px-4 py-2 font-medium text-gray-900">{p.name}</td>
                        <td className="px-4 py-2 text-gray-600">{curr}{p.price.toLocaleString()}</td>
                        <td className="px-4 py-2 text-gray-500">{p.category || '\u2014'}</td>
                        <td className="px-4 py-2 text-gray-500">{p.stock_quantity ?? '\u2014'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Result */}
          {bulkResult && (
            <div className={`rounded-lg p-4 text-sm ${bulkResult.imported > 0 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
              {bulkResult.imported > 0 && <p className="font-medium">{bulkResult.imported} product{bulkResult.imported !== 1 ? 's' : ''} imported!</p>}
              {bulkResult.skipped > 0 && <p>{bulkResult.skipped} skipped</p>}
              {bulkResult.errors?.map((e, i) => <p key={i} className="mt-1 text-xs">Row {e.row}: {e.reason}</p>)}
            </div>
          )}

          <div className="rounded-lg bg-blue-50 p-3">
            <p className="text-xs text-blue-700">
              <strong>Tip:</strong> Create a spreadsheet with columns: name, price, description, category, stock.
              Export as CSV and upload, or just paste directly!
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // PRODUCT LIST
  // ═══════════════════════════════════════════
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
      {orderStats && products.length > 0 && (() => {
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
      })()}

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
                <div className="h-44 w-full bg-gray-50 p-2">
                  <img src={product.image_url} alt={product.name} className="h-full w-full object-contain" />
                </div>
              ) : (
                <div className="flex h-20 w-full items-center justify-center bg-gray-50">
                  <svg className="h-6 w-6 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleActive(product); }}
                    className={`relative h-6 w-11 rounded-full transition ${product.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: product.is_active ? '22px' : '2px' }} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(product.id); }}
                    className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Option value tag input ──
function OptionValueInput({ values, onChange, maxValues }: {
  values: string[];
  onChange: (values: string[]) => void;
  maxValues: number;
}) {
  const [inputValue, setInputValue] = useState('');

  function addValue() {
    const val = inputValue.trim();
    if (!val || values.includes(val) || values.length >= maxValues) return;
    onChange([...values, val]);
    setInputValue('');
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {values.map((val, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
          {val}
          <button
            type="button"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="ml-0.5 text-brand-400 hover:text-brand-700"
          >
            &times;
          </button>
        </span>
      ))}
      {values.length < maxValues && (
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addValue(); }
            if (e.key === ',' ) { e.preventDefault(); addValue(); }
          }}
          onBlur={addValue}
          placeholder={values.length === 0 ? 'Type a value and press Enter' : 'Add more...'}
          className="min-w-[120px] flex-1 rounded border-none bg-transparent px-1 py-0.5 text-xs outline-none"
        />
      )}
    </div>
  );
}

// ── Reusable toggle row ──
function ToggleRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
      <div className="mr-3">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-400">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-brand' : 'bg-gray-200'}`}
      >
        <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: checked ? '22px' : '2px' }} />
      </button>
    </div>
  );
}
