'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

interface Message {
  from: 'user' | 'bot';
  text: string;
  /** Tappable option buttons shown below a bot message */
  options?: string[];
}

interface ScenarioStep {
  from: 'bot';
  text: string;
  /** Options the visitor can tap to advance the conversation */
  options?: string[];
  /** Delay in ms before this message appears (typing indicator shown first) */
  delay: number;
}

interface Scenario {
  id: string;
  label: string;
  icon: string;
  businessName: string;
  businessInitial: string;
  description: string;
  /** Opening bot greeting — always auto-shown */
  greeting: ScenarioStep;
  /** Conversation steps keyed by trigger text. Every visible option must
   *  have a matching trigger — no dead branches allowed. */
  steps: {
    trigger: string;
    userText: string;
    botReplies: ScenarioStep[];
    selection?: Record<string, string>;
  }[];
}

// ── Scenario data — every visible option has a modeled next step ──

export const SCENARIOS: Scenario[] = [
  {
    id: 'book', label: 'Book', icon: '📅', businessName: "Bella's Salon", businessInitial: 'B',
    description: 'Choose a service, pick a date and time, then review your booking.',
    greeting: { from: 'bot', text: `Welcome to Bella's Salon!

What would you like to book?`, options: ['Manicure', 'Pedicure'], delay: 500 },
    steps: [
      { trigger: 'Manicure', userText: 'Manicure', selection: { service: 'Manicure', price: '$35', duration: '45 minutes' }, botReplies: [{ from: 'bot', text: `*{{service}}* · {{duration}} · {{price}}

Choose a date for your appointment.`, options: ['Tomorrow', 'This Saturday'], delay: 700 }] },
      { trigger: 'Pedicure', userText: 'Pedicure', selection: { service: 'Pedicure', price: '$50', duration: '60 minutes' }, botReplies: [{ from: 'bot', text: `*{{service}}* · {{duration}} · {{price}}

Choose a date for your appointment.`, options: ['Tomorrow', 'This Saturday'], delay: 700 }] },
      { trigger: 'Tomorrow', userText: 'Tomorrow', selection: { date: 'Tomorrow' }, botReplies: [{ from: 'bot', text: `Available times for {{date}}.

Which works for you?`, options: ['2:00 PM', '4:00 PM'], delay: 650 }] },
      { trigger: 'This Saturday', userText: 'This Saturday', selection: { date: 'This Saturday' }, botReplies: [{ from: 'bot', text: `Available times for {{date}}.

Which works for you?`, options: ['2:00 PM', '4:00 PM'], delay: 650 }] },
      { trigger: '2:00 PM', userText: '2:00 PM', selection: { time: '2:00 PM' }, botReplies: [{ from: 'bot', text: `*Review your booking*

{{service}} · {{duration}}
{{date}}, {{time}}
Total: {{price}}

This example requires payment to confirm.`, options: ['Confirm booking'], delay: 650 }] },
      { trigger: '4:00 PM', userText: '4:00 PM', selection: { time: '4:00 PM' }, botReplies: [{ from: 'bot', text: `*Review your booking*

{{service}} · {{duration}}
{{date}}, {{time}}
Total: {{price}}

This example requires payment to confirm.`, options: ['Confirm booking'], delay: 650 }] },
      { trigger: 'Confirm booking', userText: 'Confirm booking', botReplies: [{ from: 'bot', text: `*Payment requested*

{{price}} for {{service}}.
In a real conversation, you receive a secure payment link. Here, simulate a successful payment.`, options: ['Simulate payment'], delay: 650 }] },
      { trigger: 'Simulate payment', userText: 'Payment completed (demo)', botReplies: [{ from: 'bot', text: `*Payment received — demo*

{{price}} · Ref: DEMO-BK-4291`, delay: 650 }, { from: 'bot', text: `✓ *Appointment confirmed*

{{service}}
{{date}}, {{time}}
Bella’s Salon

No real appointment has been created.`, delay: 500 }] },
    ],
  },
  {
    id: 'order', label: 'Order', icon: '🛒', businessName: 'Fresh Kitchen', businessInitial: 'F',
    description: 'Browse the menu, choose pickup, and see payment turn into an order confirmation.',
    greeting: { from: 'bot', text: `Welcome to Fresh Kitchen!

Choose something from our menu.`, options: ['Jollof Rice', 'Fried Rice'], delay: 500 },
    steps: [
      { trigger: 'Jollof Rice', userText: 'Jollof Rice', selection: { product: 'Jollof Rice', price: '₦2,500' }, botReplies: [{ from: 'bot', text: `*{{product}}* · {{price}}

How many would you like?`, options: ['1 portion'], delay: 650 }] },
      { trigger: 'Fried Rice', userText: 'Fried Rice', selection: { product: 'Fried Rice', price: '₦2,800' }, botReplies: [{ from: 'bot', text: `*{{product}}* · {{price}}

How many would you like?`, options: ['1 portion'], delay: 650 }] },
      { trigger: '1 portion', userText: '1 portion', botReplies: [{ from: 'bot', text: `*Your cart*

1 × {{product}}
Total: {{price}}`, options: ['Checkout'], delay: 650 }] },
      { trigger: 'Checkout', userText: 'Checkout', botReplies: [{ from: 'bot', text: `How would you like to receive your order?

This demo offers pickup.`, options: ['Pickup'], delay: 500 }] },
      { trigger: 'Pickup', userText: 'Pickup', botReplies: [{ from: 'bot', text: `*Review your order*

1 × {{product}}
Pickup at Fresh Kitchen
Total: {{price}}`, options: ['Place Order'], delay: 650 }] },
      { trigger: 'Place Order', userText: 'Place Order', botReplies: [{ from: 'bot', text: `*Awaiting payment*

Your order total is {{price}}. In a real conversation, a secure link opens the payment provider.`, options: ['Simulate payment'], delay: 650 }] },
      { trigger: 'Simulate payment', userText: 'Payment completed (demo)', botReplies: [{ from: 'bot', text: `✓ *Payment received — demo*

{{price}} · Ref: DEMO-ORD-8134`, delay: 650 }, { from: 'bot', text: `*Order confirmed*

1 × {{product}}
Pickup at Fresh Kitchen

No real order has been placed.`, delay: 500 }] },
    ],
  },
  {
    id: 'ticket', label: 'Ticket', icon: '🎫', businessName: 'Naija Tech Fest', businessInitial: 'N',
    description: 'Pick your tickets, review the total, and see the confirmation after a simulated payment.',
    greeting: { from: 'bot', text: `Welcome to Naija Tech Fest!

Explore our example event in Lagos.`, options: ['Buy Tickets'], delay: 500 },
    steps: [
      { trigger: 'Buy Tickets', userText: 'Buy Tickets', botReplies: [{ from: 'bot', text: `*General Admission*
₦15,000 per ticket

How many tickets?`, options: ['1 Ticket', '2 Tickets'], delay: 650 }] },
      { trigger: '1 Ticket', userText: '1 Ticket', selection: { quantity: '1', price: '₦15,000' }, botReplies: [{ from: 'bot', text: `*Review your tickets*

{{quantity}} × General Admission
Total: {{price}}`, options: ['Confirm'], delay: 650 }] },
      { trigger: '2 Tickets', userText: '2 Tickets', selection: { quantity: '2', price: '₦30,000' }, botReplies: [{ from: 'bot', text: `*Review your tickets*

{{quantity}} × General Admission
Total: {{price}}`, options: ['Confirm'], delay: 650 }] },
      { trigger: 'Confirm', userText: 'Confirm', botReplies: [{ from: 'bot', text: `*Awaiting payment*

Total: {{price}}. Your tickets are issued after payment is verified. Try the simulated payment below.`, options: ['Simulate payment'], delay: 650 }] },
      { trigger: 'Simulate payment', userText: 'Payment completed (demo)', botReplies: [{ from: 'bot', text: `✓ *Payment received — demo*

{{price}} · Ref: DEMO-TK-6720`, delay: 650 }, { from: 'bot', text: `*Your tickets are ready*

{{quantity}} × General Admission
Naija Tech Fest · Lagos

A real purchase delivers tickets with QR codes. This demo is not a valid ticket.`, delay: 500 }] },
    ],
  },
];

