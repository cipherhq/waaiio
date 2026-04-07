'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface ChatMessage {
  id: string;
  business_id: string;
  customer_phone: string;
  customer_name: string | null;
  direction: 'inbound' | 'outbound';
  message_text: string;
  is_read: boolean;
  staff_id: string | null;
  created_at: string;
}

interface Conversation {
  customer_phone: string;
  customer_name: string | null;
  last_message: string;
  last_message_at: string;
  unread_count: number;
}

function formatMessageTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;

  const diffHrs = Math.floor(diffMins / 60);
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }

  if (diffHrs < 168) {
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatBubbleTime(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function ChatPage() {
  const business = useBusiness();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Fetch all messages for this business
  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('business_id', business.id)
        .order('created_at', { ascending: true });

      setMessages(data || []);
      setLoading(false);
    }
    load();
  }, [business.id]);

  // Realtime subscription
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`chat_messages:${business.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `business_id=eq.${business.id}`,
        },
        (payload) => {
          const newMsg = payload.new as ChatMessage;
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'chat_messages',
          filter: `business_id=eq.${business.id}`,
        },
        (payload) => {
          const updated = payload.new as ChatMessage;
          setMessages((prev) =>
            prev.map((m) => (m.id === updated.id ? updated : m))
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [business.id]);

  // Scroll to bottom when messages change or conversation selected
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, selectedPhone]);

  // Build conversation list from messages
  const conversations: Conversation[] = (() => {
    const map = new Map<string, Conversation>();

    for (const msg of messages) {
      const existing = map.get(msg.customer_phone);
      if (!existing) {
        map.set(msg.customer_phone, {
          customer_phone: msg.customer_phone,
          customer_name: msg.customer_name,
          last_message: msg.message_text,
          last_message_at: msg.created_at,
          unread_count: msg.direction === 'inbound' && !msg.is_read ? 1 : 0,
        });
      } else {
        // Update with latest info
        if (new Date(msg.created_at) > new Date(existing.last_message_at)) {
          existing.last_message = msg.message_text;
          existing.last_message_at = msg.created_at;
        }
        if (msg.customer_name) {
          existing.customer_name = msg.customer_name;
        }
        if (msg.direction === 'inbound' && !msg.is_read) {
          existing.unread_count++;
        }
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
    );
  })();

  // Filter conversations by search
  const filteredConversations = searchQuery.trim()
    ? conversations.filter(
        (c) =>
          (c.customer_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.customer_phone.includes(searchQuery)
      )
    : conversations;

  // Messages for selected conversation
  const threadMessages = selectedPhone
    ? messages.filter((m) => m.customer_phone === selectedPhone)
    : [];

  // Selected conversation info
  const selectedConversation = conversations.find(
    (c) => c.customer_phone === selectedPhone
  );

  // Mark as read when selecting a conversation
  const markAsRead = useCallback(
    async (phone: string) => {
      const supabase = createClient();
      const unreadIds = messages
        .filter(
          (m) =>
            m.customer_phone === phone &&
            m.direction === 'inbound' &&
            !m.is_read
        )
        .map((m) => m.id);

      if (unreadIds.length === 0) return;

      await supabase
        .from('chat_messages')
        .update({ is_read: true })
        .in('id', unreadIds);

      setMessages((prev) =>
        prev.map((m) =>
          unreadIds.includes(m.id) ? { ...m, is_read: true } : m
        )
      );
    },
    [messages]
  );

  function handleSelectConversation(phone: string) {
    setSelectedPhone(phone);
    markAsRead(phone);
  }

  async function handleSend() {
    if (!replyText.trim() || !selectedPhone || sending) return;

    setSending(true);
    try {
      const res = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          customerPhone: selectedPhone,
          messageText: replyText.trim(),
        }),
      });

      if (res.ok) {
        setReplyText('');
      }
    } catch {
      // Silently fail - message will appear via realtime if sent
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Group thread messages by date
  function getDateLabel(dateStr: string) {
    const date = new Date(dateStr);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) return 'Today';

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // Total unread across all conversations
  const totalUnread = conversations.reduce((sum, c) => sum + c.unread_count, 0);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      {/* Header */}
      <div className="mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Chat</h1>
          {totalUnread > 0 && (
            <span className="rounded-full bg-brand px-2.5 py-0.5 text-xs font-semibold text-white">
              {totalUnread} unread
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Manage customer conversations
        </p>
      </div>

      {/* Two-panel layout */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-gray-100 bg-white">
        {/* Left panel - Conversation list */}
        <div className="flex w-80 shrink-0 flex-col border-r border-gray-100">
          {/* Search */}
          <div className="border-b border-gray-100 p-3">
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search conversations..."
                className="w-full rounded-lg border border-gray-200 py-2 pl-10 pr-3 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>

          {/* Conversation items */}
          <div className="flex-1 overflow-y-auto">
            {filteredConversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <svg
                  className="h-10 w-10 text-gray-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                <p className="mt-3 text-sm text-gray-500">
                  {searchQuery ? 'No matching conversations' : 'No conversations yet'}
                </p>
                {!searchQuery && (
                  <p className="mt-1 text-xs text-gray-400">
                    Messages from customers will appear here
                  </p>
                )}
              </div>
            ) : (
              filteredConversations.map((conv) => (
                <button
                  key={conv.customer_phone}
                  onClick={() => handleSelectConversation(conv.customer_phone)}
                  className={`flex w-full items-start gap-3 border-b border-gray-50 px-4 py-3 text-left transition hover:bg-gray-50 ${
                    selectedPhone === conv.customer_phone
                      ? 'bg-brand-50/50'
                      : ''
                  }`}
                >
                  {/* Avatar */}
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100">
                    <span className="text-sm font-semibold text-gray-500">
                      {(conv.customer_name || conv.customer_phone)
                        .charAt(0)
                        .toUpperCase()}
                    </span>
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={`truncate text-sm ${
                          conv.unread_count > 0
                            ? 'font-bold text-gray-900'
                            : 'font-medium text-gray-900'
                        }`}
                      >
                        {conv.customer_name || conv.customer_phone}
                      </p>
                      <span className="shrink-0 text-xs text-gray-400">
                        {formatMessageTime(conv.last_message_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p
                        className={`truncate text-xs ${
                          conv.unread_count > 0
                            ? 'font-medium text-gray-700'
                            : 'text-gray-500'
                        }`}
                      >
                        {conv.last_message}
                      </p>
                      {conv.unread_count > 0 && (
                        <span className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">
                          {conv.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right panel - Message thread */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!selectedPhone ? (
            // Empty state - no conversation selected
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
                <svg
                  className="h-8 w-8 text-brand"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </div>
              <h3 className="mt-4 text-sm font-semibold text-gray-900">
                Select a conversation
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                Choose a conversation from the list to view messages
              </p>
            </div>
          ) : (
            <>
              {/* Thread header */}
              <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3">
                {/* Back button for mobile - hidden on larger screens */}
                <button
                  onClick={() => setSelectedPhone(null)}
                  className="shrink-0 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 lg:hidden"
                >
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100">
                  <span className="text-sm font-semibold text-gray-500">
                    {(
                      selectedConversation?.customer_name ||
                      selectedPhone
                    )
                      .charAt(0)
                      .toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900">
                    {selectedConversation?.customer_name || selectedPhone}
                  </p>
                  {selectedConversation?.customer_name && (
                    <p className="text-xs text-gray-500">{selectedPhone}</p>
                  )}
                </div>
              </div>

              {/* Messages area */}
              <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto px-5 py-4"
              >
                {threadMessages.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-sm text-gray-400">No messages yet</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {threadMessages.map((msg, idx) => {
                      // Show date separator
                      const prevMsg = idx > 0 ? threadMessages[idx - 1] : null;
                      const showDate =
                        !prevMsg ||
                        new Date(msg.created_at).toDateString() !==
                          new Date(prevMsg.created_at).toDateString();

                      return (
                        <div key={msg.id}>
                          {showDate && (
                            <div className="my-4 flex items-center justify-center">
                              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">
                                {getDateLabel(msg.created_at)}
                              </span>
                            </div>
                          )}
                          <div
                            className={`flex ${
                              msg.direction === 'outbound'
                                ? 'justify-end'
                                : 'justify-start'
                            }`}
                          >
                            <div
                              className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                                msg.direction === 'outbound'
                                  ? 'bg-brand text-white'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                                {msg.message_text}
                              </p>
                              <p
                                className={`mt-1 text-right text-[10px] ${
                                  msg.direction === 'outbound'
                                    ? 'text-white/60'
                                    : 'text-gray-400'
                                }`}
                              >
                                {formatBubbleTime(msg.created_at)}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* Reply input */}
              <div className="border-t border-gray-100 px-4 py-3">
                <div className="flex items-end gap-2">
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a message..."
                    rows={1}
                    className="max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border border-gray-200 px-4 py-2.5 text-sm outline-none focus:border-brand"
                    style={{
                      height: 'auto',
                      minHeight: '40px',
                    }}
                    onInput={(e) => {
                      const target = e.target as HTMLTextAreaElement;
                      target.style.height = 'auto';
                      target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
                    }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!replyText.trim() || sending}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition hover:bg-brand-600 disabled:opacity-40"
                  >
                    {sending ? (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    ) : (
                      <svg
                        className="h-5 w-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
