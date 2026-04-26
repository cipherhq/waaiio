'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Message {
  from: 'user' | 'bot';
  text: string;
  buttons?: string[];
}

const DEMO_RESPONSES: Record<string, { text: string; buttons?: string[] }> = {
  // Greetings
  'hi': { text: "Welcome to King's Cuts! 💈\n\nWhat would you like to do?", buttons: ['Book Appointment', 'View Services', 'My Bookings'] },
  'hello': { text: "Welcome to King's Cuts! 💈\n\nWhat would you like to do?", buttons: ['Book Appointment', 'View Services', 'My Bookings'] },
  'hey': { text: "Welcome to King's Cuts! 💈\n\nWhat would you like to do?", buttons: ['Book Appointment', 'View Services', 'My Bookings'] },

  // Booking intent
  'book appointment': { text: "Great! What service would you like?\n\n1. Haircut — $30\n2. Beard Trim — $15\n3. Full Grooming — $50" },
  'book': { text: "Great! What service would you like?\n\n1. Haircut — $30\n2. Beard Trim — $15\n3. Full Grooming — $50" },
  '1': { text: "Haircut — $30 ✂️\n\nWhen would you like to come in?" },
  '2': { text: "Beard Trim — $15 🪒\n\nWhen would you like to come in?" },
  '3': { text: "Full Grooming — $50 💈\n\nWhen would you like to come in?" },
  'haircut': { text: "Haircut — $30 ✂️\n\nWhen would you like to come in?" },

  // Natural language
  'i wan barb tomorrow 3pm': { text: "Got it! Looking up *Haircut* for *tomorrow* at *3:00 PM*... ✨\n\n✅ *Appointment Confirmed!*\n\n💈 Haircut\n📅 Tomorrow, 3:00 PM\n🔑 Ref: BK-7291\n\n💡 Type *my bookings* to view appointments" },
  'i want a haircut tomorrow at 3pm': { text: "Got it! Looking up *Haircut* for *tomorrow* at *3:00 PM*... ✨\n\n✅ *Appointment Confirmed!*\n\n💈 Haircut\n📅 Tomorrow, 3:00 PM\n🔑 Ref: BK-7291\n\n💡 Type *my bookings* to view appointments" },
  'tomorrow 3pm': { text: "✅ *Appointment Confirmed!*\n\n💈 Haircut\n📅 Tomorrow, 3:00 PM\n📍 King's Cuts\n🔑 Ref: BK-7291\n\n💳 Pay here 👇\npay.waaiio.com/bk/7291\n\n💡 Type *reschedule* to change time" },
  'tomorrow 2pm': { text: "✅ *Appointment Confirmed!*\n\n💈 Haircut\n📅 Tomorrow, 2:00 PM\n📍 King's Cuts\n🔑 Ref: BK-4821\n\n💳 Pay here 👇\npay.waaiio.com/bk/4821\n\n💡 Type *reschedule* to change time" },

  // Services
  'view services': { text: "Here are our services:\n\n✂️ *Haircut* — $30 (30 min)\n🪒 *Beard Trim* — $15 (15 min)\n💈 *Full Grooming* — $50 (45 min)\n\nWhich one would you like?" },
  'services': { text: "Here are our services:\n\n✂️ *Haircut* — $30 (30 min)\n🪒 *Beard Trim* — $15 (15 min)\n💈 *Full Grooming* — $50 (45 min)\n\nWhich one would you like?" },

  // Bookings
  'my bookings': { text: "📋 *Your Upcoming Bookings:*\n\n1. 💈 Haircut\n   📅 Tomorrow, 3:00 PM\n   🔑 Ref: BK-7291\n\nType a number to manage, or *book* for a new one." },
  'reschedule': { text: "Which booking would you like to reschedule?\n\n1. 💈 Haircut — Tomorrow, 3:00 PM (BK-7291)\n\nType the number to select." },

  // Payment
  'pay tithe': { text: "How much would you like to give as tithe?" },
  '50000': { text: "✅ Tithe of ₦50,000 recorded!\n\n💳 Pay here: pay.waaiio.com/t/NLC-4821\n\n🙏 God bless you!" },

  // Fallback
  'receipt': { text: "Generating your receipt... 📄\n\n🧾 *Payment Receipt*\n\n💈 King's Cuts\n✂️ Haircut\n💰 $30.00\n📅 Today\n🔑 Ref: BK-7291\n\nThank you!" },
  'my points': { text: "🏆 *Your Loyalty Points*\n\n⭐ 150 points\n🎁 Next reward at 200 points\n\nKeep booking to earn more!" },
};