// ── Component ──

export default function LiveBotDemo() {
  const prefersReducedMotion = useReducedMotion();
  const noMotion = !!prefersReducedMotion;
  const [activeScenario, setActiveScenario] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectionRef = useRef<Record<string, string>>({});
  const scenario = SCENARIOS[activeScenario];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, typing]);

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, []);

  const showBotMessage = useCallback((step: ScenarioStep, onDone?: () => void) => {
    setTyping(true);
    timeoutRef.current = setTimeout(() => {
      setTyping(false);
      setMessages(prev => [...prev, { from: 'bot', text: step.text.replace(/\{\{(\w+)\}\}/g, (_, key) => selectionRef.current[key] || ''), options: step.options }]);
      if (onDone) onDone();
    }, noMotion ? 0 : step.delay);
  }, [noMotion]);

  // Show greeting when scenario changes
  useEffect(() => {
    selectionRef.current = {};
    setMessages([]);
    setTyping(false);
    setWaitingForInput(false);
    setInput('');
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    const s = SCENARIOS[activeScenario];
    timeoutRef.current = setTimeout(() => {
      showBotMessage(s.greeting, () => setWaitingForInput(true));
    }, 300);

    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [activeScenario, showBotMessage]);

  // Process a visitor action (tapped option or typed text)
  const processAction = useCallback((actionText: string) => {
    if (!waitingForInput) return;
    setWaitingForInput(false);

    const currentOptions = messages[messages.length - 1]?.options || [];
    const choice = currentOptions.find(option => option.toLowerCase() === actionText.toLowerCase());
    const step = choice ? scenario.steps.find(s => s.trigger === choice) : undefined;
    if (!step) {
      setMessages(prev => [...prev, { from: 'user', text: actionText }]);
      showBotMessage({ from: 'bot', text: 'This interactive demo follows the choices below. Tap one to continue, or type its label.', options: currentOptions, delay: 400 }, () => setWaitingForInput(true));
      return;
    }
    selectionRef.current = { ...selectionRef.current, ...step.selection };

    // Show user's message
    setMessages(prev => [...prev, { from: 'user', text: step.userText }]);

    // Show bot replies sequentially
    const replies = step.botReplies;
    let replyIdx = 0;

    const showNextReply = () => {
      if (replyIdx >= replies.length) {
        const lastReply = replies[replies.length - 1];
        if (lastReply.options) setWaitingForInput(true);
        return;
      }
      showBotMessage(replies[replyIdx], () => {
        replyIdx++;
        showNextReply();
      });
    };
    showNextReply();
  }, [waitingForInput, scenario, showBotMessage, messages]);

  function handleOptionClick(optionText: string) {
    processAction(optionText);
  }

  function handleFreeText() {
    const trimmed = input.trim();
    if (!trimmed || !waitingForInput) return;
    setInput('');
    processAction(trimmed);
  }

  function handleReset() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    selectionRef.current = {};
    setMessages([]);
    setTyping(false);
    setWaitingForInput(false);
    setInput('');

    const s = SCENARIOS[activeScenario];
    timeoutRef.current = setTimeout(() => {
      showBotMessage(s.greeting, () => setWaitingForInput(true));
    }, 300);
  }

  function switchScenario(index: number) {
    if (index === activeScenario) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setActiveScenario(index);
  }

  // Framer Motion transition props — disabled when reduced motion is preferred
  const msgTransition = noMotion
    ? { initial: undefined, animate: undefined, transition: undefined }
    : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 } };
  const typingTransition = noMotion
    ? { initial: undefined, animate: undefined }
    : { initial: { opacity: 0 }, animate: { opacity: 1 } };

  return (
    <div className="mx-auto max-w-md">
      <p className="mb-3 text-center text-xs font-semibold uppercase tracking-[0.18em] text-brand">You’re the customer. Try a conversation.</p>
      {/* Scenario tabs */}
      <div className="mb-4 flex justify-center gap-2">
        {SCENARIOS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => switchScenario(i)}
            data-testid={`scenario-tab-${s.id}`}
            aria-pressed={activeScenario === i}
            className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition ${
              activeScenario === i
                ? 'bg-brand text-white shadow-md'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <span>{s.icon}</span>
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      <p className="mb-5 min-h-10 text-center text-sm text-gray-500">{scenario.description}</p>
      {/* Phone frame */}
      <div className="overflow-hidden rounded-[2rem] border-4 border-white/20 bg-white shadow-2xl">
        {/* WhatsApp header */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#075E54' }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">
            {scenario.businessInitial}
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-white">{scenario.businessName}</p>
            <p className="text-xs text-green-200">{typing ? 'typing…' : 'Demo business'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              data-testid="demo-reset"
              className="rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-semibold text-white transition hover:bg-white/25"
              title="Replay conversation"
            >
              Replay
            </button>
            <span className="rounded-full bg-green-400 px-2 py-0.5 text-[10px] font-bold text-green-900">DEMO</span>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          role="log" aria-label="Example WhatsApp conversation" aria-live="polite"
          className="space-y-3 overflow-y-auto overscroll-contain p-4"
          style={{ backgroundColor: '#ECE5DD', height: '400px', backgroundImage: 'radial-gradient(#d5cec5 0.7px, transparent 0.7px)', backgroundSize: '14px 14px' }}
        >
          <AnimatePresence>
            {messages.map((entry, i) => {
              const { from, text, options: opts } = entry;
              const isLastBotMsg = from === 'bot' && i === messages.length - 1;
              return (
                <motion.div
                  key={`${activeScenario}-${i}`}
                  {...msgTransition}
                  className={`flex ${from === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className="max-w-[85%]">
                    <div
                      className={`whitespace-pre-line rounded-lg px-3 py-2 text-sm ${
                        from === 'user' ? 'text-gray-900' : 'bg-white text-gray-800'
                      }`}
                      style={from === 'user' ? { backgroundColor: '#DCF8C6' } : undefined}
                    >
                      {text.split(/(\*[^*]+\*)/g).map((part, index) => part.startsWith('*') && part.endsWith('*') ? <strong key={index}>{part.slice(1, -1)}</strong> : part)}
                      <div aria-hidden="true" className="mt-1 text-right text-[10px] text-gray-400">12:{String(30 + i).padStart(2, '0')} {from === 'user' && <span className="ml-1 text-sky-600">✓✓</span>}</div>
                    </div>
                    {/* Tappable options — shown only on the last bot message while waiting */}
                    {isLastBotMsg && waitingForInput && opts && (
                      <div className="mt-1 space-y-1" data-testid="demo-options">
                        {opts.map((opt) => (
                          <button
                            key={opt}
                            onClick={() => handleOptionClick(opt)}
                            className="block min-h-11 w-full rounded-lg border border-emerald-100 bg-white px-3 py-2.5 text-center text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 active:scale-[0.98]"
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {typing && (
            <motion.div {...typingTransition} className="flex justify-start">
              <div className="rounded-lg bg-white px-4 py-2">
                <div className="flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 motion-reduce:animate-none" style={{ animationDelay: '0ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 motion-reduce:animate-none" style={{ animationDelay: '150ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 motion-reduce:animate-none" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </motion.div>
          )}
        </div>

        {/* Free-text input */}
        <div className="flex items-center gap-2 border-t border-gray-100 bg-gray-50 px-3 py-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleFreeText()}
            aria-label="Demo message"
            placeholder={waitingForInput ? 'Tap a choice or type its label' : typing ? 'Waiting for reply…' : 'Replay to try another path'}
            disabled={!waitingForInput}
            data-testid="demo-input"
            className="flex-1 rounded-full bg-white px-4 py-2 text-sm outline-none disabled:opacity-50"
          />
          <button
            onClick={handleFreeText}
            disabled={!input.trim() || !waitingForInput}
            data-testid="demo-send"
            aria-label="Send demo message"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-whatsapp text-white transition hover:bg-whatsapp/85 disabled:opacity-30"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-gray-400">
        Interactive simulation · Example businesses and prices. No messages, bookings, or payments are sent. Actual steps depend on the merchant’s settings.
      </p>
    </div>
  );
}
