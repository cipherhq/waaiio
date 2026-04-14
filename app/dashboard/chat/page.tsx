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
  conversation_id: string | null;
  created_at: string;
  media_url?: string | null;
  media_type?: string | null;
}

interface ChatConversation {
  id: string;
  business_id: string;
  customer_phone: string;
  customer_name: string | null;
  status: 'open' | 'pending' | 'resolved';
  escalated_from_step: string | null;
  escalated_at: string | null;
  last_message_at: string | null;
  created_at: string;
}

interface CannedResponse {
  id: string;
  title: string;
  message_text: string;
  shortcut: string | null;
}

type StatusFilter = 'open' | 'resolved' | 'all';

function formatMessageTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;

  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }

  const diffHrs = Math.floor(diffMins / 60);
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
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [resolving, setResolving] = useState(false);
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);
  const [showCanned, setShowCanned] = useState(false);
  // Canned responses management panel
  const [showCannedPanel, setShowCannedPanel] = useState(false);
  const [editingCanned, setEditingCanned] = useState<CannedResponse | null>(null);
  const [cannedTitle, setCannedTitle] = useState('');
  const [cannedMessage, setCannedMessage] = useState('');
  const [cannedSaving, setCannedSaving] = useState(false);
  const [cannedDeleting, setCannedDeleting] = useState<string | null>(null);
  // Chat forwarding settings
  const [forwardEnabled, setForwardEnabled] = useState(false);
  const [forwardToggling, setForwardToggling] = useState(false);
  const [forwardUsage, setForwardUsage] = useState<{ count: number; month: string } | null>(null);
  const [businessTier, setBusinessTier] = useState<string>('free');
  // Audio recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [sendingAudio, setSendingAudio] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const cannedRef = useRef<HTMLDivElement>(null);

  // Request browser notification permission on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Load conversations and messages via API (server-side auth) + poll for new messages
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;

    async function load(isInitial = false) {
      try {
        const res = await fetch(`/api/chat/list?businessId=${business.id}`);
        const data = await res.json();
        const convs = data.conversations || [];
        const msgs = data.messages || [];

        if (isInitial) {
          setConversations(convs);
          setMessages(msgs);
          setLoading(false);
        } else {
          // Merge: update existing + add new conversations
          setConversations((prev) => {
            const map = new Map(prev.map((c) => [c.id, c]));
            for (const c of convs) map.set(c.id, c);
            return Array.from(map.values());
          });
          // Merge: keep optimistic messages + add new from server
          setMessages((prev) => {
            const map = new Map(prev.map((m) => [m.id, m]));
            for (const m of msgs) map.set(m.id, m);
            if (map.size === prev.length) return prev; // no change
            return Array.from(map.values()).sort(
              (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );
          });
        }
      } catch {
        if (isInitial) {
          setConversations([]);
          setMessages([]);
          setLoading(false);
        }
      }
    }

    load(true);
    interval = setInterval(() => load(false), 2000);
    return () => clearInterval(interval);
  }, [business.id]);

  // Load canned responses
  useEffect(() => {
    async function loadCanned() {
      try {
        const res = await fetch(`/api/chat/canned-responses?businessId=${business.id}`);
        const data = await res.json();
        if (data.responses) setCannedResponses(data.responses);
      } catch { /* silent */ }
    }
    loadCanned();
  }, [business.id]);

  // Load forwarding settings + usage
  useEffect(() => {
    async function loadForwardSettings() {
      const supabase = createClient();

      // Get business tier
      const { data: biz } = await supabase
        .from('businesses')
        .select('subscription_tier')
        .eq('id', business.id)
        .single();
      if (biz) setBusinessTier(biz.subscription_tier || 'free');

      // Get forwarding toggle
      const { data: waConfig } = await supabase
        .from('whatsapp_config')
        .select('forward_chat_to_phone')
        .eq('business_id', business.id)
        .maybeSingle();
      if (waConfig) setForwardEnabled(waConfig.forward_chat_to_phone || false);

      // Get current month usage
      const monthKey = new Date().toISOString().slice(0, 7); // '2026-04'
      const { data: usage } = await supabase
        .from('chat_forward_usage')
        .select('forward_count, month_key')
        .eq('business_id', business.id)
        .eq('month_key', monthKey)
        .maybeSingle();
      if (usage) {
        setForwardUsage({ count: usage.forward_count, month: usage.month_key });
      }
    }
    loadForwardSettings();
  }, [business.id]);

  // Realtime: chat_messages
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
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });

          // Browser notification for inbound messages
          if (
            newMsg.direction === 'inbound' &&
            'Notification' in window &&
            Notification.permission === 'granted'
          ) {
            const name = newMsg.customer_name || newMsg.customer_phone;
            new Notification(`New message from ${name}`, {
              body: newMsg.message_text.slice(0, 100),
              tag: `chat-${newMsg.customer_phone}`,
            });
          }

          // Auto-reopen resolved conversations on new inbound
          if (newMsg.direction === 'inbound') {
            setConversations((prev) => {
              const existing = prev.find(
                (c) => c.customer_phone === newMsg.customer_phone
              );
              if (existing && existing.status === 'resolved') {
                // Reopen via API (fire-and-forget)
                fetch('/api/chat/reopen', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    businessId: business.id,
                    customerPhone: newMsg.customer_phone,
                  }),
                }).catch(() => {});
                return prev.map((c) =>
                  c.customer_phone === newMsg.customer_phone
                    ? { ...c, status: 'open' as const, last_message_at: newMsg.created_at }
                    : c
                );
              }
              // Update last_message_at for existing conversations
              if (existing) {
                return prev.map((c) =>
                  c.customer_phone === newMsg.customer_phone
                    ? { ...c, last_message_at: newMsg.created_at }
                    : c
                );
              }
              return prev;
            });
          }
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

  // Realtime: chat_conversations
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`chat_conversations:${business.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chat_conversations',
          filter: `business_id=eq.${business.id}`,
        },
        (payload) => {
          const updated = payload.new as ChatConversation;
          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.id === updated.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updated;
              return next;
            }
            return [updated, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [business.id]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, selectedPhone]);

  // Close canned popover on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (cannedRef.current && !cannedRef.current.contains(e.target as Node)) {
        setShowCanned(false);
      }
    }
    if (showCanned) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showCanned]);

  // Build enriched conversation list from conversations table + messages for unread counts
  const enrichedConversations = conversations.map((conv) => {
    const convMessages = messages.filter(
      (m) => m.customer_phone === conv.customer_phone
    );
    const lastMsg = convMessages[convMessages.length - 1];
    const unreadCount = convMessages.filter(
      (m) => m.direction === 'inbound' && !m.is_read
    ).length;

    return {
      ...conv,
      last_message: lastMsg?.message_text || '',
      unread_count: unreadCount,
      display_name: conv.customer_name || conv.customer_phone,
    };
  });

  // Filter by status
  const statusFiltered =
    statusFilter === 'all'
      ? enrichedConversations
      : enrichedConversations.filter((c) => c.status === statusFilter);

  // Filter by search
  const filteredConversations = searchQuery.trim()
    ? statusFiltered.filter(
        (c) =>
          (c.customer_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.customer_phone.includes(searchQuery)
      )
    : statusFiltered;

  // Sort by last_message_at
  const sortedConversations = [...filteredConversations].sort(
    (a, b) =>
      new Date(b.last_message_at || b.created_at).getTime() -
      new Date(a.last_message_at || a.created_at).getTime()
  );

  // Messages for selected conversation
  const threadMessages = selectedPhone
    ? messages.filter((m) => m.customer_phone === selectedPhone)
    : [];

  // Selected conversation info
  const selectedConversation = enrichedConversations.find(
    (c) => c.customer_phone === selectedPhone
  );

  // Mark as read
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
        const data = await res.json();
        if (data.message) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === data.message.id)) return prev;
            return [...prev, data.message];
          });
        }
        setReplyText('');
      }
    } catch {
      // Silently fail
    } finally {
      setSending(false);
    }
  }

  async function handleResolve() {
    if (!selectedPhone || resolving) return;
    setResolving(true);
    try {
      await fetch('/api/chat/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          customerPhone: selectedPhone,
        }),
      });
      // Optimistic update
      setConversations((prev) =>
        prev.map((c) =>
          c.customer_phone === selectedPhone
            ? { ...c, status: 'resolved' as const, resolved_at: new Date().toISOString() }
            : c
        )
      );
    } catch { /* silent */ } finally {
      setResolving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── Audio Recording ──────────────────────────────────

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4',
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
    } catch {
      // Microphone permission denied or not available
    }
  }

  function cancelRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    setIsRecording(false);
    setRecordingTime(0);
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
  }

  async function stopAndSendRecording() {
    if (!mediaRecorderRef.current || !selectedPhone) return;

    setSendingAudio(true);
    const recorder = mediaRecorderRef.current;

    // Wait for the recorder to finish
    const audioBlob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        resolve(new Blob(audioChunksRef.current, { type: mimeType }));
      };
      if (recorder.state !== 'inactive') recorder.stop();
    });

    // Stop all tracks
    recorder.stream.getTracks().forEach((t) => t.stop());

    setIsRecording(false);
    setRecordingTime(0);
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    mediaRecorderRef.current = null;

    try {
      // Upload audio
      const formData = new FormData();
      const ext = audioBlob.type.includes('webm') ? 'webm' : 'mp4';
      formData.append('file', audioBlob, `recording.${ext}`);
      formData.append('businessId', business.id);

      const uploadRes = await fetch('/api/chat/upload-audio', {
        method: 'POST',
        body: formData,
      });
      const uploadData = await uploadRes.json();

      if (!uploadData.success || !uploadData.url) {
        throw new Error(uploadData.error || 'Upload failed');
      }

      // Send audio message
      const sendRes = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          customerPhone: selectedPhone,
          audioUrl: uploadData.url,
        }),
      });

      if (sendRes.ok) {
        const data = await sendRes.json();
        if (data.message) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === data.message.id)) return prev;
            return [...prev, data.message];
          });
        }
      }
    } catch {
      // Silent fail
    } finally {
      setSendingAudio(false);
      audioChunksRef.current = [];
    }
  }

  function formatRecordingTime(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ── Canned Responses CRUD ──────────────────────────────

  function resetCannedForm() {
    setEditingCanned(null);
    setCannedTitle('');
    setCannedMessage('');
  }

  function startEditCanned(cr: CannedResponse) {
    setEditingCanned(cr);
    setCannedTitle(cr.title);
    setCannedMessage(cr.message_text);
  }

  async function handleSaveCanned() {
    if (!cannedTitle.trim() || !cannedMessage.trim() || cannedSaving) return;
    setCannedSaving(true);
    try {
      if (editingCanned) {
        await fetch('/api/chat/canned-responses', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingCanned.id,
            businessId: business.id,
            title: cannedTitle.trim(),
            messageText: cannedMessage.trim(),
          }),
        });
        setCannedResponses((prev) =>
          prev.map((cr) =>
            cr.id === editingCanned.id
              ? { ...cr, title: cannedTitle.trim(), message_text: cannedMessage.trim() }
              : cr
          )
        );
      } else {
        const res = await fetch('/api/chat/canned-responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            businessId: business.id,
            title: cannedTitle.trim(),
            messageText: cannedMessage.trim(),
          }),
        });
        const data = await res.json();
        if (data.response) {
          setCannedResponses((prev) => [...prev, data.response]);
        }
      }
      resetCannedForm();
    } catch { /* silent */ } finally {
      setCannedSaving(false);
    }
  }

  async function handleToggleForwarding() {
    if (forwardToggling) return;
    setForwardToggling(true);
    try {
      const supabase = createClient();
      const newValue = !forwardEnabled;
      await supabase
        .from('whatsapp_config')
        .update({ forward_chat_to_phone: newValue })
        .eq('business_id', business.id);
      setForwardEnabled(newValue);
    } catch { /* silent */ } finally {
      setForwardToggling(false);
    }
  }

  async function handleDeleteCanned(id: string) {
    setCannedDeleting(id);
    try {
      await fetch('/api/chat/canned-responses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, businessId: business.id }),
      });
      setCannedResponses((prev) => prev.filter((cr) => cr.id !== id));
    } catch { /* silent */ } finally {
      setCannedDeleting(null);
    }
  }

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

  // Count by status for tabs
  const openCount = enrichedConversations.filter((c) => c.status === 'open').length;
  const resolvedCount = enrichedConversations.filter((c) => c.status === 'resolved').length;

  // Total unread
  const totalUnread = enrichedConversations.reduce((sum, c) => sum + c.unread_count, 0);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      {/* Header */}
      <div className="mb-4 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">Chat</h1>
            {totalUnread > 0 && (
              <span className="rounded-full bg-brand px-2.5 py-0.5 text-xs font-semibold text-white">
                {totalUnread} unread
              </span>
            )}
          </div>
          <button
            onClick={() => { setShowCannedPanel(true); resetCannedForm(); }}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 hover:text-gray-900"
          >
            <span className="flex items-center gap-1.5">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              </svg>
              Chat Settings
            </span>
          </button>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Manage customer conversations
        </p>
      </div>

      {/* Two-panel layout */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-gray-100 bg-white">
        {/* Left panel - Conversation list */}
        <div className="flex w-80 shrink-0 flex-col border-r border-gray-100">
          {/* Status filter tabs */}
          <div className="flex border-b border-gray-100">
            {([
              { key: 'open' as StatusFilter, label: 'Open', count: openCount },
              { key: 'resolved' as StatusFilter, label: 'Resolved', count: resolvedCount },
              { key: 'all' as StatusFilter, label: 'All', count: enrichedConversations.length },
            ]).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setStatusFilter(tab.key)}
                className={`flex-1 px-3 py-2.5 text-xs font-semibold transition ${
                  statusFilter === tab.key
                    ? 'border-b-2 border-brand text-brand'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

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
            {sortedConversations.length === 0 ? (
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
                  {searchQuery
                    ? 'No matching conversations'
                    : statusFilter === 'open'
                    ? 'No open conversations'
                    : statusFilter === 'resolved'
                    ? 'No resolved conversations'
                    : 'No conversations yet'}
                </p>
                {!searchQuery && statusFilter === 'all' && (
                  <p className="mt-1 text-xs text-gray-400">
                    Messages from customers will appear here
                  </p>
                )}
              </div>
            ) : (
              sortedConversations.map((conv) => (
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
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p
                          className={`truncate text-sm ${
                            conv.unread_count > 0
                              ? 'font-bold text-gray-900'
                              : 'font-medium text-gray-900'
                          }`}
                        >
                          {conv.customer_name || conv.customer_phone}
                        </p>
                        {/* Escalation badge */}
                        {conv.escalated_from_step && (
                          <span className="shrink-0 rounded bg-orange-100 px-1 py-0.5 text-[9px] font-semibold text-orange-700">
                            BOT
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 text-xs text-gray-400">
                        {formatMessageTime(
                          conv.last_message_at || conv.created_at
                        )}
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
                        {conv.last_message || 'No messages yet'}
                      </p>
                      {conv.unread_count > 0 && (
                        <span className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">
                          {conv.unread_count}
                        </span>
                      )}
                    </div>
                    {/* Escalation source label */}
                    {conv.escalated_from_step && (
                      <p className="mt-0.5 text-[10px] text-orange-600">
                        From: {conv.escalated_from_step.replace(/_/g, ' ')}
                      </p>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right panel - Message thread */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!selectedPhone ? (
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
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
                <div className="flex items-center gap-3">
                  {/* Back button for mobile */}
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
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {selectedConversation?.customer_name || selectedPhone}
                      </p>
                      {selectedConversation?.status && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            selectedConversation.status === 'open'
                              ? 'bg-green-100 text-green-700'
                              : selectedConversation.status === 'resolved'
                              ? 'bg-gray-100 text-gray-500'
                              : 'bg-yellow-100 text-yellow-700'
                          }`}
                        >
                          {selectedConversation.status}
                        </span>
                      )}
                    </div>
                    {selectedConversation?.customer_name && (
                      <p className="text-xs text-gray-500">{selectedPhone}</p>
                    )}
                  </div>
                </div>

                {/* Resolve button */}
                {selectedConversation?.status === 'open' && (
                  <button
                    onClick={handleResolve}
                    disabled={resolving}
                    className="rounded-lg border border-green-200 px-3 py-1.5 text-xs font-semibold text-green-700 transition hover:bg-green-50 disabled:opacity-50"
                  >
                    {resolving ? 'Resolving...' : 'Resolve'}
                  </button>
                )}
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
                      const prevMsg = idx > 0 ? threadMessages[idx - 1] : null;
                      const showDate =
                        !prevMsg ||
                        new Date(msg.created_at).toDateString() !==
                          new Date(prevMsg.created_at).toDateString();

                      // System messages (escalation markers) — skip for media messages
                      const isSystem = !msg.media_type && msg.message_text.startsWith('[') && msg.message_text.endsWith(']');

                      return (
                        <div key={msg.id}>
                          {showDate && (
                            <div className="my-4 flex items-center justify-center">
                              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">
                                {getDateLabel(msg.created_at)}
                              </span>
                            </div>
                          )}
                          {isSystem ? (
                            <div className="my-2 flex items-center justify-center">
                              <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-600">
                                {msg.message_text.slice(1, -1)}
                              </span>
                            </div>
                          ) : (
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
                                {msg.media_type === 'audio' && msg.media_url ? (
                                  <div>
                                    <div className="mb-1 flex items-center gap-1.5">
                                      <svg className={`h-3.5 w-3.5 shrink-0 ${msg.direction === 'outbound' ? 'text-white/80' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                                      </svg>
                                      <span className={`text-xs font-medium ${msg.direction === 'outbound' ? 'text-white/80' : 'text-gray-500'}`}>
                                        Voice message
                                      </span>
                                    </div>
                                    <audio
                                      controls
                                      preload="metadata"
                                      src={msg.media_url}
                                      className="w-full min-w-[200px]"
                                      style={msg.direction === 'outbound' ? { filter: 'invert(1) brightness(1.8)', height: '36px' } : { height: '36px' }}
                                    />
                                  </div>
                                ) : (
                                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                                    {msg.message_text || (msg.direction === 'inbound' ? '[Voice message]' : '')}
                                  </p>
                                )}
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
                          )}
                        </div>
                      );
                    })}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* Reply input */}
              <div className="border-t border-gray-100 px-4 py-3">
                {isRecording ? (
                  /* Recording UI */
                  <div className="flex items-center gap-3">
                    <button
                      onClick={cancelRecording}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 text-gray-500 transition hover:bg-gray-50 hover:text-gray-700"
                      title="Cancel recording"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                    <div className="flex flex-1 items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5">
                      <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
                      <span className="text-sm font-medium text-red-700">
                        Recording {formatRecordingTime(recordingTime)}
                      </span>
                    </div>
                    <button
                      onClick={stopAndSendRecording}
                      disabled={sendingAudio}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition hover:bg-brand-600 disabled:opacity-40"
                      title="Send recording"
                    >
                      {sendingAudio ? (
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      ) : (
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                      )}
                    </button>
                  </div>
                ) : (
                  /* Normal compose UI */
                  <div className="flex items-end gap-2">
                    {/* Canned responses button */}
                    <div className="relative" ref={cannedRef}>
                      <button
                        onClick={() => setShowCanned(!showCanned)}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 text-gray-500 transition hover:bg-gray-50 hover:text-gray-700"
                        title="Quick replies"
                      >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </button>

                      {/* Canned responses popover */}
                      {showCanned && cannedResponses.length > 0 && (
                        <div className="absolute bottom-12 left-0 z-10 w-64 rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
                          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                            Quick Replies
                          </p>
                          {cannedResponses.map((cr) => (
                            <button
                              key={cr.id}
                              onClick={() => {
                                setReplyText(cr.message_text);
                                setShowCanned(false);
                              }}
                              className="flex w-full flex-col px-3 py-2 text-left transition hover:bg-gray-50"
                            >
                              <span className="text-sm font-medium text-gray-900">
                                {cr.title}
                              </span>
                              <span className="mt-0.5 truncate text-xs text-gray-500">
                                {cr.message_text}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

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

                    {/* Microphone button */}
                    <button
                      onClick={startRecording}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 text-gray-500 transition hover:bg-gray-50 hover:text-gray-700"
                      title="Record voice message"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    </button>

                    {/* Send button */}
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
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Quick Replies Management Panel (slide-over) */}
      {showCannedPanel && (
        <div className="fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/30"
            onClick={() => { setShowCannedPanel(false); resetCannedForm(); }}
          />
          {/* Panel */}
          <div className="fixed inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-xl">
            {/* Panel header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900">Chat Settings</h2>
              <button
                onClick={() => { setShowCannedPanel(false); resetCannedForm(); }}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Chat Forwarding Settings */}
            <div className="border-b border-gray-100 px-6 py-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                WhatsApp Forwarding
              </p>
              <div className="rounded-lg border border-gray-100 p-3">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 pr-4">
                    <p className="text-sm font-medium text-gray-900">
                      Forward messages to your phone
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      Receive every customer message on WhatsApp
                    </p>
                  </div>
                  {businessTier === 'free' ? (
                    <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold text-gray-500">
                      Paid plans only
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleToggleForwarding}
                      disabled={forwardToggling}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                        forwardEnabled ? 'bg-brand' : 'bg-gray-200'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                          forwardEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  )}
                </div>
                {forwardEnabled && forwardUsage && (
                  <div className="mt-3 flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2">
                    <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    <span className="text-xs text-gray-600">
                      <span className="font-semibold text-gray-900">{forwardUsage.count}</span> messages forwarded this month
                    </span>
                  </div>
                )}
                {businessTier === 'free' && (
                  <p className="mt-2 text-[11px] text-gray-400">
                    Upgrade to Growth or Business plan to enable WhatsApp forwarding.
                  </p>
                )}
              </div>
            </div>

            {/* Add / Edit form */}
            <div className="border-b border-gray-100 px-6 py-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                {editingCanned ? 'Edit Reply' : 'Add New Reply'}
              </p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Title</label>
                  <input
                    type="text"
                    value={cannedTitle}
                    onChange={(e) => setCannedTitle(e.target.value)}
                    placeholder="e.g. Thanks for waiting"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Message</label>
                  <textarea
                    value={cannedMessage}
                    onChange={(e) => setCannedMessage(e.target.value)}
                    placeholder="The message that will be inserted..."
                    rows={3}
                    className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSaveCanned}
                    disabled={!cannedTitle.trim() || !cannedMessage.trim() || cannedSaving}
                    className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                  >
                    {cannedSaving ? 'Saving...' : editingCanned ? 'Update' : 'Add Reply'}
                  </button>
                  {editingCanned && (
                    <button
                      onClick={resetCannedForm}
                      className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Existing replies list */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {cannedResponses.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <svg className="h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <p className="mt-3 text-sm text-gray-500">No quick replies yet</p>
                  <p className="mt-1 text-xs text-gray-400">Add one above to get started</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {cannedResponses.map((cr) => (
                    <div
                      key={cr.id}
                      className={`rounded-lg border p-3 ${
                        editingCanned?.id === cr.id
                          ? 'border-brand bg-brand-50/30'
                          : 'border-gray-100 hover:border-gray-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-gray-900">
                            {cr.title}
                          </p>
                          <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">
                            {cr.message_text}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => startEditCanned(cr)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                            title="Edit"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDeleteCanned(cr.id)}
                            disabled={cannedDeleting === cr.id}
                            className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                            title="Delete"
                          >
                            {cannedDeleting === cr.id ? (
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-red-400 border-t-transparent" />
                            ) : (
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
