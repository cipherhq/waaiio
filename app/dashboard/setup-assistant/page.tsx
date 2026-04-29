'use client';

import { useState, useRef, useEffect } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { useRouter } from 'next/navigation';

interface ServiceItem {
  name: string;
  price: number;
  duration_minutes: number;
  deposit_amount: number;
  description: string;
}

interface ProductItem {
  name: string;
  price: number;
  description: string;
  category: string;
}

interface OperatingHours {
  [day: string]: { open?: string; close?: string; closed?: boolean };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AISuggestion {
  services?: ServiceItem[];
  products?: ProductItem[];
  operating_hours?: OperatingHours;
  greeting?: string;
  capabilities?: string[];
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

export default function SetupAssistantPage() {
  const business = useBusiness();
  const router = useRouter();

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Editable preview state
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [hours, setHours] = useState<OperatingHours>({});
  const [greeting, setGreeting] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [hasSuggestion, setHasSuggestion] = useState(false);

  // Image upload state
  const [parsing, setParsing] = useState(false);
  const [imageType, setImageType] = useState<'services' | 'products'>('services');

  // Apply state
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  // Quick-start prompts — let users pick instead of typing from scratch
  const [showQuickStart, setShowQuickStart] = useState(true);

  const quickStartOptions = [
    { label: 'I offer services (appointments)', prompt: `I run a ${business.category || 'business'} called "${business.name}". I offer appointment-based services. Let me tell you what I offer and my hours.` },
    { label: 'I sell products (store/food)', prompt: `I run a ${business.category || 'business'} called "${business.name}". I sell products to customers. Let me tell you what I sell and my hours.` },
    { label: 'Both services and products', prompt: `I run a ${business.category || 'business'} called "${business.name}". I offer both services and sell products. Let me describe what I do.` },
    { label: 'Just set up my hours and greeting', prompt: `I run a ${business.category || 'business'} called "${business.name}". I just need help setting up my operating hours and bot greeting message.` },
  ];

  // Send initial greeting
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{
        role: 'assistant',
        content: `Hi! I'll help you set up your WhatsApp bot in seconds.\n\nPick an option below to get started, or just describe what your business does!`,
      }]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleQuickStart = (prompt: string) => {
    setShowQuickStart(false);
    setInput(prompt);
    // Auto-send after a tick so the input shows briefly
    setTimeout(() => {
      sendMessageWithText(prompt);
    }, 100);
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || thinking) return;
    sendMessageWithText(text);
  };

