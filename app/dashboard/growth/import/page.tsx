'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';

type FieldMapping = 'first_name' | 'last_name' | 'phone' | 'email' | 'birthday' | 'tags' | 'skip';

const FIELD_OPTIONS: { value: FieldMapping; label: string }[] = [
  { value: 'skip', label: 'Skip' },
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'birthday', label: 'Birthday' },
  { value: 'tags', label: 'Tags' },
];

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          cells.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    cells.push(current.trim());
    rows.push(cells);
  }
  return rows;
}

function guessMapping(header: string): FieldMapping {
  const h = header.toLowerCase().replace(/[^a-z]/g, '');
  if (h.includes('firstname') || h === 'first' || h === 'fname') return 'first_name';
  if (h.includes('lastname') || h === 'last' || h === 'lname' || h === 'surname') return 'last_name';
  if (h.includes('name') && !h.includes('first') && !h.includes('last')) return 'first_name';
  if (h.includes('phone') || h.includes('mobile') || h.includes('cell') || h.includes('tel')) return 'phone';
  if (h.includes('email') || h.includes('mail')) return 'email';
  if (h.includes('birthday') || h.includes('birth') || h.includes('dob')) return 'birthday';
  if (h.includes('tag') || h.includes('label') || h.includes('group')) return 'tags';
  return 'skip';
}

export default function GrowthImportPage() {
  const business = useBusiness();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);

    if (!file.name.endsWith('.csv')) {
      setError('Please upload a CSV file');
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseCSV(text);
      if (parsed.length < 2) {
        setError('CSV must have a header row and at least one data row');
        return;
      }
      const [headerRow, ...dataRows] = parsed;
      setHeaders(headerRow);
      setRows(dataRows);
      setMappings(headerRow.map(guessMapping));
    };
    reader.readAsText(file);
  }

  function updateMapping(index: number, value: FieldMapping) {
    setMappings((prev) => {
      const updated = [...prev];
      updated[index] = value;
      return updated;
    });
  }

  async function handleImport() {
    setImporting(true);
    setError(null);
    setResult(null);

    try {
      // Build mapped contacts
      const contacts = rows.map((row) => {
        const contact: Record<string, string> = {};
        mappings.forEach((mapping, i) => {
          if (mapping !== 'skip' && row[i]) {
            contact[mapping] = row[i];
          }
        });
        return contact;
      });

      // Filter out rows with no phone or email
      const validContacts = contacts.filter((c) => c.phone || c.email);

      const res = await fetch('/api/growth/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          contacts: validContacts,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Import failed' }));
        throw new Error(body.error || 'Import failed');
      }

      const data = await res.json();
      setResult({
        imported: data.imported ?? 0,
        skipped: data.skipped ?? 0,
        errors: data.errors ?? 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setImporting(false);
    }
  }

  const previewRows = rows.slice(0, 5);
  const hasMappedField = mappings.some((m) => m !== 'skip');
  const hasPhoneOrEmail = mappings.includes('phone') || mappings.includes('email');

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Link href="/dashboard/growth" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            Growth
          </Link>
          <span className="text-gray-400">/</span>
          <span className="text-sm text-gray-900 dark:text-white">Import</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Import Contacts</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Upload a CSV file to import contacts into your growth engine
        </p>
        <PageHelp
          pageKey="growth-import"
          title="Contact Import"
          description="Upload a CSV file with your contacts. Map each column to the correct field, then import. Contacts must have a phone number or email."
        />
      </div>

      {/* File upload */}
      {!fileName && (
        <div
          onClick={() => fileInputRef.current?.click()}
          className="cursor-pointer rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-12 text-center hover:border-brand-500 dark:hover:border-brand-500 transition-colors"
        >
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="mt-3 text-sm font-medium text-gray-900 dark:text-white">Click to upload CSV</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">CSV files only</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Preview and mapping */}
      {fileName && headers.length > 0 && !result && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">{fileName}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{rows.length} row{rows.length !== 1 ? 's' : ''} found</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setFileName(null);
                setHeaders([]);
                setRows([]);
                setMappings([]);
                setError(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Choose different file
            </button>
          </div>

          {/* Field mapping */}
          <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Map Columns</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {headers.map((header, i) => (
                <div key={i}>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                    {header}
                  </label>
                  <select
                    value={mappings[i]}
                    onChange={(e) => updateMapping(i, e.target.value as FieldMapping)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    {FIELD_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* Preview table */}
          <div className="mb-6">
            <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Preview (first {previewRows.length} rows)</h2>
            <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    {headers.map((header, i) => (
                      <th key={i} className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        <div>{header}</div>
                        <div className={`text-[10px] font-normal ${mappings[i] === 'skip' ? 'text-gray-400' : 'text-brand-600 dark:text-brand-400'}`}>
                          {FIELD_OPTIONS.find((o) => o.value === mappings[i])?.label}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
                  {previewRows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className={`whitespace-nowrap px-3 py-2 text-sm ${mappings[ci] === 'skip' ? 'text-gray-400' : 'text-gray-900 dark:text-white'}`}>
                          {cell || '\u2014'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Import button */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={importing || !hasMappedField || !hasPhoneOrEmail}
              onClick={handleImport}
              className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {importing ? 'Importing...' : `Import ${rows.length} Contact${rows.length !== 1 ? 's' : ''}`}
            </button>
            {!hasPhoneOrEmail && hasMappedField && (
              <p className="text-sm text-amber-600 dark:text-amber-400">Map at least a Phone or Email column</p>
            )}
          </div>
        </>
      )}

      {/* Result */}
      {result && (
        <div className="mt-6 rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-6">
          <h2 className="text-lg font-semibold text-green-800 dark:text-green-200">Import Complete</h2>
          <div className="mt-3 grid grid-cols-3 gap-4">
            <div>
              <p className="text-2xl font-bold text-green-700 dark:text-green-300">{result.imported}</p>
              <p className="text-xs text-green-600 dark:text-green-400">Imported</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{result.skipped}</p>
              <p className="text-xs text-amber-600 dark:text-amber-400">Skipped</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-700 dark:text-red-300">{result.errors}</p>
              <p className="text-xs text-red-600 dark:text-red-400">Errors</p>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <Link
              href="/dashboard/growth/contacts"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
            >
              View Contacts
            </Link>
            <button
              type="button"
              onClick={() => {
                setFileName(null);
                setHeaders([]);
                setRows([]);
                setMappings([]);
                setResult(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Import More
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
