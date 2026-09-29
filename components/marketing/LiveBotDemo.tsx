'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

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
  /** If set, this step auto-follows the previous without visitor input */
  auto?: true;
  /** Delay in ms before this message appears (typing indicator shown first) */
  delay: number;
}

interface Scenario {
  id: string;
  label: string;
  icon: string;
  businessName: string;
  businessInitial: string;
  /** Opening bot greeting — always auto-shown */
  greeting: ScenarioStep;
  /** Remaining conversation steps. Each step is a bot response keyed by the
   *  visitor action that triggers it. '*' = any free-text input. */
  steps: {
    /** Which visitor action triggers this step (option text or '*' for free text) */
    trigger: string;
    /** What the visitor's message will say when this trigger fires */
    userText: string;
    /** Bot response(s) after the trigger */
    botReplies: ScenarioStep[];
  }[];
}

const SCENARIOS: Scenario[] = [
  {
    id: 'book',
    label: 'Book',
    icon: '\u{1F4C5}',
    businessName: "Bella's Salon",
    businessInitial: 'B',
    greeting: {
      from: 'bot',
      text: "Hi! Welcome to Bella's Salon \u{1F485}\n\nHow can I help you today?",
      options: ['Book Appointment', 'View Services'],
      delay: 600,
    },
    steps: [
      {
        trigger: 'Book Appointment',
        userText: 'Book Appointment',
        botReplies: [
          {
            from: 'bot',
            text: 'Which service would you like?\n\n\u{1F485} Manicure \u{2014} $35 (45 min)\n\u{1F484} Pedicure \u{2014} $50 (60 min)\n\u{2728} Gel Nails \u{2014} $60 (75 min)',
            options: ['Manicure', 'Pedicure', 'Gel Nails'],
            delay: 1200,
          },
        ],
      },
      {
        trigger: 'Manicure',
        userText: 'Manicure',
        botReplies: [
          {
            from: 'bot',
            text: 'When would you like to come in?',
            options: ['Tomorrow 2pm', 'Tomorrow 4pm', 'Saturday 10am'],
            delay: 800,
          },
        ],
      },
      {
        trigger: 'Tomorrow 2pm',
        userText: 'Tomorrow 2pm',
        botReplies: [
          {
            from: 'bot',
            text: "\u{2705} *Appointment Confirmed!*\n\n\u{1F485} Manicure\n\u{1F4C5} Tomorrow, 2:00 PM\n\u{1F550} 45 minutes\n\u{1F4B0} $35\n\u{1F511} Ref: BK-4291\n\nWe'll send you a reminder!",
            delay: 1400,
          },
        ],
      },
      // Free-text fallback for the booking scenario
      {
        trigger: '*',
        userText: '',
        botReplies: [
          {
            from: 'bot',
            text: "I can help you book! Which service would you like?",
            options: ['Manicure', 'Pedicure', 'Gel Nails'],
            delay: 1000,
          },
        ],
      },
    ],
  },
  {
    id: 'order',
    label: 'Order',
    icon: '\u{1F6D2}',
    businessName: 'Fresh Kitchen',
    businessInitial: 'F',
    greeting: {
      from: 'bot',
      text: "Welcome to Fresh Kitchen! \u{1F373}\n\nWhat would you like to order?",
      options: ['Jollof Rice', 'Fried Rice', 'View Full Menu'],
      delay: 600,
    },
    steps: [
      {
        trigger: 'Jollof Rice',
        userText: 'Jollof Rice',
        botReplies: [
          {
            from: 'bot',
            text: "Jollof Rice \u{2014} \u{20A6}2,500 \u{2705}\n\nAnything else?",
            options: ['Add Plantain \u{20A6}800', 'That\'s all'],
            delay: 1000,
          },
        ],
      },
      {
        trigger: 'Add Plantain \u{20A6}800',
        userText: 'Add Plantain',
        botReplies: [
          {
            from: 'bot',
            text: "Your order:\n\n\u{1F35A} Jollof Rice \u{2014} \u{20A6}2,500\n\u{1F34C} Plantain \u{2014} \u{20A6}800\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\u{1F4B0} Total: \u{20A6}3,300",
            options: ['Confirm Order', 'Add More'],
            delay: 1200,
          },
        ],
      },
      {
        trigger: 'Confirm Order',
        userText: 'Confirm Order',
        botReplies: [
          {
            from: 'bot',
            text: "\u{2705} *Order Placed!*\n\n\u{1F511} Ref: ORD-8134\n\u{23F0} Ready in ~30 min\n\n\u{1F4B3} Pay here \u{1F447}\npay.waaiio.com/ord/8134",
            delay: 1400,
          },
        ],
      },
      {
        trigger: '*',
        userText: '',
        botReplies: [
          {
            from: 'bot',
            text: "I can take your order! What would you like?",
            options: ['Jollof Rice', 'Fried Rice', 'View Full Menu'],
            delay: 1000,
          },
        ],
      },
    ],
  },
  {
    id: 'ticket',
    label: 'Ticket',
    icon: '\u{1F3AB}',
    businessName: 'Naija Tech Fest',
    businessInitial: 'N',
    greeting: {
      from: 'bot',
      text: "Hey! Welcome to Naija Tech Fest \u{1F680}\n\n\u{1F4C5} Dec 14-15, Lagos\n\nHow can I help?",
      options: ['Buy Tickets', 'Event Details'],
      delay: 600,
    },
    steps: [
      {
        trigger: 'Buy Tickets',
        userText: 'Buy Tickets',
        botReplies: [
          {
            from: 'bot',
            text: "How many tickets?\n\n\u{1F3AB} General Admission \u{2014} \u{20A6}15,000 each",
            options: ['1 Ticket', '2 Tickets', '3 Tickets'],
            delay: 1000,
          },
        ],
      },
      {
        trigger: '2 Tickets',
        userText: '2 Tickets',
        botReplies: [
          {
            from: 'bot',
            text: "2x General Admission\n\u{1F4B0} Total: \u{20A6}30,000\n\nConfirm purchase?",
            options: ['Confirm', 'Change Quantity'],
            delay: 1200,
          },
        ],
      },
      {
        trigger: 'Confirm',
        userText: 'Confirm',
        botReplies: [
          {
            from: 'bot',
            text: "\u{2705} *Tickets Confirmed!*\n\n\u{1F3AB} 2x General Admission\n\u{1F4C5} Saturday, Dec 14\n\u{1F511} Ref: TK-6720\n\n\u{1F4B3} Pay here \u{1F447}\npay.waaiio.com/tk/6720\n\nTickets will be sent after payment \u{2705}",
            delay: 1600,
          },
        ],
      },
      {
        trigger: '*',
        userText: '',
        botReplies: [
          {
            from: 'bot',
            text: "I can help with tickets! What would you like?",
            options: ['Buy Tickets', 'Event Details'],
            delay: 1000,
          },
        ],
      },
    ],
  },
];

