import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate } from '@/lib/formatters';
import {
  Layers,
  Plus,
  Pencil,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Search,
  X,
} from 'lucide-react';

interface DefaultService {
  name: string;
  price: number;
  price_is_variable: boolean;
  duration_minutes: number | null;
  deposit_amount: number;
  billing_type: 'one_time' | 'recurring';
  recurring_interval: 'weekly' | 'monthly' | null;
  is_featured: boolean;
  cancellation_policy: string | null;
}

interface CategoryTemplate {
  id: string;
  key: string;
  label: string;
  icon: string;
  flow_type: string;
  is_active: boolean;
  sort_order: number;
  default_services: DefaultService[];
  default_greeting: string;
  labels: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const FLOW_TYPES = ['scheduling', 'payment', 'ordering', 'ticketing', 'reservation', 'queue'] as const;

const FLOW_BADGE_COLORS: Record<string, string> = {
  scheduling: 'bg-blue-100 text-blue-700',
  payment: 'bg-green-100 text-green-700',
  ordering: 'bg-purple-100 text-purple-700',
  ticketing: 'bg-yellow-100 text-yellow-700',
  reservation: 'bg-teal-100 text-teal-700',
  queue: 'bg-orange-100 text-orange-700',
};

const ALL_CAPABILITIES = [
  { id: 'scheduling', label: 'Scheduling', icon: '📅' },
  { id: 'payment', label: 'Payments', icon: '💳' },
  { id: 'ordering', label: 'Online Store', icon: '🛒' },
  { id: 'ticketing', label: 'Ticketing', icon: '🎟️' },
  { id: 'feedback', label: 'Feedback', icon: '⭐' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'reminders', label: 'Reminders', icon: '🔔' },
  { id: 'loyalty', label: 'Loyalty', icon: '🏆' },
  { id: 'referral', label: 'Referral', icon: '🤝' },
  { id: 'queue', label: 'Queue', icon: '📋' },
  { id: 'waitlist', label: 'Waitlist', icon: '📝' },
  { id: 'reports', label: 'Reports', icon: '📄' },
  { id: 'staff', label: 'Staff', icon: '👥' },
  { id: 'crowdfunding', label: 'Crowdfunding', icon: '❤️' },
] as const;

const EMPTY_SERVICE: DefaultService = {
  name: '',
  price: 0,
  price_is_variable: false,
  duration_minutes: 60,
  deposit_amount: 0,
  billing_type: 'one_time',
  recurring_interval: null,
  is_featured: false,
  cancellation_policy: null,
};

const EMPTY_LABELS = {
  entityName: '',
  entityNamePlural: '',
  actionVerb: '',
  confirmationEmoji: '',
  receiptTitle: '',
  quantityLabel: '',
  personLabel: '',
  personLabelPlural: '',
  serviceName: '',
  serviceNamePlural: '',
  hiddenStatuses: [] as string[],
};

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

export default function CategoryTemplates() {
  const [templates, setTemplates] = useState<CategoryTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [flowFilter, setFlowFilter] = useState('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const perPage = 20;

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryTemplate | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [formKey, setFormKey] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formIcon, setFormIcon] = useState('🔧');
  const [formFlowType, setFormFlowType] = useState<string>('scheduling');
  const [formActive, setFormActive] = useState(true);
  const [formSortOrder, setFormSortOrder] = useState(0);
  const [formGreeting, setFormGreeting] = useState('Welcome to {{name}}! How can I help you today?');
  const [formLabels, setFormLabels] = useState<typeof EMPTY_LABELS>({ ...EMPTY_LABELS });
  const [formServices, setFormServices] = useState<DefaultService[]>([]);
  const [formCapabilities, setFormCapabilities] = useState<string[]>([]);

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('category_templates')
        .select('*')
        .order('sort_order', { ascending: true });
      setTemplates(data || []);
    } catch (error) {
      console.warn('Failed to load category templates:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  // Filters
  const filtered = templates.filter(t => {
    if (search) {
      const q = search.toLowerCase();
      if (!t.label.toLowerCase().includes(q) && !t.key.toLowerCase().includes(q)) return false;
    }
    if (flowFilter !== 'all' && t.flow_type !== flowFilter) return false;
    if (activeFilter === 'active' && !t.is_active) return false;
    if (activeFilter === 'inactive' && t.is_active) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Stats
  const totalTemplates = templates.length;
  const activeTemplates = templates.filter(t => t.is_active).length;
  const flowBreakdown = FLOW_TYPES.map(f => templates.filter(t => t.flow_type === f).length);
  const flowSummary = FLOW_TYPES.map((f, i) => `${f}: ${flowBreakdown[i]}`).join(', ');

  // Open create modal
  function handleCreate() {
    setEditing(null);
    setFormKey('');
    setFormLabel('');
    setFormIcon('🔧');
    setFormFlowType('scheduling');
    setFormActive(true);
    setFormSortOrder(templates.length);
    setFormGreeting('Welcome to {{name}}! How can I help you today?');
    setFormLabels({ ...EMPTY_LABELS });
    setFormServices([]);
    setFormCapabilities(['scheduling', 'feedback', 'chat']);
    setModalOpen(true);
  }

  // Open edit modal
  function handleEdit(t: CategoryTemplate) {
    setEditing(t);
    setFormKey(t.key);
    setFormLabel(t.label);
    setFormIcon(t.icon);
    setFormFlowType(t.flow_type);
    setFormActive(t.is_active);
    setFormSortOrder(t.sort_order);
    setFormGreeting(t.default_greeting);
    const labels = t.labels as typeof EMPTY_LABELS;
    setFormLabels({
      entityName: labels.entityName || '',
      entityNamePlural: labels.entityNamePlural || '',
      actionVerb: labels.actionVerb || '',
      confirmationEmoji: labels.confirmationEmoji || '',
      receiptTitle: labels.receiptTitle || '',
      quantityLabel: labels.quantityLabel || '',
      personLabel: labels.personLabel || '',
      personLabelPlural: labels.personLabelPlural || '',
      serviceName: labels.serviceName || '',
      serviceNamePlural: labels.serviceNamePlural || '',
      hiddenStatuses: labels.hiddenStatuses || [],
    });
    setFormServices(Array.isArray(t.default_services) ? [...t.default_services] : []);
    const metaCaps = (t.metadata as Record<string, unknown>)?.default_capabilities;
    setFormCapabilities(Array.isArray(metaCaps) ? [...metaCaps] : ['scheduling', 'feedback', 'chat']);
    setModalOpen(true);
  }

  // Save (create or edit)
  async function handleSave() {
    if (!formKey.trim() || !formLabel.trim()) {
      alert('Key and Label are required');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        key: slugify(formKey),
        label: formLabel.trim(),
        icon: formIcon || '🔧',
        flow_type: formFlowType,
        is_active: formActive,
        sort_order: formSortOrder,
        default_greeting: formGreeting,
        labels: formLabels,
        default_services: formServices.filter(s => s.name.trim()),
        metadata: { default_capabilities: formCapabilities },
        updated_at: new Date().toISOString(),
      };

      if (editing) {
        const { error } = await supabase
          .from('category_templates')
          .update(payload)
          .eq('id', editing.id);
        if (error) throw error;

        await logAudit({
          action: 'update_category_template',
          entity_type: 'category_template',
          entity_id: editing.id,
          details: { key: payload.key, label: payload.label },
        });
      } else {
        const { data, error } = await supabase
          .from('category_templates')
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;

        await logAudit({
          action: 'create_category_template',
          entity_type: 'category_template',
          entity_id: data.id,
          details: { key: payload.key, label: payload.label },
        });
      }

      setModalOpen(false);
      await loadData();
    } catch (error) {
      console.error('Save template error:', error);
      alert('Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  // Toggle active
  async function handleToggle(t: CategoryTemplate) {
    try {
      const { error } = await supabase
        .from('category_templates')
        .update({ is_active: !t.is_active, updated_at: new Date().toISOString() })
        .eq('id', t.id);
      if (error) throw error;

      await logAudit({
        action: t.is_active ? 'deactivate_category_template' : 'activate_category_template',
        entity_type: 'category_template',
        entity_id: t.id,
        details: { key: t.key, is_active: !t.is_active },
      });
      await loadData();
    } catch (error) {
      console.error('Toggle template error:', error);
    }
  }

  // Delete
  async function handleDelete(t: CategoryTemplate) {
    if (!confirm(`Delete template "${t.label}"? This cannot be undone.`)) return;
    try {
      const { error } = await supabase
        .from('category_templates')
        .delete()
        .eq('id', t.id);
      if (error) throw error;

      await logAudit({
        action: 'delete_category_template',
        entity_type: 'category_template',
        entity_id: t.id,
        details: { key: t.key, label: t.label },
      });
      await loadData();
    } catch (error) {
      console.error('Delete template error:', error);
      alert('Failed to delete template');
    }
  }

  // Service list helpers
  function updateService(index: number, field: keyof DefaultService, value: unknown) {
    setFormServices(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }

  function addService() {
    setFormServices(prev => [...prev, { ...EMPTY_SERVICE }]);
  }

  function removeService(index: number) {
    setFormServices(prev => prev.filter((_, i) => i !== index));
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Category Templates</h1>
          <p className="mt-1 text-sm text-gray-500">Manage business category templates for onboarding</p>
        </div>
        <button
          onClick={handleCreate}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600"
        >
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add Template
          </span>
        </button>
      </div>

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Templates" value={totalTemplates} icon={Layers} color="blue" />
        <SummaryCard label="Active" value={activeTemplates} icon={ToggleRight} color="green" />
        <SummaryCard label="Inactive" value={totalTemplates - activeTemplates} icon={ToggleLeft} color="gray" />
        <SummaryCard label="Flow Types" value={flowSummary} icon={Layers} color="purple" />
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search templates..."
            className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 focus:border-brand focus:outline-none"
          />
        </div>

        <select
          value={flowFilter}
          onChange={e => { setFlowFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Flow Types</option>
          {FLOW_TYPES.map(f => (
            <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
          ))}
        </select>

        <select
          value={activeFilter}
          onChange={e => { setActiveFilter(e.target.value as 'all' | 'active' | 'inactive'); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>

        {(search || flowFilter !== 'all' || activeFilter !== 'all') && (
          <button
            onClick={() => { setSearch(''); setFlowFilter('all'); setActiveFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No templates found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Icon</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Label</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Key</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Flow Type</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Services</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(t => (
                <tr key={t.id} className="transition hover:bg-gray-50">
                  <td className="px-4 py-3 text-lg">{t.icon}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{t.label}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{t.key}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${FLOW_BADGE_COLORS[t.flow_type] || 'bg-gray-100 text-gray-600'}`}>
                      {t.flow_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {Array.isArray(t.default_services) ? t.default_services.length : 0}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={t.is_active ? 'active' : 'inactive'} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(t.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleToggle(t)}
                        className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                        title={t.is_active ? 'Deactivate' : 'Activate'}
                      >
                        {t.is_active ? <ToggleRight className="h-4 w-4 text-green-500" /> : <ToggleLeft className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={() => handleEdit(t)}
                        className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(t)}
                        className="rounded-lg p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-500"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Create / Edit Modal */}
      <DetailModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Edit Template: ${editing.label}` : 'Create Template'}
        wide
      >
        <div className="space-y-6">
          {/* Basic Info */}
          <div>
            <p className="text-xs font-semibold uppercase text-gray-500 mb-3">Basic Info</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700">Key</label>
                <input
                  type="text"
                  value={formKey}
                  onChange={e => setFormKey(slugify(e.target.value))}
                  disabled={!!editing}
                  placeholder="e.g. restaurant"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Label</label>
                <input
                  type="text"
                  value={formLabel}
                  onChange={e => setFormLabel(e.target.value)}
                  placeholder="e.g. Restaurant"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Icon (emoji)</label>
                <input
                  type="text"
                  value={formIcon}
                  onChange={e => setFormIcon(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Flow Type</label>
                <select
                  value={formFlowType}
                  onChange={e => setFormFlowType(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                >
                  {FLOW_TYPES.map(f => (
                    <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Sort Order</label>
                <input
                  type="number"
                  value={formSortOrder}
                  onChange={e => setFormSortOrder(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                />
              </div>
              <div className="flex items-end gap-3 pb-1">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formActive}
                    onChange={e => setFormActive(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  Active
                </label>
              </div>
            </div>
          </div>

          <div className="border-t border-gray-100" />

          {/* Default Greeting */}
          <div>
            <p className="text-xs font-semibold uppercase text-gray-500 mb-3">Default Greeting</p>
            <textarea
              value={formGreeting}
              onChange={e => setFormGreeting(e.target.value)}
              rows={3}
              placeholder="Welcome to {{name}}! How can I help you today?"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-400">Use {'{{name}}'} as a placeholder for the business name</p>
          </div>

          <div className="border-t border-gray-100" />

          {/* UI Labels */}
          <div>
            <p className="text-xs font-semibold uppercase text-gray-500 mb-3">UI Labels</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(Object.keys(EMPTY_LABELS) as (keyof typeof EMPTY_LABELS)[])
                .filter(k => k !== 'hiddenStatuses')
                .map(key => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-gray-600">{key}</label>
                    <input
                      type="text"
                      value={(formLabels[key] as string) || ''}
                      onChange={e => setFormLabels(prev => ({ ...prev, [key]: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                    />
                  </div>
                ))}
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-600">hiddenStatuses (comma-separated)</label>
                <input
                  type="text"
                  value={(formLabels.hiddenStatuses || []).join(', ')}
                  onChange={e => setFormLabels(prev => ({
                    ...prev,
                    hiddenStatuses: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                  }))}
                  placeholder="e.g. no_show, in_progress, confirmed"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-gray-100" />

          {/* Default Services */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase text-gray-500">Default Services</p>
              <button
                onClick={addService}
                className="flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-200"
              >
                <Plus className="h-3 w-3" />
                Add Service
              </button>
            </div>

            {formServices.length === 0 ? (
              <p className="text-sm text-gray-400">No default services. Click "Add Service" to add one.</p>
            ) : (
              <div className="space-y-3">
                {formServices.map((svc, i) => (
                  <div key={i} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-600">Name</label>
                          <input
                            type="text"
                            value={svc.name}
                            onChange={e => updateService(i, 'name', e.target.value)}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600">Price</label>
                          <input
                            type="number"
                            value={svc.price}
                            onChange={e => updateService(i, 'price', Number(e.target.value))}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600">Duration (min)</label>
                          <input
                            type="number"
                            value={svc.duration_minutes ?? ''}
                            onChange={e => updateService(i, 'duration_minutes', e.target.value ? Number(e.target.value) : null)}
                            placeholder="null"
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600">Deposit</label>
                          <input
                            type="number"
                            value={svc.deposit_amount}
                            onChange={e => updateService(i, 'deposit_amount', Number(e.target.value))}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                          />
                        </div>
                      </div>
                      <button
                        onClick={() => removeService(i)}
                        className="mt-4 rounded-lg p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-500"
                        title="Remove service"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <label className="block text-xs font-medium text-gray-600">Billing Type</label>
                        <select
                          value={svc.billing_type || 'one_time'}
                          onChange={e => {
                            const val = e.target.value as 'one_time' | 'recurring';
                            updateService(i, 'billing_type', val);
                            if (val === 'recurring' && !svc.recurring_interval) {
                              updateService(i, 'recurring_interval', 'monthly');
                            }
                            if (val === 'one_time') {
                              updateService(i, 'recurring_interval', null);
                            }
                          }}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                        >
                          <option value="one_time">One-time</option>
                          <option value="recurring">Recurring</option>
                        </select>
                      </div>
                      {(svc.billing_type === 'recurring') && (
                        <div>
                          <label className="block text-xs font-medium text-gray-600">Interval</label>
                          <select
                            value={svc.recurring_interval || 'monthly'}
                            onChange={e => updateService(i, 'recurring_interval', e.target.value)}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                          >
                            <option value="weekly">Weekly</option>
                            <option value="monthly">Monthly</option>
                          </select>
                        </div>
                      )}
                      <div>
                        <label className="block text-xs font-medium text-gray-600">Cancellation Policy</label>
                        <input
                          type="text"
                          value={svc.cancellation_policy || ''}
                          onChange={e => updateService(i, 'cancellation_policy', e.target.value || null)}
                          placeholder="Optional"
                          className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-700 focus:border-brand focus:outline-none"
                        />
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-4">
                      <label className="flex items-center gap-2 text-xs font-medium text-gray-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={svc.price_is_variable}
                          onChange={e => updateService(i, 'price_is_variable', e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-brand focus:ring-brand"
                        />
                        Variable price
                      </label>
                      <label className="flex items-center gap-2 text-xs font-medium text-gray-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={svc.is_featured || false}
                          onChange={e => updateService(i, 'is_featured', e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-brand focus:ring-brand"
                        />
                        Featured
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-gray-100" />

          {/* Default Capabilities */}
          <div>
            <p className="text-xs font-semibold uppercase text-gray-500 mb-3">
              Default Capabilities
              <span className="ml-2 text-gray-400 normal-case font-normal">
                ({formCapabilities.length} selected)
              </span>
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ALL_CAPABILITIES.map(cap => {
                const isSelected = formCapabilities.includes(cap.id);
                return (
                  <button
                    key={cap.id}
                    type="button"
                    onClick={() => {
                      setFormCapabilities(prev =>
                        isSelected
                          ? prev.filter(c => c !== cap.id)
                          : [...prev, cap.id]
                      );
                    }}
                    className={`flex items-center gap-2 rounded-lg border p-2.5 text-left text-xs transition ${
                      isSelected
                        ? 'border-brand/30 bg-brand-50 font-semibold text-gray-900'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-base">{cap.icon}</span>
                    <span>{cap.label}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-gray-400">
              These capabilities will be pre-enabled when a business selects this category during signup.
            </p>
          </div>

          {/* Save button */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving || !formKey.trim() || !formLabel.trim()}
              className="rounded-xl bg-brand px-6 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Template'}
            </button>
            <button
              onClick={() => setModalOpen(false)}
              className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </DetailModal>
    </div>
  );
}
