'use client';

import { motion, useReducedMotion } from 'framer-motion';

const FLOW_STEPS = [
  {
    icon: '\u{1F4AC}',
    label: 'Customer Messages',
    detail: '"I wan barb tomorrow 3pm"',
    color: 'bg-whatsapp',
    ring: 'ring-whatsapp/20',
  },
  {
    icon: '\u{1F916}',
    label: 'AI Understands',
    detail: 'Parses intent & finds slots',
    color: 'bg-brand',
    ring: 'ring-brand/20',
  },
  {
    icon: '\u{1F4C5}',
    label: 'Booking Confirmed',
    detail: 'Tomorrow, 3:00 PM locked in',
    color: 'bg-blue-500',
    ring: 'ring-blue-500/20',
  },
  {
    icon: '\u{1F4B3}',
    label: 'Payment Link Sent',
    detail: 'Secure Paystack / Stripe link',
    color: 'bg-emerald-500',
    ring: 'ring-emerald-500/20',
  },
  {
    icon: '\u{1F9FE}',
    label: 'Receipt Generated',
    detail: 'Ref: BW-7291 sent to chat',
    color: 'bg-amber-500',
    ring: 'ring-amber-500/20',
  },
  {
    icon: '\u{1F514}',
    label: 'Auto-Reminder',
    detail: 'Reminder sent next morning',
    color: 'bg-brand-600',
    ring: 'ring-brand-600/20',
  },
];

export default function HeroAutomationFlow() {
  const prefersReducedMotion = useReducedMotion();
  const noMotion = !!prefersReducedMotion;

  return (
    <motion.div
      initial={noMotion ? undefined : { opacity: 0, y: 30 }}
      animate={noMotion ? undefined : { opacity: 1, y: 0 }}
      transition={noMotion ? undefined : { delay: 0.5, duration: 0.8 }}
      className="relative mx-auto w-full max-w-sm lg:mx-0 lg:max-w-md"
    >
      {/* Glass card container */}
      <div className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur-sm">
        {/* Header */}
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-whatsapp">
            <svg className="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
            </svg>
          </div>
          <span className="text-sm font-semibold text-white/90">Automation Flow</span>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              {!noMotion && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />}
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            <span className="text-xs text-green-300">Live</span>
          </div>
        </div>

        {/* Flow steps */}
        <div className="space-y-0">
          {FLOW_STEPS.map((step, i) => (
            <motion.div
              key={step.label}
              initial={noMotion ? undefined : { opacity: 0, x: -20 }}
              animate={noMotion ? undefined : { opacity: 1, x: 0 }}
              transition={noMotion ? undefined : { delay: 0.8 + i * 0.25, duration: 0.5 }}
            >
              {/* Connector line */}
              {i > 0 && (
                <div className="ml-6 flex h-5 items-center">
                  <motion.div
                    initial={noMotion ? undefined : { scaleY: 0 }}
                    animate={noMotion ? undefined : { scaleY: 1 }}
                    transition={noMotion ? undefined : { delay: 0.7 + i * 0.25, duration: 0.3 }}
                    className="h-full w-0.5 origin-top bg-gradient-to-b from-white/30 to-white/10"
                  />
                </div>
              )}

              {/* Step card */}
              <div className="group flex items-start gap-3">
                <motion.div
                  animate={
                    noMotion
                      ? undefined
                      : {
                          scale: [1, 1.08, 1],
                          boxShadow: [
                            '0 0 0 0 rgba(255,255,255,0)',
                            '0 0 0 6px rgba(255,255,255,0.1)',
                            '0 0 0 0 rgba(255,255,255,0)',
                          ],
                        }
                  }
                  transition={
                    noMotion
                      ? undefined
                      : {
                          repeat: Infinity,
                          duration: 3,
                          delay: i * 0.5,
                          repeatDelay: FLOW_STEPS.length * 0.5,
                        }
                  }
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${step.color} text-lg shadow-lg ring-4 ${step.ring}`}
                >
                  {step.icon}
                </motion.div>
                <div className="min-w-0 pt-0.5">
                  <p className="text-sm font-semibold text-white">{step.label}</p>
                  <p className="mt-0.5 text-xs text-white/60">{step.detail}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Bottom stats — non-quantified truthful language only */}
        <motion.div
          initial={noMotion ? undefined : { opacity: 0 }}
          animate={noMotion ? undefined : { opacity: 1 }}
          transition={noMotion ? undefined : { delay: 2.5, duration: 0.6 }}
          className="mt-6 grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-white/5 p-3"
        >
          <div className="text-center">
            <p className="text-lg font-bold text-accent">{'\u{1F4AC}'}</p>
            <p className="text-[10px] text-white/50">Automated Replies</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-accent">{'\u{1F4F1}'}</p>
            <p className="text-[10px] text-white/50">Works in WhatsApp</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-accent">{'\u{1F512}'}</p>
            <p className="text-[10px] text-white/50">Secure Payments</p>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