function findResponse(text: string): { text: string; buttons?: string[] } {
  const lower = text.toLowerCase().trim();

  // Exact match
  if (DEMO_RESPONSES[lower]) return DEMO_RESPONSES[lower];

  // Partial match
  for (const [key, val] of Object.entries(DEMO_RESPONSES)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }

  // AI-like fallback for booking-related text
  if (/barb|cut|trim|groom|fade|lineup/i.test(lower)) {
    return { text: "I can help you book that! When would you like to come in?" };
  }
  if (/tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(lower)) {
    return DEMO_RESPONSES['tomorrow 3pm'];
  }

  return {
    text: "I can help you with:\n\n• *Book* — Schedule an appointment\n• *Services* — View our menu\n• *My bookings* — Check your appointments\n• *Receipt* — Get your last receipt\n\nOr just tell me what you need!",
  };
}

const SUGGESTIONS = ['Hi', 'I wan barb tomorrow 3pm', 'My bookings', 'View services'];

export default function LiveBotDemo() {
  const [messages, setMessages] = useState<Message[]>([
    { from: 'bot', text: "👋 Try messaging this demo bot!\n\nType anything — like \"Hi\" or \"I wan barb tomorrow 3pm\"" },
  ]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, typing]);

  function handleSend(text?: string) {
    const msg = (text || input).trim();
    if (!msg) return;

    const userMsg: Message = { from: 'user', text: msg };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setTyping(true);

    // Simulate bot thinking
    const delay = 400 + Math.random() * 800;
    setTimeout(() => {
      const response = findResponse(msg);
      const botMsg: Message = { from: 'bot', text: response.text, buttons: response.buttons };
      setMessages(prev => [...prev, botMsg]);
      setTyping(false);
    }, delay);
  }

  return (
    <div className="mx-auto max-w-md">
      {/* Phone frame */}
      <div className="overflow-hidden rounded-[2rem] border-4 border-white/20 bg-white shadow-2xl">
        {/* WhatsApp header */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#075E54' }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">K</div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-white">King&apos;s Cuts</p>
            <p className="text-xs text-green-200">online</p>
          </div>
          <span className="rounded-full bg-green-400 px-2 py-0.5 text-[10px] font-bold text-green-900">DEMO</span>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          className="space-y-2 overflow-y-auto p-3"
          style={{ backgroundColor: '#ECE5DD', height: '320px' }}
        >
          <AnimatePresence>
            {messages.map((msg, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className={`flex ${msg.from === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className="max-w-[85%]">
                  <div
                    className={`whitespace-pre-line rounded-lg px-3 py-2 text-sm ${
                      msg.from === 'user' ? 'text-gray-900' : 'bg-white text-gray-800'
                    }`}
                    style={msg.from === 'user' ? { backgroundColor: '#DCF8C6' } : undefined}
                  >
                    {msg.text}
                  </div>
                  {msg.buttons && (
                    <div className="mt-1 space-y-1">
                      {msg.buttons.map((btn) => (
                        <button
                          key={btn}
                          onClick={() => handleSend(btn)}
                          className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-center text-xs font-medium text-blue-600 transition hover:bg-blue-50"
                        >
                          {btn}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
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

        {/* Suggestion chips */}
        <div className="flex gap-1.5 overflow-x-auto bg-gray-50 px-3 py-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => handleSend(s)}
              className="shrink-0 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600 transition hover:border-brand hover:text-brand"
            >
              {s}
            </button>
          ))}
        </div>

        {/* Input */}
        <div className="flex items-center gap-2 border-t border-gray-100 bg-gray-50 px-3 py-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
            className="flex-1 rounded-full bg-white px-4 py-2 text-sm outline-none"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#25D366] text-white transition hover:bg-[#20BD5A] disabled:opacity-30"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
