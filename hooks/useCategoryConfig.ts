'use client';

import { useEffect, useState } from 'react';
import {
  loadCategories,
  getCategoryLabels,
  getCategoryByKey,
  getCategoryList,
  getAllCategoryKeys,
  getCategoryFlowType,
  getCategoryDefaultCapabilities,
  type CategoryLabels,
  type CategoryTemplate,
} from '@/lib/categoryConfig';

/**
 * React hook that ensures category_templates are loaded from DB.
 * Returns sync helper functions that read from the in-memory cache.
 *
 * Usage:
 *   const { labels, categoryList, isLoaded } = useCategoryConfig(business.category);
 */
export function useCategoryConfig(categoryKey?: string) {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    loadCategories().then(() => setIsLoaded(true));
  }, []);

  const labels: CategoryLabels = getCategoryLabels(categoryKey || 'other');
  const category: CategoryTemplate | null = categoryKey ? getCategoryByKey(categoryKey) : null;

  return {
    isLoaded,
    labels,
    category,
    getCategoryLabels,
    getCategoryByKey,
    getCategoryList,
    getAllCategoryKeys,
    getCategoryFlowType,
    getCategoryDefaultCapabilities,
  };
}
