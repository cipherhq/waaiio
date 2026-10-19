'use client';

import { useRef } from 'react';
import type { ViewMode } from './types';
import { parseCSV, mapCSVRow } from './types';

interface BulkUploadProps {
  setView: (view: ViewMode) => void;
  curr: string;
  bulkText: string;
  setBulkText: (text: string) => void;
  bulkPreview: ReturnType<typeof mapCSVRow>[];
  setBulkPreview: (preview: ReturnType<typeof mapCSVRow>[]) => void;
  bulkImporting: boolean;
  bulkResult: { imported: number; skipped: number; errors?: { row: number; reason: string }[] } | null;
  setBulkResult: (result: { imported: number; skipped: number; errors?: { row: number; reason: string }[] } | null) => void;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleBulkTextChange: (text: string) => void;
  handleBulkImport: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
}

export default function BulkUpload({
  setView,
  curr,
  bulkText,
  bulkPreview,
  bulkImporting,
  bulkResult,
  handleFileSelect,
  handleBulkTextChange,
  handleBulkImport,
  fileInputRef,
}: BulkUploadProps) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <button aria-label="Go back" onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300">
          <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Bulk Upload Products</h1>
      </div>

      <div className="mt-5 space-y-4">
        {/* Drop zone */}
        <div className="rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 p-6">
          <div className="text-center">
            <svg aria-hidden="true" className="mx-auto h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">Upload a CSV file or paste products below</p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
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
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Or paste your products</label>
          <textarea
            value={bulkText}
            onChange={(e) => handleBulkTextChange(e.target.value)}
            rows={6}
            placeholder={`name, price, category\nJollof Rice, 2500, Food\nChapman Drink, 1500, Drinks\nMen's T-Shirt, 5000, Clothing`}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
          />
        </div>

        {/* Preview */}
        {bulkPreview.length > 0 && (
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-4 py-3">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
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
                <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs text-gray-500 dark:text-gray-400">
                  <tr>
                    <th scope="col" className="px-4 py-2">#</th>
                    <th scope="col" className="px-4 py-2">Name</th>
                    <th scope="col" className="px-4 py-2">Price</th>
                    <th scope="col" className="px-4 py-2">Category</th>
                    <th scope="col" className="px-4 py-2">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkPreview.map((p, i) => (
                    <tr key={i} className="border-t border-gray-50 dark:border-gray-700">
                      <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                      <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{p.name}</td>
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
