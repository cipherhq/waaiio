import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime } from '@/lib/formatters';
import { ClipboardList, CheckCircle, MessageCircle, BarChart3 } from 'lucide-react';

interface Survey {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  questions: Array<{ id: string; type: string; text: string; options?: string[] }>;
  status: string;
  total_responses: number;
  created_at: string;
  updated_at: string;
  business_name?: string;
}

interface SurveyResponse {
  id: string;
  survey_id: string;
  customer_phone: string;
  customer_name: string | null;
  answers: Record<string, unknown>;
  completed: boolean;
  started_at: string;
  completed_at: string | null;
}

export default function Surveys() {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Survey | null>(null);
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [responsesLoading, setResponsesLoading] = useState(false);
  const perPage = 20;

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    const { data } = await adminDb
      .from('surveys')
      .select('*')
      .order('created_at', { ascending: false });

    const rows = data || [];

    // Enrich with business names
    const bizIds = [...new Set(rows.map(s => s.business_id).filter(Boolean))];
    const { data: bizData } = bizIds.length > 0
      ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
      : { data: [] };
    const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));

    setSurveys(rows.map(s => ({ ...s, business_name: bizMap.get(s.business_id) || 'Unknown' })));
    setLoading(false);
  }

  async function loadResponses(surveyId: string) {
    setResponsesLoading(true);
    const { data } = await adminDb
      .from('survey_responses')
      .select('*')
      .eq('survey_id', surveyId)
      .order('started_at', { ascending: false })
      .limit(100);
    setResponses(data || []);
    setResponsesLoading(false);
  }

  function openDetail(survey: Survey) {
    setSelected(survey);
    loadResponses(survey.id);
  }

  // Filter
  const filtered = surveys.filter(s => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!s.title.toLowerCase().includes(q) && !(s.business_name || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.ceil(filtered.length / perPage);
  const paged = filtered.slice((page - 1) * perPage, page * perPage);

  // Stats
  const totalSurveys = surveys.length;
  const activeSurveys = surveys.filter(s => s.status === 'active').length;
  const totalResponses = surveys.reduce((sum, s) => sum + (s.total_responses || 0), 0);
  const avgResponses = totalSurveys > 0 ? Math.round(totalResponses / totalSurveys) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Surveys</h1>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <SummaryCard label="Total Surveys" value={totalSurveys} icon={ClipboardList} color="blue" />
        <SummaryCard label="Active" value={activeSurveys} icon={CheckCircle} color="green" />
        <SummaryCard label="Total Responses" value={totalResponses} icon={MessageCircle} color="purple" />
        <SummaryCard label="Avg Responses/Survey" value={avgResponses} icon={BarChart3} color="yellow" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search by title or business..."
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-full sm:w-64"
        />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="all">All Status</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-medium text-gray-500">Survey</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Business</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Questions</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Responses</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
            ) : paged.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No surveys found</td></tr>
            ) : paged.map(s => (
              <tr key={s.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => openDetail(s)}>
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{s.title}</p>
                  {s.description && <p className="text-xs text-gray-400 truncate max-w-[200px]">{s.description}</p>}
                </td>
                <td className="px-4 py-3 text-gray-600">{s.business_name}</td>
                <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                <td className="px-4 py-3 text-gray-600">{s.questions?.length || 0}</td>
                <td className="px-4 py-3 text-gray-600">{s.total_responses || 0}</td>
                <td className="px-4 py-3 text-gray-500">{fmtDate(s.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      {selected && (
        <DetailModal open={true} title={selected.title} onClose={() => { setSelected(null); setResponses([]); }}>
          <DetailRow label="Business" value={selected.business_name || 'Unknown'} />
          <DetailRow label="Status" value={<StatusBadge status={selected.status} />} />
          <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
          <DetailRow label="Total Responses" value={selected.total_responses || 0} />

          {/* Questions */}
          <div className="mt-4">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Questions ({selected.questions?.length || 0})</p>
            <div className="space-y-2">
              {(selected.questions || []).map((q, i) => (
                <div key={q.id} className="bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-sm text-gray-800">Q{i + 1}: {q.text}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Type: {q.type}
                    {q.options && ` | Options: ${q.options.join(', ')}`}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Responses */}
          <div className="mt-4">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
              Responses {responsesLoading ? '(loading...)' : `(${responses.length})`}
            </p>
            {responses.length === 0 && !responsesLoading ? (
              <p className="text-sm text-gray-400">No responses yet</p>
            ) : (
              <div className="max-h-60 overflow-y-auto space-y-2">
                {responses.map(r => (
                  <div key={r.id} className="bg-gray-50 rounded-lg px-3 py-2">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-gray-700">{r.customer_name || r.customer_phone}</span>
                      <span className="text-gray-400">
                        {r.completed ? 'Completed' : 'Incomplete'} &middot; {fmtDate(r.completed_at || r.started_at)}
                      </span>
                    </div>
                    {r.completed && (
                      <div className="mt-1 space-y-0.5">
                        {(selected.questions || []).map((q, i) => (
                          <p key={q.id} className="text-xs text-gray-600">
                            <span className="text-gray-400">Q{i + 1}:</span> {String(r.answers[q.id] ?? '-')}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DetailModal>
      )}
    </div>
  );
}
