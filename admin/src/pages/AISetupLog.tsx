import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { SummaryCard } from '@/components/SummaryCard';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime } from '@/lib/formatters';
import { Zap, Building2, Package, Clock } from 'lucide-react';

/**
 * AI Setup Audit Log
 *
 * Tracks what Ace AI Assistant created for each business.
 * Reads from the services, products, and whatsapp_configs tables
 * to show recently created items (proxy for AI-created setup).
 *
 * Also shows businesses that used the setup assistant recently
 * by checking for services created in bulk (multiple within seconds).
 */

interface SetupEvent {
  business_id: string;
  business_name: string;
  services_created: number;
  products_created: number;
  latest_created_at: string;
  services: Array<{ name: string; price: number }>;
  products: Array<{ name: string; price: number }>;
}

export default function AISetupLog() {
  const [events, setEvents] = useState<SetupEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SetupEvent | null>(null);
  const [page, setPage] = useState(1);
  const perPage = 20;

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);

    // Get all businesses
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, name')
      .order('created_at', { ascending: false });

    if (!businesses?.length) {
      setLoading(false);
      return;
    }

    // For each business, check for bulk-created services (multiple within 5 minutes = likely AI setup)
    const results: SetupEvent[] = [];

    for (const biz of businesses) {
      const [{ data: services }, { data: products }] = await Promise.all([
        adminDb.from('services').select('name, price, created_at').eq('business_id', biz.id).order('created_at', { ascending: false }).limit(50),
        adminDb.from('products').select('name, price, created_at').eq('business_id', biz.id).order('created_at', { ascending: false }).limit(50),
      ]);

      // Detect bulk creation: items created within 60 seconds of each other
      const svcItems = services || [];
      const prodItems = products || [];

      if (svcItems.length === 0 && prodItems.length === 0) continue;

      // Group services by creation burst (within 60s)
      const bulkServices: typeof svcItems = [];
      if (svcItems.length >= 2) {
        let burstStart = new Date(svcItems[0].created_at).getTime();
        for (const s of svcItems) {
          const t = new Date(s.created_at).getTime();
          if (Math.abs(t - burstStart) < 60_000) {
            bulkServices.push(s);
          }
        }
      }

      const bulkProducts: typeof prodItems = [];
      if (prodItems.length >= 2) {
        let burstStart = new Date(prodItems[0].created_at).getTime();
        for (const p of prodItems) {
          const t = new Date(p.created_at).getTime();
          if (Math.abs(t - burstStart) < 60_000) {
            bulkProducts.push(p);
          }
        }
      }

      if (bulkServices.length >= 2 || bulkProducts.length >= 2) {
        const latestDate = svcItems[0]?.created_at || prodItems[0]?.created_at || '';
        results.push({
          business_id: biz.id,
          business_name: biz.name,
          services_created: bulkServices.length,
          products_created: bulkProducts.length,
          latest_created_at: latestDate,
          services: bulkServices.map(s => ({ name: s.name, price: s.price })),
          products: bulkProducts.map(p => ({ name: p.name, price: p.price })),
        });
      }
    }

    results.sort((a, b) => new Date(b.latest_created_at).getTime() - new Date(a.latest_created_at).getTime());
    setEvents(results);
    setLoading(false);
  }

  const totalPages = Math.ceil(events.length / perPage);
  const paged = events.slice((page - 1) * perPage, page * perPage);

  const totalSetups = events.length;
  const totalServicesCreated = events.reduce((s, e) => s + e.services_created, 0);
  const totalProductsCreated = events.reduce((s, e) => s + e.products_created, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Ace AI Setup Log</h1>
      <p className="text-sm text-gray-500">Businesses that used Ace to set up services and products (detected by bulk creation pattern).</p>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <SummaryCard label="Businesses Used Ace" value={totalSetups} icon={Zap} color="purple" />
        <SummaryCard label="Services Created" value={totalServicesCreated} icon={Building2} color="blue" />
        <SummaryCard label="Products Created" value={totalProductsCreated} icon={Package} color="green" />
        <SummaryCard label="Latest" value={events[0] ? fmtDate(events[0].latest_created_at) : '-'} icon={Clock} color="yellow" />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-medium text-gray-500">Business</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Services</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Products</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
            ) : paged.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No AI setups detected yet</td></tr>
            ) : paged.map(e => (
              <tr key={e.business_id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(e)}>
                <td className="px-4 py-3 font-medium text-gray-900">{e.business_name}</td>
                <td className="px-4 py-3 text-gray-600">{e.services_created}</td>
                <td className="px-4 py-3 text-gray-600">{e.products_created}</td>
                <td className="px-4 py-3 text-gray-500">{fmtDateTime(e.latest_created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      {selected && (
        <DetailModal title={`AI Setup: ${selected.business_name}`} onClose={() => setSelected(null)}>
          <DetailRow label="Business" value={selected.business_name} />
          <DetailRow label="Date" value={fmtDateTime(selected.latest_created_at)} />
          <DetailRow label="Services Created" value={selected.services_created} />
          <DetailRow label="Products Created" value={selected.products_created} />

          {selected.services.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Services</p>
              <div className="space-y-1">
                {selected.services.map((s, i) => (
                  <div key={i} className="flex justify-between text-sm bg-gray-50 rounded px-3 py-1.5">
                    <span className="text-gray-800">{s.name}</span>
                    <span className="text-gray-500">{s.price > 0 ? s.price : 'Free'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selected.products.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Products</p>
              <div className="space-y-1">
                {selected.products.map((p, i) => (
                  <div key={i} className="flex justify-between text-sm bg-gray-50 rounded px-3 py-1.5">
                    <span className="text-gray-800">{p.name}</span>
                    <span className="text-gray-500">{p.price}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DetailModal>
      )}
    </div>
  );
}
