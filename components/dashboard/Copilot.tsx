'use client';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useBusiness, useCapabilities } from './DashboardProvider';

interface CopilotMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface FollowUpContext {
  lastReport?: string;
  lastPeriod?: string;
}

/** Build capability-aware quick questions */
function useQuickQuestions() {
  const { hasCapability } = useCapabilities();
  return useMemo(() => {
    const questions: string[] = [];
    if (hasCapability('appointment') || hasCapability('scheduling'))
      questions.push('How many bookings today?', 'Any upcoming appointments?');
    if (hasCapability('ordering'))
      questions.push('Any pending orders?', 'What are my top products?');
    if (hasCapability('payment'))
      questions.push("What's my revenue this week?", 'Any unpaid bookings?');
    if (hasCapability('invoice'))
      questions.push('Any unpaid invoices?');
    if (hasCapability('ordering'))
      questions.push('Any products low on stock?');
    questions.push('Anything needing attention?');
    // Cap at 6 to keep it digestible
    return questions.slice(0, 6);
  }, [hasCapability]);
}

export function Copilot() {
  const business = useBusiness();
  const quickQuestions = useQuickQuestions();
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [context, setContext] = useState<FollowUpContext>({});
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function handleSend(question?: string) {
    const q = (question || input).trim();
    if (!q || loading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: q, timestamp: new Date() }]);
    setLoading(true);

    try {
      const res = await fetch('/api/copilot/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, business_id: business.id, context }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.answer || 'I could not find an answer to that question.',
        timestamp: new Date(),
      }]);
      if (data.context) setContext(data.context);
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Something went wrong. Please try again.',
        timestamp: new Date(),
      }]);
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lg hover:bg-brand-600 transition"
        title="Ask Ace AI"
      >
        <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col rounded-2xl border border-gray-200 bg-white shadow-2xl" style={{ height: 500, maxHeight: 'calc(100vh - 6rem)' }}>
      {/* Header */}
      <div className="flex items-center justify-between rounded-t-2xl bg-brand px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">&#10024;</span>
          <div>
            <span className="text-sm font-bold text-white">Ace AI</span>
            <span className="ml-2 text-xs text-white/60">Business Reports</span>
          </div>
        </div>
        <button onClick={() => setIsOpen(false)} className="text-white/70 hover:text-white">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-sm mt-4">
            <p className="text-center text-2xl mb-2">&#10024;</p>
            <p className="text-center font-medium text-gray-600">
              Quick answers about your bookings, orders, customers, payments, and performance.
            </p>
            <div className="mt-4 space-y-1.5">
              {quickQuestions.map((q) => (
                <button
                  key={q}
                  onClick={() => handleSend(q)}
                  className="block w-full text-left rounded-lg border border-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 hover:border-brand/30 transition"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-line ${
              msg.role === 'user'
                ? 'bg-brand text-white'
                : 'bg-gray-100 text-gray-800'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-400">
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-100 px-3 py-3">
        <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about bookings, revenue, orders..."
            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="rounded-lg bg-brand px-3 py-2 text-white disabled:opacity-50"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