  const sendMessageWithText = async (text: string) => {
    if (!text || thinking) return;
    setShowQuickStart(false);

    const newMessages: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setThinking(true);

    try {
      const res = await fetch('/api/ai-setup/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          message: text,
          conversation_history: newMessages.slice(1), // Skip initial greeting
        }),
      });

      if (!res.ok) throw new Error('Failed');

      const data = await res.json();
      setMessages([...newMessages, { role: 'assistant', content: data.reply }]);

      // If AI returned structured suggestions, populate preview
      if (data.suggestion) {
        applySuggestion(data.suggestion);
      }
    } catch {
      setMessages([...newMessages, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }]);
    }
    setThinking(false);
  };

  const applySuggestion = (s: AISuggestion) => {
    if (s.services?.length) {
      setServices(s.services.map(svc => ({
        name: svc.name || '',
        price: svc.price || 0,
        duration_minutes: svc.duration_minutes || 30,
        deposit_amount: svc.deposit_amount || 0,
        description: svc.description || '',
      })));
    }
    if (s.products?.length) {
      setProducts(s.products.map(p => ({
        name: p.name || '',
        price: p.price || 0,
        description: p.description || '',
        category: p.category || '',
      })));
    }
    if (s.operating_hours) setHours(s.operating_hours);
    if (s.greeting) setGreeting(s.greeting);
    if (s.capabilities?.length) setCapabilities(s.capabilities);
    setHasSuggestion(true);
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setParsing(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('business_id', business.id);
    formData.append('type', imageType);

    try {
      const res = await fetch('/api/ai-setup/parse-image', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Failed');

      const data = await res.json();
      const items = data.items || [];

      if (items.length === 0) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: "I couldn't find any items with prices in that image. Try a clearer photo of your menu or price list, or just describe your services in the chat.",
        }]);
      } else {
        if (data.type === 'services' || imageType === 'services') {
          setServices(prev => [...prev, ...items.map((item: Record<string, unknown>) => ({
            name: (item.name as string) || '',
            price: (item.price as number) || 0,
            duration_minutes: (item.duration_minutes as number) || 30,
            deposit_amount: 0,
            description: (item.description as string) || '',
          }))]);
        } else {
          setProducts(prev => [...prev, ...items.map((item: Record<string, unknown>) => ({
            name: (item.name as string) || '',
            price: (item.price as number) || 0,
            description: (item.description as string) || '',
            category: (item.category as string) || '',
          }))]);
        }
        setHasSuggestion(true);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `I found ${items.length} item${items.length !== 1 ? 's' : ''} in your image! Check the preview panel on the right — you can edit names, prices, or remove anything that's not right.`,
        }]);
      }
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, I had trouble reading that image. Please try another photo or describe your items in the chat.',
      }]);
    }
    setParsing(false);
    // Reset input
    e.target.value = '';
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const payload: Record<string, unknown> = { business_id: business.id };
      if (services.length > 0) payload.services = services.filter(s => s.name.trim());
      if (products.length > 0) payload.products = products.filter(p => p.name.trim());
      if (Object.keys(hours).length > 0) payload.operating_hours = hours;
      if (greeting.trim()) payload.greeting = greeting.trim();
      if (capabilities.length > 0) payload.capabilities = capabilities;

      const res = await fetch('/api/ai-setup/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('Failed');

      setApplied(true);
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Something went wrong applying your setup. Please try again.',
      }]);
    }
    setApplying(false);
  };

  // ── Applied success ──
  if (applied) {
    const totalItems = services.filter(s => s.name.trim()).length + products.filter(p => p.name.trim()).length;
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Setup Complete!</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-1">
            Created {totalItems} item{totalItems !== 1 ? 's' : ''}
            {Object.keys(hours).length > 0 ? ', set operating hours' : ''}
            {greeting ? ', and configured your bot greeting' : ''}.
          </p>
          <p className="text-sm text-gray-400 mb-6">Your WhatsApp bot is ready to go.</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => router.push('/dashboard/services')}
              className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800"
            >
              View Services
            </button>
            <button
              onClick={() => router.push('/dashboard')}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  const totalItems = services.filter(s => s.name.trim()).length + products.filter(p => p.name.trim()).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">AI Setup Assistant</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Describe your business or upload a menu — AI will set everything up for you.</p>
        </div>
        <button
          onClick={() => router.push('/dashboard')}
          className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        >
          Skip for now
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Left: Chat + Image Upload ── */}
        <div className="space-y-3">
          {/* Chat */}
          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 flex flex-col" style={{ height: '460px' }}>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-black text-white dark:bg-white dark:text-black'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {/* Quick-start buttons */}
              {showQuickStart && !thinking && messages.length <= 1 && (
                <div className="space-y-1.5 px-1">
                  {quickStartOptions.map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => handleQuickStart(opt.prompt)}
                      className="w-full text-left px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300 transition"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
              {thinking && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl px-4 py-2.5 text-sm text-gray-500">
                    <span className="inline-flex gap-1">
                      <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                      <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                      <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="border-t border-gray-200 dark:border-gray-700 p-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                  placeholder="Describe your business..."
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                  disabled={thinking}
                />
                <button
                  onClick={sendMessage}
                  disabled={thinking || !input.trim()}
                  className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>
          </div>

          {/* Image Upload */}
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-4">
            <div className="flex items-center gap-3 mb-3">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Or upload a menu / price list</p>
              <select
                value={imageType}
                onChange={e => setImageType(e.target.value as 'services' | 'products')}
                className="text-xs border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
              >
                <option value="services">As services</option>
                <option value="products">As products</option>
              </select>
            </div>
            <label className="flex items-center justify-center gap-2 cursor-pointer rounded-lg border border-gray-200 dark:border-gray-600 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition">
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
                disabled={parsing}
              />
              {parsing ? (
                <span className="text-sm text-gray-500">Reading image...</span>
              ) : (
                <>
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span className="text-sm text-gray-500">Click to upload photo</span>
                </>
              )}
            </label>
          </div>
        </div>

        {/* ── Right: Editable Preview ── */}
        <div className="space-y-3">
          {!hasSuggestion ? (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-8 text-center" style={{ height: '460px' }}>
              <div className="flex flex-col items-center justify-center h-full">
                <div className="text-4xl mb-3 opacity-50">✨</div>
                <h3 className="text-lg font-medium text-gray-400 dark:text-gray-500">Preview</h3>
                <p className="text-sm text-gray-400 dark:text-gray-500 mt-1 max-w-[260px]">
                  Describe your business in the chat or upload a photo — AI will fill this in for you to review.
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-y-auto" style={{ maxHeight: '560px' }}>
              {/* Services */}
              {services.length > 0 && (
                <div className="p-4 border-b border-gray-100 dark:border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Services ({services.length})</h3>
                    <button
                      onClick={() => setServices([...services, { name: '', price: 0, duration_minutes: 30, deposit_amount: 0, description: '' }])}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      + Add
                    </button>
                  </div>
                  <div className="space-y-2">
                    {services.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          value={s.name}
                          onChange={e => { const c = [...services]; c[i] = { ...c[i], name: e.target.value }; setServices(c); }}
                          placeholder="Service name"
                          className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                        />
                        <input
                          type="number"
                          value={s.price}
                          onChange={e => { const c = [...services]; c[i] = { ...c[i], price: Number(e.target.value) }; setServices(c); }}
                          className="w-20 text-sm border border-gray-200 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                          placeholder="Price"
                        />
                        <input
                          type="number"
                          value={s.duration_minutes}
                          onChange={e => { const c = [...services]; c[i] = { ...c[i], duration_minutes: Number(e.target.value) }; setServices(c); }}
                          className="w-16 text-sm border border-gray-200 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                          placeholder="Min"
                          title="Duration (minutes)"
                        />
                        <button onClick={() => setServices(services.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Products */}
              {products.length > 0 && (
                <div className="p-4 border-b border-gray-100 dark:border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Products ({products.length})</h3>
                    <button
                      onClick={() => setProducts([...products, { name: '', price: 0, description: '', category: '' }])}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      + Add
                    </button>
                  </div>
                  <div className="space-y-2">
                    {products.map((p, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          value={p.name}
                          onChange={e => { const c = [...products]; c[i] = { ...c[i], name: e.target.value }; setProducts(c); }}
                          placeholder="Product name"
                          className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                        />
                        <input
                          type="number"
                          value={p.price}
                          onChange={e => { const c = [...products]; c[i] = { ...c[i], price: Number(e.target.value) }; setProducts(c); }}
                          className="w-20 text-sm border border-gray-200 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                          placeholder="Price"
                        />
                        <button onClick={() => setProducts(products.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Operating Hours */}
              {Object.keys(hours).length > 0 && (
                <div className="p-4 border-b border-gray-100 dark:border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Operating Hours</h3>
                  <div className="space-y-1.5">
                    {DAYS.map(day => {
                      const h = hours[day] || {};
                      const isClosed = h.closed === true;
                      return (
                        <div key={day} className="flex items-center gap-2">
                          <span className="w-10 text-xs font-medium text-gray-500 uppercase">{DAY_LABELS[day]}</span>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!isClosed}
                              onChange={e => {
                                const copy = { ...hours };
                                copy[day] = e.target.checked ? { open: '09:00', close: '17:00' } : { closed: true };
                                setHours(copy);
                              }}
                              className="rounded"
                            />
                          </label>
                          {!isClosed ? (
                            <>
                              <input
                                type="time"
                                value={h.open || '09:00'}
                                onChange={e => { const copy = { ...hours }; copy[day] = { ...copy[day], open: e.target.value }; setHours(copy); }}
                                className="text-xs border border-gray-200 rounded px-1.5 py-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                              />
                              <span className="text-xs text-gray-400">to</span>
                              <input
                                type="time"
                                value={h.close || '17:00'}
                                onChange={e => { const copy = { ...hours }; copy[day] = { ...copy[day], close: e.target.value }; setHours(copy); }}
                                className="text-xs border border-gray-200 rounded px-1.5 py-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                              />
                            </>
                          ) : (
                            <span className="text-xs text-gray-400">Closed</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Bot Greeting */}
              {greeting && (
                <div className="p-4 border-b border-gray-100 dark:border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Bot Greeting</h3>
                  <textarea
                    value={greeting}
                    onChange={e => setGreeting(e.target.value)}
                    rows={2}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                  />
                </div>
              )}
            </div>
          )}

          {/* Confirm Button */}
          {hasSuggestion && (
            <div className="rounded-lg border border-blue-100 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-900/20 p-4">
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
                Does this look right? Edit anything above, then confirm when ready.
              </p>
              <p className="text-xs text-gray-500 mb-3">
                Will create: {services.filter(s => s.name.trim()).length > 0 && `${services.filter(s => s.name.trim()).length} service${services.filter(s => s.name.trim()).length !== 1 ? 's' : ''}`}
                {products.filter(p => p.name.trim()).length > 0 && `${services.length > 0 ? ', ' : ''}${products.filter(p => p.name.trim()).length} product${products.filter(p => p.name.trim()).length !== 1 ? 's' : ''}`}
                {Object.keys(hours).length > 0 && ', set hours'}
                {greeting && ', update greeting'}
              </p>
              <button
                onClick={handleApply}
                disabled={applying || totalItems === 0}
                className="w-full py-2.5 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {applying ? 'Setting up...' : `Looks good — create ${totalItems} item${totalItems !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