export default function LiveBotDemo() {
  const [activeScenario, setActiveScenario] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scenario = SCENARIOS[activeScenario];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, typing]);

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, []);

  // Show bot response with typing indicator
  const showBotMessage = useCallback((step: ScenarioStep, onDone?: () => void) => {
    setTyping(true);
    timeoutRef.current = setTimeout(() => {
      setTyping(false);
      setMessages(prev => [...prev, { from: 'bot', text: step.text, options: step.options }]);
      if (onDone) onDone();
    }, step.delay);
  }, []);

  // Show the greeting when scenario changes
  useEffect(() => {
    setMessages([]);
    setTyping(false);
    setStepIndex(0);
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

    // Find matching step
    const step = scenario.steps[stepIndex]
      ? (scenario.steps[stepIndex].trigger === actionText || scenario.steps[stepIndex].trigger === '*')
        ? scenario.steps[stepIndex]
        : scenario.steps.find(s => s.trigger === actionText || s.trigger === '*')
      : scenario.steps.find(s => s.trigger === actionText || s.trigger === '*');

    if (!step) {
      // No matching step — show fallback
      const fallback = scenario.steps.find(s => s.trigger === '*');
      if (fallback) {
        setMessages(prev => [...prev, { from: 'user', text: actionText }]);
        showBotMessage(fallback.botReplies[0], () => setWaitingForInput(true));
      }
      return;
    }

    // Show user's message
    const userDisplay = step.trigger === '*' ? actionText : step.userText;
    setMessages(prev => [...prev, { from: 'user', text: userDisplay }]);

    // Show bot replies sequentially
    const replies = step.botReplies;
    let replyIdx = 0;

    const showNextReply = () => {
      if (replyIdx >= replies.length) {
        // Advance step index for the next interaction
        const currentIdx = scenario.steps.indexOf(step);
        if (currentIdx >= 0) setStepIndex(currentIdx + 1);
        // If the last reply has options, wait for input; otherwise conversation is done
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
  }, [waitingForInput, scenario, stepIndex, showBotMessage]);

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
    setMessages([]);
    setTyping(false);
    setStepIndex(0);
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

  return (
    <div className="mx-auto max-w-md">
      {/* Scenario tabs */}
      <div className="mb-4 flex justify-center gap-2">
        {SCENARIOS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => switchScenario(i)}
            data-testid={`scenario-tab-${s.id}`}
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

      {/* Phone frame */}
      <div className="overflow-hidden rounded-[2rem] border-4 border-white/20 bg-white shadow-2xl">
        {/* WhatsApp header */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#075E54' }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">
            {scenario.businessInitial}
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-white">{scenario.businessName}</p>
            <p className="text-xs text-green-200">online</p>
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
          className="space-y-2 overflow-y-auto p-3"
          style={{ backgroundColor: '#ECE5DD', height: '340px' }}
        >
          <AnimatePresence>
            {messages.map((entry, i) => {
              const { from, text, options: opts } = entry;
              const isLastBotMsg = from === 'bot' && i === messages.length - 1;
              return (
                <motion.div
                  key={`${activeScenario}-${i}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  className={`flex ${from === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className="max-w-[85%]">
                    <div
                      className={`whitespace-pre-line rounded-lg px-3 py-2 text-sm ${
                        from === 'user' ? 'text-gray-900' : 'bg-white text-gray-800'
                      }`}
                      style={from === 'user' ? { backgroundColor: '#DCF8C6' } : undefined}
                    >
                      {text}
                    </div>
                    {/* Tappable options — shown only on the last bot message while waiting */}
                    {isLastBotMsg && waitingForInput && opts && (
                      <div className="mt-1 space-y-1" data-testid="demo-options">
                        {opts.map((opt) => (
                          <button
                            key={opt}
                            onClick={() => handleOptionClick(opt)}
                            className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-center text-xs font-medium text-blue-600 transition hover:bg-blue-50"
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
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex justify-start"
            >
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

        {/* Free-text input — allows natural language where supported */}
        <div className="flex items-center gap-2 border-t border-gray-100 bg-gray-50 px-3 py-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleFreeText()}
            placeholder={waitingForInput ? 'Type a message...' : 'Waiting...'}
            disabled={!waitingForInput}
            data-testid="demo-input"
            className="flex-1 rounded-full bg-white px-4 py-2 text-sm outline-none disabled:opacity-50"
          />
          <button
            onClick={handleFreeText}
            disabled={!input.trim() || !waitingForInput}
            data-testid="demo-send"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-whatsapp text-white transition hover:bg-whatsapp/85 disabled:opacity-30"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-gray-400">
        This is a simulation showing how Waaiio conversations work.
      </p>
    </div>
  );
}
