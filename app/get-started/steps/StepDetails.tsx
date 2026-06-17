'use client';

import React from 'react';
import { PhoneInput } from '@/components/auth/PhoneInput';
import AddressAutocomplete from '@/components/ui/AddressAutocomplete';
import { formatCurrency } from '@/lib/constants';
import type { StepDetailsProps } from './types';

export function StepDetails({
  firstName,
  setFirstName,
  lastName,
  setLastName,
  name,
  handleNameChange,
  nameCheckStatus,
  customBotCode,
  handleBotCodeChange,
  botCodeStatus,
  suggestedBotCode,
  address,
  setAddress,
  city,
  setCity,
  state,
  setState,
  zipCode,
  setZipCode,
  businessPhone,
  setBusinessPhone,
  selectedCountry,
  selectedPlan,
  waMethod,
  setWaMethod,
  ownPhone,
  setOwnPhone,
  fbConnecting,
  setFbConnecting,
  fbConnected,
  setFbConnected,
  fbSdkReady,
  fbConnectionData,
  setFbConnectionData,
  discoveredWabas,
  setDiscoveredWabas,
  agreedToTerms,
  setAgreedToTerms,
  agreedToDataProcessing,
  setAgreedToDataProcessing,
  loading,
  error,
  category,
  categoryInfo,
  localTiers,
  launchWhatsAppSignup,
  handleRegister,
  setStep,
}: StepDetailsProps) {
  return (
    <form onSubmit={handleRegister}>
      <h2 className="text-2xl font-bold text-gray-900">{categoryInfo ? `${categoryInfo.label} Details` : 'Business Details'}</h2>
      <p className="mt-1 text-sm text-gray-500">Tell us about your {categoryInfo?.label.toLowerCase() || 'business'}</p>
      <div className="mt-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">First Name *</label>
            <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)}
              placeholder="e.g. Ayodeji"
              className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Last Name *</label>
            <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)}
              placeholder="e.g. Ogunleye"
              className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">{categoryInfo?.label || 'Name or Brand'} *</label>
          <input type="text" value={name} onChange={(e) => handleNameChange(e.target.value)}
            placeholder={category === 'events' ? 'e.g. Your Name or Brand' : category === 'restaurant' ? 'e.g. Bukka Hut & Grill' : category === 'barber' ? "e.g. King's Cuts" : 'e.g. Your Business Name'}
            className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
          {nameCheckStatus === 'checking' && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
              Checking availability...
            </p>
          )}
          {nameCheckStatus === 'available' && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-green-600">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              Available
            </p>
          )}
          {nameCheckStatus === 'taken' && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-600">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              Name taken, will be adjusted automatically
            </p>
          )}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Your WhatsApp Name *</label>
          <p className="mb-2 text-xs text-gray-500">
            This is the name people will text to the Waaiio WhatsApp number to find and interact with you.
            It also appears in your WhatsApp link. Pick something short, memorable, and easy to spell.
          </p>
          <input
            type="text"
            value={customBotCode}
            onChange={(e) => handleBotCodeChange(e.target.value)}
            placeholder="e.g. LOLAH-BEAUTY"
            className="w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm uppercase outline-none focus:border-brand focus:ring-2 focus:ring-brand-100"
            required
          />
          {botCodeStatus === 'checking' && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
              Checking availability...
            </p>
          )}
          {botCodeStatus === 'available' && customBotCode.length >= 2 && (
            <div className="mt-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-green-700">
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Available!
              </p>
              <p className="mt-1 text-xs text-green-600">
                Customers will text <strong>&quot;{customBotCode}&quot;</strong> to the Waaiio WhatsApp number to reach your business.
              </p>
            </div>
          )}
          {botCodeStatus === 'taken' && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-red-600">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              Already taken. Try something different like &quot;{suggestedBotCode ? suggestedBotCode + '-' + (name.split(' ')[name.split(' ').length - 1]?.toUpperCase().slice(0, 4) || 'BIZ') : 'YOUR-CODE'}&quot;
            </p>
          )}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Address *</label>
          <AddressAutocomplete
            defaultValue={address}
            countryCode={selectedCountry}
            onSelect={(result) => {
              setAddress(result.address);
              setCity(result.city);
              setState(result.state);
              setZipCode(result.zipCode);
            }}
            onManualChange={(val) => setAddress(val)}
          />
          <p className="mt-1 text-xs text-gray-400">Start typing to search — city, state, and zip will auto-fill</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">City *</label>
            <input type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" required />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">State</label>
            <input type="text" value={state} onChange={(e) => setState(e.target.value)} placeholder="State / Province" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Zip Code</label>
            <input type="text" value={zipCode} onChange={(e) => setZipCode(e.target.value)} placeholder="Zip / Postal" className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100" />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Phone *</label>
          <PhoneInput value={businessPhone} onChange={setBusinessPhone} />
        </div>
      </div>
      {/* WhatsApp Connection (Pro/Premium only) */}
      {selectedPlan !== 'free' && (
        <div className="mt-8 rounded-2xl border border-gray-200 bg-gray-50 p-5">
          <h3 className="text-sm font-bold text-gray-900">WhatsApp Connection</h3>
          <p className="mt-1 text-xs text-gray-500">As a {selectedPlan === 'growth' ? 'Pro' : 'Premium'} user, you can connect your own WhatsApp number.</p>
          <div className="mt-4 space-y-2">
            <button type="button" onClick={() => setWaMethod('shared')} className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition ${waMethod === 'shared' ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'}`}>
              <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${waMethod === 'shared' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
                {waMethod === 'shared' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Use Waaiio&apos;s shared number</p>
                <p className="text-xs text-gray-500">Get started instantly — no setup needed</p>
              </div>
            </button>
            <button type="button" onClick={() => setWaMethod('transfer')} className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition ${waMethod !== 'shared' ? 'border-brand bg-brand-50/50' : 'border-gray-200 hover:border-gray-300'}`}>
              <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${waMethod !== 'shared' ? 'border-brand bg-brand' : 'border-gray-300'}`}>
                {waMethod !== 'shared' && <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Connect my own WhatsApp number</p>
                <p className="text-xs text-gray-500">Use your existing business or personal number</p>
              </div>
            </button>
          </div>
          {waMethod !== 'shared' && (
            <div className="mt-4 space-y-4">
              {/* Facebook Embedded Signup */}
              {!fbConnected ? (
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1877F2]">
                      <svg className="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-gray-900">Connect with Facebook</h4>
                      <p className="text-xs text-gray-500">Link your WhatsApp Business Account</p>
                    </div>
                  </div>
                  {fbConnecting ? (
                    <div className="flex flex-col items-center py-4">
                      <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                      <p className="mt-3 text-xs text-gray-500">Complete the signup in the popup...</p>
                      <button type="button" onClick={() => setFbConnecting(false)} className="mt-2 text-xs text-gray-400 hover:text-brand underline">Cancel</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={launchWhatsAppSignup}
                      disabled={!fbSdkReady}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1877F2] py-3 text-sm font-bold text-white transition hover:bg-[#166FE5] disabled:opacity-50"
                    >
                      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                      </svg>
                      {fbSdkReady ? 'Connect with Facebook' : 'Loading Facebook...'}
                    </button>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border-2 border-green-200 bg-green-50 p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-green-100">
                      <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-green-900">Facebook Connected</h4>
                      <p className="text-xs text-green-700">{discoveredWabas[0]?.waba_name || 'WhatsApp Business Account linked'}</p>
                    </div>
                    <button type="button" onClick={() => { setFbConnected(false); setFbConnectionData(null); setDiscoveredWabas([]); }} className="ml-auto text-xs text-green-600 hover:underline">Reconnect</button>
                  </div>
                </div>
              )}

              {/* Phone number + Display name */}
              <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">WhatsApp Phone Number *</label>
                  <PhoneInput value={ownPhone} onChange={setOwnPhone} countryCode={selectedCountry} />
                  <p className="mt-1 text-xs text-gray-400">The number you want to use with Waaiio</p>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-gray-700">WhatsApp Display Name</label>
                  <input
                    type="text"
                    value={fbConnectionData?.display_name || ''}
                    onChange={(e) => setFbConnectionData(prev => prev ? { ...prev, display_name: e.target.value } : { waba_id: '', phone_number_id: '', access_token: '', token_expires_at: '', display_name: e.target.value })}
                    placeholder={name || 'Your business name on WhatsApp'}
                    className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100"
                  />
                </div>
              </div>

              <p className="text-xs text-gray-400 text-center">You can also set this up later from your dashboard settings.</p>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {/* Terms & Conditions */}
      <label className="mt-6 flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={agreedToTerms}
          onChange={e => setAgreedToTerms(e.target.checked)}
          className="mt-0.5 rounded border-gray-300"
          required
        />
        <span className="text-xs text-gray-500 leading-relaxed">
          I agree to Waaiio&apos;s{' '}
          <a href="/terms" target="_blank" className="text-brand underline hover:text-brand-600">Terms of Service</a>.
        </span>
      </label>

      {/* Data Processing Consent (GDPR — separate from Terms) */}
      <label className="mt-3 flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={agreedToDataProcessing}
          onChange={e => setAgreedToDataProcessing(e.target.checked)}
          className="mt-0.5 rounded border-gray-300"
          required
        />
        <span className="text-xs text-gray-500 leading-relaxed">
          I consent to Waaiio processing my business and customer data as described in the{' '}
          <a href="/privacy" target="_blank" className="text-brand underline hover:text-brand-600">Privacy Policy</a>.
        </span>
      </label>

      <div className="mt-4 flex gap-3">
        <button type="button" onClick={() => setStep('category')} className="rounded-xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50">Back</button>
        <button type="submit" disabled={loading || !agreedToTerms || !agreedToDataProcessing || !firstName || !lastName || !name || !city || !address || !businessPhone || !customBotCode || customBotCode.length < 2 || botCodeStatus === 'taken'} className={`flex-1 rounded-xl py-3.5 text-sm font-bold transition disabled:opacity-50 ${selectedPlan === 'free' ? 'bg-brand text-white hover:bg-brand-600' : 'bg-accent text-gray-900 shadow-lg shadow-accent/20 hover:bg-accent-400'}`}>
          {loading ? 'Setting up...' : selectedPlan === 'free' ? 'Start Free Trial' : `Pay ${formatCurrency(localTiers[selectedPlan]?.price as number || 0, selectedCountry)}/mo & Launch`}
        </button>
      </div>
    </form>
  );
}
