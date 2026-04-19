'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';

interface FeedbackEntry {
  id: string;
  business_id: string;
  customer_phone: string;
  customer_name: string | null;
  rating: number;
  comment: string | null;
  service_type: string | null;
  created_at: string;
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg
          key={star}
          className={`h-4 w-4 ${star <= rating ? 'text-yellow-400' : 'text-gray-200'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

const RATING_COLORS: Record<number, string> = {
  5: 'bg-green-500',
  4: 'bg-lime-500',
  3: 'bg-yellow-400',
  2: 'bg-orange-400',
  1: 'bg-red-500',
};

export default function FeedbackPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const [reviews, setReviews] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchReviews = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('customer_feedback')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setReviews((data as FeedbackEntry[]) || []);
    setLoading(false);
  }, [business.id]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  // Metrics
  const totalReviews = reviews.length;
  const avgRating =
    totalReviews > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
      : 0;
  const fiveStarCount = reviews.filter((r) => r.rating === 5).length;
  const fiveStarPct = totalReviews > 0 ? Math.round((fiveStarCount / totalReviews) * 100) : 0;

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const reviewsThisMonth = reviews.filter((r) => r.created_at >= thisMonthStart).length;

  // Rating distribution
  const ratingCounts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  reviews.forEach((r) => {
    if (ratingCounts[r.rating] !== undefined) ratingCounts[r.rating]++;
  });
  const maxCount = Math.max(...Object.values(ratingCounts), 1);

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Feedback</h1>
        <p className="mt-1 text-sm text-gray-500">
          {labels.personLabel} feedback and ratings for your business.
        </p>
      </div>

      {/* Metrics Cards */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Average Rating</p>
          <div className="mt-1 flex items-baseline gap-2">
            <p className="text-2xl font-bold text-gray-900">{avgRating.toFixed(1)}</p>
            <svg className="h-5 w-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          </div>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Feedback</p>
          <p className="mt-1 text-2xl font-bold text-brand">{totalReviews}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">5-Star %</p>
          <p className="mt-1 text-2xl font-bold text-green-600">{fiveStarPct}%</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Feedback This Month</p>
          <p className="mt-1 text-2xl font-bold text-gray-700">{reviewsThisMonth}</p>
        </div>
      </div>

      {/* Rating Distribution */}
      {!loading && totalReviews > 0 && (
        <div className="mt-6 rounded-xl border border-gray-100 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">Rating Distribution</h2>
          <div className="mt-4 space-y-2">
            {[5, 4, 3, 2, 1].map((star) => (
              <div key={star} className="flex items-center gap-3">
                <span className="w-8 text-right text-sm font-medium text-gray-600">{star}</span>
                <svg className="h-4 w-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                <div className="flex-1">
                  <div className="h-3 w-full rounded-full bg-gray-100">
                    <div
                      className={`h-3 rounded-full ${RATING_COLORS[star]}`}
                      style={{ width: `${(ratingCounts[star] / maxCount) * 100}%` }}
                    />
                  </div>
                </div>
                <span className="w-10 text-right text-sm text-gray-500">{ratingCounts[star]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reviews Table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50/50">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Date</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">{labels.personLabel}</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Rating</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Comment</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Service Type</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-brand" />
                  <p className="mt-2 text-sm text-gray-400">Loading feedback...</p>
                </td>
              </tr>
            ) : reviews.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <p className="text-sm text-gray-400">No feedback yet.</p>
                  <p className="mt-1 text-xs text-gray-300">
                    {labels.personLabel} feedback will appear here once submitted.
                  </p>
                </td>
              </tr>
            ) : (
              reviews.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                    {new Date(r.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {r.customer_name || r.customer_phone}
                  </td>
                  <td className="px-4 py-3">
                    <StarRating rating={r.rating} />
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-gray-600">
                    {r.comment || <span className="text-gray-300">--</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                    {r.service_type || <span className="text-gray-300">--</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
