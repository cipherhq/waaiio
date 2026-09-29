'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Message {
  from: 'user' | 'bot';
  text: string;
  buttons?: string[];
}

interface ScenarioTurn {
  from: 'user' | 'bot';
  text: string;
  buttons?: string[];
  /** Delay in ms before this message appears */
  delay: number;
}

interface Scenario {
  id: string;
  label: string;
  icon: string;
  businessName: string;
  businessInitial: string;
  turns: ScenarioTurn[];
}

const SCENARIOS: Scenario[] = [
  {
    id: 'book',
    label: 'Book',
    icon: '\u{1F4C5}',
    businessName: "Bella's Salon",
    businessInitial: 'B',
    turns: [
      { from: 'bot', text: "Hi! Welcome to Bella's Salon \u{1F485}\n\nHow can I help you today?", buttons: ['Book Appointment', 'View Services', 'My Bookings'], delay: 600 },
      { from: 'user', text: 'I need a manicure tomorrow 2pm', delay: 1200 },
      { from: 'bot', text: "Got it! Checking availability for *Manicure* tomorrow at *2:00 PM*... \u{2728}", delay: 1400 },
      { from: 'bot', text: "\u{2705} *Appointment Confirmed!*\n\n\u{1F485} Manicure\n\u{1F4C5} Tomorrow, 2:00 PM\n\u{1F550} 45 minutes\n\u{1F4B0} $35\n\u{1F511} Ref: BK-4291\n\n\u{1F4A1} Type *my bookings* to manage", delay: 2000 },
    ],
  },
  {
    id: 'order',
    label: 'Order',
    icon: '\u{1F6D2}',
    businessName: 'Fresh Kitchen',
    businessInitial: 'F',
    turns: [
      { from: 'bot', text: "Welcome to Fresh Kitchen! \u{1F373}\n\nWhat would you like to order?", buttons: ['View Menu', 'My Orders', 'Delivery Info'], delay: 600 },
      { from: 'user', text: 'I want jollof rice and plantain', delay: 1200 },
      { from: 'bot', text: "Great choices! Here's your order:\n\n\u{1F35A} Jollof Rice \u{2014} \u{20A6}2,500\n\u{1F34C} Fried Plantain \u{2014} \u{20A6}800\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\n\u{1F4B0} Total: \u{20A6}3,300\n\nConfirm order?", buttons: ['Confirm Order', 'Add More Items'], delay: 1800 },
      { from: 'user', text: 'Confirm Order', delay: 1200 },
      { from: 'bot', text: "\u{2705} *Order Placed!*\n\n\u{1F511} Ref: ORD-8134\n\u{23F0} Ready in ~30 minutes\n\n\u{1F4B3} Pay here \u{1F447}\npay.waaiio.com/ord/8134\n\n\u{1F4A1} Type *my orders* to track", delay: 1600 },
    ],
  },
  {
    id: 'ticket',
    label: 'Ticket',
    icon: '\u{1F3AB}',
    businessName: 'Naija Tech Fest',
    businessInitial: 'N',
    turns: [
      { from: 'bot', text: "Hey! Welcome to Naija Tech Fest \u{1F680}\n\n\u{1F4C5} Dec 14-15, Lagos\n\nHow can I help?", buttons: ['Buy Tickets', 'Event Details', 'My Tickets'], delay: 600 },
      { from: 'user', text: '2 tickets for Saturday', delay: 1200 },
      { from: 'bot', text: "Saturday, Dec 14 \u{2014} 2 tickets\n\n\u{1F3AB} General Admission \u{2014} \u{20A6}15,000 each\n\u{1F4B0} Total: \u{20A6}30,000\n\nConfirm purchase?", buttons: ['Confirm', 'Change Quantity'], delay: 1600 },
      { from: 'user', text: 'Confirm', delay: 1000 },
      { from: 'bot', text: "\u{2705} *Tickets Confirmed!*\n\n\u{1F3AB} 2x General Admission\n\u{1F4C5} Saturday, Dec 14\n\u{1F511} Ref: TK-6720\n\n\u{1F4B3} Pay here \u{1F447}\npay.waaiio.com/tk/6720\n\nTickets will be sent after payment \u{2705}", delay: 1800 },
    ],
  },
];

export default function LiveBotDemo() {
  const [activeScenario, setActiveScenario] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [playIndex, setPlayIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scenario = SCENARIOS[activeScenario];

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, typing]);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const playNextTurn = useCallback((index: number, scenarioData: Scenario) => {
    if (index >= scenarioData.turns.length) {
      setIsPlaying(false);
      setTyping(false);
      return;
    }

    const turn = scenarioData.turns[index];

    if (turn.from === 'bot') {
      // Show typing indicator first
      setTyping(true);
      timeoutRef.current = setTimeout(() => {
        setTyping(false);
        setMessages(prev => [...prev, { from: turn.from, text: turn.text, buttons: turn.buttons }]);
        setPlayIndex(index + 1);
        // Schedule next turn
        timeoutRef.current = setTimeout(() => {
          playNextTurn(index + 1, scenarioData);
        }, 400);
      }, turn.delay);
    } else {
      // User messages appear after a pause
      timeoutRef.current = setTimeout(() => {
        setMessages(prev => [...prev, { from: turn.from, text: turn.text }]);
        setPlayIndex(index + 1);
        // Schedule next turn
        timeoutRef.current = setTimeout(() => {
          playNextTurn(index + 1, scenarioData);
        }, 400);
      }, turn.delay);
    }
  }, []);

  // Start playing when scenario changes
  useEffect(() => {
    // Reset state
    setMessages([]);
    setTyping(false);
    setPlayIndex(0);
    setIsPlaying(true);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    // Start first turn after a brief pause
    const s = SCENARIOS[activeScenario];
    timeoutRef.current = setTimeout(() => {
      playNextTurn(0, s);
    }, 300);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [activeScenario, playNextTurn]);

  function handleButtonClick(buttonText: string) {
    // If conversation is still auto-playing, ignore
    if (isPlaying) return;

    // If there are remaining turns that match this button, resume
    const nextIndex = playIndex;
    if (nextIndex < scenario.turns.length) {
      // Simulate user tapping the button
      setMessages(prev => [...prev, { from: 'user', text: buttonText }]);
      setIsPlaying(true);
      // Continue from the next turn
      timeoutRef.current = setTimeout(() => {
        playNextTurn(nextIndex, scenario);
      }, 400);
    }
  }

  function handleReset() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setMessages([]);
    setTyping(false);
    setPlayIndex(0);
    setIsPlaying(true);

    const s = SCENARIOS[activeScenario];
    timeoutRef.current = setTimeout(() => {
      playNextTurn(0, s);
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
              const { from, text, buttons: actions } = entry;
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
                  {/* Show tappable buttons after auto-play finishes */}
                  {!isPlaying && actions && (
                    <div className="mt-1 space-y-1">
                      {actions.map((btn) => (
                        <button
                          key={btn}
                          onClick={() => handleButtonClick(btn)}
                          className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-center text-xs font-medium text-blue-600 transition hover:bg-blue-50"
                        >
                          {btn}
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
                  <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '0ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '150ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-gray-400">
        This is a simulation showing how Waaiio conversations work.
      </p>
    </div>
  );
}
