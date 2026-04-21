// ═══════════════════════════════════════════════════════
// Industry-Specific Flow Configuration
// Maps each category to per-capability customizations
// ═══════════════════════════════════════════════════════

export interface IndustrySchedulingConfig {
  askAllergies?: boolean;
  specialOccasionOptions?: string[];
  askTherapistPreference?: boolean;
  askPetType?: boolean;
  askVehicleType?: boolean;
}

export interface IndustryPaymentConfig {
  defaultCategories?: string[];
  receiptWording?: string;
}

export interface IndustryOrderingConfig {
  deliveryOptions?: ('delivery' | 'pickup')[];
  askDeliveryAddress?: boolean;
}

export interface IndustryConfig {
  scheduling?: IndustrySchedulingConfig;
  payment?: IndustryPaymentConfig;
  ordering?: IndustryOrderingConfig;
}

export const INDUSTRY_CONFIG: Record<string, IndustryConfig> = {
  restaurant: {
    scheduling: {
      askAllergies: true,
      specialOccasionOptions: ['Birthday', 'Anniversary', 'Business Dinner', 'Date Night'],
    },
  },
  spa: {
    scheduling: {
      askTherapistPreference: true,
    },
  },
  salon: {
    scheduling: {
      askTherapistPreference: true,
    },
  },
  veterinary: {
    scheduling: {
      askPetType: true,
    },
  },
  car_wash: {
    scheduling: {
      askVehicleType: true,
    },
  },
  car_park: {
    payment: {
      defaultCategories: ['Hourly Parking', 'Daily Parking', 'Monthly Pass'],
      receiptWording: 'Parking Payment',
    },
  },
  church: {
    payment: {
      defaultCategories: ['Tithe', 'Offering', 'Building Fund', 'Welfare'],
      receiptWording: 'Church Giving',
    },
  },
  mosque: {
    payment: {
      defaultCategories: ['Zakat', 'Sadaqah', 'Fitrah'],
      receiptWording: 'Mosque Giving',
    },
  },
  school: {
    payment: {
      defaultCategories: ['School Fees', 'PTA Dues', 'Exam Fees'],
      receiptWording: 'School Fee Payment',
    },
  },
  government: {
    payment: {
      defaultCategories: ['Utility Bill', 'Application Fee', 'Tax Payment'],
      receiptWording: 'Government Payment',
    },
  },
  taxi: {
    payment: {
      defaultCategories: ['Ride Payment'],
      receiptWording: 'Ride Payment',
    },
  },
  food_delivery: {
    ordering: {
      deliveryOptions: ['delivery', 'pickup'],
      askDeliveryAddress: true,
    },
  },
  shop: {
    ordering: {
      deliveryOptions: ['delivery', 'pickup'],
      askDeliveryAddress: true,
    },
  },
  instagram_vendor: {
    ordering: {
      deliveryOptions: ['delivery'],
      askDeliveryAddress: true,
    },
  },
  mall_vendor: {
    ordering: {
      deliveryOptions: ['pickup'],
      askDeliveryAddress: false,
    },
  },
  pharmacy: {
    ordering: {
      deliveryOptions: ['delivery', 'pickup'],
      askDeliveryAddress: true,
    },
  },
  catering: {
    ordering: {
      deliveryOptions: ['delivery'],
      askDeliveryAddress: true,
    },
  },
  tailor: {
    ordering: {
      deliveryOptions: ['pickup'],
      askDeliveryAddress: false,
    },
  },
  logistics: {
    ordering: {
      deliveryOptions: ['delivery'],
      askDeliveryAddress: true,
    },
  },
};

/** Get industry config for a category, with empty-object fallback */
export function getIndustryConfig(category: string): IndustryConfig {
  return INDUSTRY_CONFIG[category] || {};
}

/**
 * Async: read industry_config from category_templates.metadata in DB,
 * falling back to the hardcoded INDUSTRY_CONFIG if not found.
 */
export async function getIndustryConfigAsync(category: string): Promise<IndustryConfig> {
  try {
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    const { data } = await supabase
      .from('category_templates')
      .select('metadata')
      .eq('key', category)
      .single();

    if (data?.metadata?.industry_config) {
      return data.metadata.industry_config as IndustryConfig;
    }
  } catch {
    // Fall through to hardcoded
  }
  return INDUSTRY_CONFIG[category] || {};
}
