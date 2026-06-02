// ─── App URL ──────────────────────────────────────────────────────

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

// ─── HTML escape ──────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Branded wrapper ──────────────────────────────────────────────

interface WrapOptions {
  businessName?: string;
  logoUrl?: string;
}

function wrap(body: string, opts?: WrapOptions): string {
  const biz = opts?.businessName ? esc(opts.businessName) : '';
  const logo = opts?.logoUrl || '';

  const headerContent = biz
    ? `<table cellpadding="0" cellspacing="0" width="100%"><tr>
        ${logo ? `<td style="width:40px;padding-right:12px"><img src="${logo}" width="36" height="36" style="border-radius:8px;display:block" alt="${biz}" /></td>` : ''}
        <td style="font-size:16px;font-weight:700;color:#ffffff">${biz}</td>
        <td style="text-align:right;font-size:11px;color:#B5A3E0">via <span style="color:#25D366">wa</span><span style="color:#E5993E">ai</span><span style="color:#B5A3E0">io</span></td>
      </tr></table>`
    : `<table cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:18px;font-weight:700"><span style="color:#25D366">wa</span><span style="color:#E5993E">ai</span><span style="color:#B5A3E0">io</span></td>
      </tr></table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${biz || 'Waaiio'}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
  <!-- Header -->
  <tr>
    <td style="background:#7c3aed;padding:24px 32px">
      ${headerContent}
    </td>
  </tr>
  <!-- Body -->
  <tr>
    <td style="padding:32px">
      ${body}
    </td>
  </tr>
  <!-- Footer -->
  <tr>
    <td style="padding:24px 32px;border-top:1px solid #e4e4e7;text-align:center">
      <p style="margin:0;font-size:12px;color:#a1a1aa">
        &copy; ${new Date().getFullYear()} Waaiio. All rights reserved.
      </p>
      <p style="margin:4px 0 0;font-size:12px;color:#a1a1aa">
        Automate your business with AI-powered WhatsApp bots.
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function btn(text: string, url: string): string {
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0"><tr>
    <td style="background:#7c3aed;border-radius:8px;padding:12px 24px">
      <a href="${url}" style="color:#ffffff;text-decoration:none;font-size:14px;font-weight:600">${text}</a>
    </td>
  </tr></table>`;
}

function h(text: string): string {
  return `<h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#18181b">${text}</h2>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#3f3f46">${text}</p>`;
}

function kv(label: string, value: string): string {
  return `<tr>
    <td style="padding:8px 0;font-size:13px;color:#71717a;width:140px">${label}</td>
    <td style="padding:8px 0;font-size:13px;font-weight:600;color:#18181b">${value}</td>
  </tr>`;
}

function table(rows: string): string {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;margin:16px 0;border-collapse:collapse">${rows}</table>`;
}

// ─── Sender helper ───────────────────────────────────────────────

export function businessFrom(businessName?: string): string | undefined {
  if (!businessName) return undefined;
  // Sanitize business name for email From header (remove quotes, angle brackets)
  const safe = businessName.replace(/[<>"]/g, '').trim();
  return `${safe} via Waaiio <noreply@waaiio.com>`;
}

// ─── Templates ────────────────────────────────────────────────────

export function welcomeEmail(name: string) {
  const firstName = name.split(' ')[0] || name;
  return {
    subject: `Welcome to Waaiio, ${firstName}!`,
    html: wrap(`
      ${h(`Hi ${esc(firstName)},`)}
      ${p("My name is Babajide, founder of Waaiio. Thank you for signing up — I'm genuinely excited to have you on board!")}
      ${p("I started Waaiio with a simple goal: <strong>help every business automate bookings, payments, and customer engagement on WhatsApp</strong> — without writing a single line of code. Today, we serve businesses across 16 industries in 5 countries, and I'm thrilled to give you the same tools.")}
      ${p("Your 30-day free trial is now active with <strong>all features unlocked</strong>. Here's how to get started:")}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0">
        <tr>
          <td style="padding:12px 16px;background:#f5f0ff;border-radius:8px;border-left:4px solid #7c3aed">
            <p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#3f3f46">Step 1: Add your services or products</p>
            <p style="margin:0;font-size:13px;color:#71717a">Tell customers what you offer — the bot uses this to handle bookings and orders.</p>
          </td>
        </tr>
        <tr><td style="height:8px"></td></tr>
        <tr>
          <td style="padding:12px 16px;background:#f0fdf4;border-radius:8px;border-left:4px solid #25D366">
            <p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#3f3f46">Step 2: Share your WhatsApp link</p>
            <p style="margin:0;font-size:13px;color:#71717a">Send your link to customers or post it on social media. They message, the bot handles the rest.</p>
          </td>
        </tr>
        <tr><td style="height:8px"></td></tr>
        <tr>
          <td style="padding:12px 16px;background:#fffbeb;border-radius:8px;border-left:4px solid #f59e0b">
            <p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#3f3f46">Step 3: Watch bookings roll in</p>
            <p style="margin:0;font-size:13px;color:#71717a">Your bot works 24/7 — taking bookings, collecting payments, and sending confirmations while you sleep.</p>
          </td>
        </tr>
      </table>
      ${p("Need help setting up? Use <strong>Ace</strong>, our AI setup assistant — it can read your menu or price list and create your services automatically.")}
      ${btn('Go to Your Dashboard', `${appUrl}/dashboard`)}
      ${p("I genuinely care about your success. If there's anything at all I can do to help, just reply to this email — it comes straight to me.")}
      <p style="margin:24px 0 4px;font-size:14px;color:#3f3f46">Thank you, and welcome to Waaiio!</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:#3f3f46">Babajide Ace</p>
      <p style="margin:2px 0 0;font-size:12px;color:#a1a1aa">Founder, Waaiio</p>
    `),
  };
}

export function businessRegisteredEmail(businessName: string, botCode: string, category: string) {
  return {
    subject: `${businessName} is live on Waaiio!`,
    html: wrap(`
      ${h('Your business is registered!')}
      ${p(`<strong>${esc(businessName)}</strong> has been set up on Waaiio. Your bot is ready to receive customers.`)}
      ${table(
        kv('Business', esc(businessName)) +
        kv('Category', esc(category.replace(/_/g, ' '))) +
        kv('Bot Code', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(botCode)}</code>`)
      )}
      ${btn('Set Up Your Bot', `${appUrl}/dashboard/whatsapp`)}
      ${p('Share your bot code with customers so they can start interacting with your business on WhatsApp.')}
    `),
  };
}

export function payoutApprovedEmail(businessName: string, amount: string, method: string) {
  return {
    subject: `Payout approved — ${amount}`,
    html: wrap(`
      ${h('Payout Approved')}
      ${p(`Good news! A payout for <strong>${esc(businessName)}</strong> has been approved and is being processed.`)}
      ${table(
        kv('Business', esc(businessName)) +
        kv('Amount', esc(amount)) +
        kv('Method', esc(method))
      )}
      ${p('Funds will arrive in your account within 1-3 business days depending on your bank.')}
      ${btn('View Payouts', `${appUrl}/dashboard/payouts`)}
    `),
  };
}

export function payoutPaidEmail(businessName: string, amount: string, reference: string) {
  return {
    subject: `Payout sent — ${amount}`,
    html: wrap(`
      ${h('Payout Sent!')}
      ${p(`Your payout for <strong>${esc(businessName)}</strong> has been sent to your bank account.`)}
      ${table(
        kv('Business', esc(businessName)) +
        kv('Amount', esc(amount)) +
        kv('Reference', esc(reference || '—'))
      )}
      ${p('The funds should reflect in your account shortly.')}
      ${btn('View Payouts', `${appUrl}/dashboard/payouts`)}
    `),
  };
}

export function payoutRejectedEmail(businessName: string, amount: string, reason: string) {
  return {
    subject: `Payout rejected — ${amount}`,
    html: wrap(`
      ${h('Payout Rejected')}
      ${p(`A payout for <strong>${esc(businessName)}</strong> was not approved.`)}
      ${table(
        kv('Business', esc(businessName)) +
        kv('Amount', esc(amount)) +
        kv('Reason', esc(reason))
      )}
      ${p('If you believe this is a mistake, please contact support or reply to this email.')}
      ${btn('View Payouts', `${appUrl}/dashboard/payouts`)}
    `),
  };
}

export function kycRequestedEmail(businessName: string, level: string, documentsNeeded: string[]) {
  const docList = documentsNeeded.map(d => `<li>${esc(d)}</li>`).join('');
  return {
    subject: `Verification required for ${businessName}`,
    html: wrap(`
      ${h('Verification Required')}
      ${p(`To unlock higher payout limits for <strong>${esc(businessName)}</strong>, we need you to verify your business.`)}
      ${table(kv('Requested Level', esc(level)))}
      ${p('<strong>Documents needed:</strong>')}
      <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.8;color:#3f3f46">
        ${docList}
      </ul>
      ${btn('Upload Documents', `${appUrl}/dashboard/verification`)}
      ${p('Verification typically takes 1-2 business days after submission.')}
    `),
  };
}

export function kycApprovedEmail(businessName: string, level: string, newLimit: string) {
  return {
    subject: `Verification approved — ${businessName}`,
    html: wrap(`
      ${h('Verification Approved!')}
      ${p(`<strong>${esc(businessName)}</strong> has been verified at the <strong>${esc(level)}</strong> level.`)}
      ${table(
        kv('Level', esc(level)) +
        kv('Monthly Payout Limit', esc(newLimit))
      )}
      ${p('You can now receive payouts up to your new limit.')}
      ${btn('View Dashboard', `${appUrl}/dashboard`)}
    `),
  };
}

export function kycRejectedEmail(businessName: string, reason: string) {
  return {
    subject: `Verification update — ${businessName}`,
    html: wrap(`
      ${h('Verification Not Approved')}
      ${p(`We were unable to verify <strong>${esc(businessName)}</strong> at this time.`)}
      ${table(kv('Reason', esc(reason)))}
      ${p('Please review the feedback, update your documents, and resubmit.')}
      ${btn('Resubmit Documents', `${appUrl}/dashboard/verification`)}
    `),
  };
}

export function bookingConfirmationEmail(details: {
  firstName: string;
  businessName: string;
  businessLogoUrl?: string;
  date: string;
  time: string;
  quantity: number;
  referenceCode: string;
  amount: number;
  formattedAmount?: string;
  quantityLabel: string;
  confirmationEmoji: string;
  googleCalendarUrl?: string;
}) {
  const { firstName, businessName, businessLogoUrl, date, time, quantity, referenceCode, amount, formattedAmount, quantityLabel, confirmationEmoji, googleCalendarUrl } = details;
  const amountDisplay = formattedAmount || (amount > 0 ? amount.toLocaleString() : '');
  const calendarBtn = googleCalendarUrl
    ? `<table cellpadding="0" cellspacing="0" style="margin:16px 0"><tr>
        <td style="background:#4285f4;border-radius:8px;padding:10px 20px">
          <a href="${googleCalendarUrl}" style="color:#ffffff;text-decoration:none;font-size:13px;font-weight:600">📅 Add to Calendar</a>
        </td>
      </tr></table>`
    : '';
  return {
    subject: `Confirmed at ${businessName} ${confirmationEmoji}`,
    from: businessFrom(businessName),
    html: wrap(`
      ${h(`Confirmed ${confirmationEmoji}`)}
      ${p(`Hi ${esc(firstName)}, you're all set with <strong>${esc(businessName)}</strong>!`)}
      ${table(
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(referenceCode)}</code>`) +
        kv('Date', esc(date)) +
        kv('Time', esc(time)) +
        kv(esc(quantityLabel), String(quantity)) +
        (amount > 0 ? kv('Amount', esc(amountDisplay)) : '')
      )}
      ${calendarBtn}
      ${p("We'll send you a reminder beforehand. See you soon!")}
    `, { businessName, logoUrl: businessLogoUrl }),
  };
}

export function bookingReminderEmail(
  businessName: string,
  guestName: string,
  serviceName: string,
  date: string,
  time: string,
  referenceCode: string,
  businessLogoUrl?: string,
) {
  return {
    subject: `Reminder: ${businessName} is tomorrow`,
    from: businessFrom(businessName),
    html: wrap(`
      ${h('Reminder')}
      ${p(`Hi ${esc(guestName)}, this is a friendly reminder about <strong>${esc(businessName)}</strong> tomorrow.`)}
      ${table(
        kv('Service', esc(serviceName)) +
        kv('Date', esc(date)) +
        (time ? kv('Time', esc(time)) : '') +
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(referenceCode)}</code>`)
      )}
      ${p('If you need to reschedule or cancel, please contact the business directly.')}
    `, { businessName, logoUrl: businessLogoUrl }),
  };
}

export function paymentReceivedEmail(businessName: string, amount: string, service: string) {
  return {
    subject: `Payment received — ${amount}`,
    html: wrap(`
      ${h('Payment Received')}
      ${p(`<strong>${esc(businessName)}</strong> received a new payment.`)}
      ${table(
        kv('Service', esc(service)) +
        kv('Amount', esc(amount))
      )}
      ${btn('View Payments', `${appUrl}/dashboard/payments`)}
    `),
  };
}

export function subscriptionActivatedEmail(businessName: string, tier: string, trialEnds: string) {
  return {
    subject: `Subscription activated — ${tier} plan`,
    html: wrap(`
      ${h('Subscription Activated')}
      ${p(`<strong>${esc(businessName)}</strong> is now on the <strong>${esc(tier)}</strong> plan.`)}
      ${table(
        kv('Plan', esc(tier)) +
        kv('Trial Ends', esc(trialEnds))
      )}
      ${p('Enjoy all the features of your new plan!')}
      ${btn('View Dashboard', `${appUrl}/dashboard`)}
    `),
  };
}

export function newOrderEmail(details: {
  businessName: string;
  referenceCode: string;
  customerName: string;
  items: Array<{ name: string; quantity: number; price: number; variant_label?: string }>;
  totalAmount: string;
  deliveryAddress?: string;
  dashboardUrl: string;
}) {
  const { businessName, referenceCode, customerName, items, totalAmount, deliveryAddress, dashboardUrl } = details;
  const itemRows = items.map(i => {
    const label = i.variant_label ? `${esc(i.name)} (${esc(i.variant_label)})` : esc(i.name);
    return `<tr>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46">${label}</td>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46;text-align:center">x${i.quantity}</td>
    </tr>`;
  }).join('');

  return {
    subject: `New order received — ${referenceCode}`,
    html: wrap(`
      ${h('New Order Received!')}
      ${p(`<strong>${esc(businessName)}</strong> just received a new order.`)}
      ${table(
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(referenceCode)}</code>`) +
        kv('Customer', esc(customerName)) +
        kv('Total', `<strong>${esc(totalAmount)}</strong>`) +
        (deliveryAddress ? kv('Delivery', esc(deliveryAddress)) : '')
      )}
      ${p('<strong>Items:</strong>')}
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px">${itemRows}</table>
      ${btn('View Order', dashboardUrl)}
      ${p('Log in to your dashboard to manage this order.')}
    `),
  };
}

export function newBookingOwnerEmail(details: {
  businessName: string;
  referenceCode: string;
  customerName: string;
  date: string;
  time: string;
  quantity: number;
  quantityLabel: string;
  amount?: string;
  dashboardUrl: string;
}) {
  const { businessName, referenceCode, customerName, date, time, quantity, quantityLabel, amount, dashboardUrl } = details;
  return {
    subject: `New booking — ${referenceCode}`,
    html: wrap(`
      ${h('New Booking!')}
      ${p(`<strong>${esc(businessName)}</strong> just received a new booking.`)}
      ${table(
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(referenceCode)}</code>`) +
        kv('Customer', esc(customerName)) +
        kv('Date', esc(date)) +
        kv('Time', esc(time)) +
        kv(esc(quantityLabel), String(quantity)) +
        (amount ? kv('Amount', esc(amount)) : '')
      )}
      ${btn('View Bookings', dashboardUrl)}
      ${p('Log in to your dashboard to manage this booking.')}
    `),
  };
}

export function trialExpiringEmail(businessName: string, daysLeft: number) {
  return {
    subject: `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    html: wrap(`
      ${h('Your Trial Is Ending Soon')}
      ${p(`The 7-day free trial for <strong>${esc(businessName)}</strong> ends in <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong>.`)}
      ${p('After the trial, a small per-transaction fee will apply on the Free plan. Upgrade to Pro or Premium to reduce fees and unlock more features.')}
      ${table(
        kv('Free Plan', '2% per transaction') +
        kv('Pro Plan', '1.5% per transaction — lower fees, more features') +
        kv('Premium Plan', '1% per transaction — lowest fees, all features')
      )}
      ${btn('Upgrade Now', `${appUrl}/dashboard/settings`)}
      ${p('Your bot will continue working on the Free plan — nothing breaks. You just start paying per-transaction fees.')}
    `),
  };
}

export function trialEndedEmail(businessName: string) {
  return {
    subject: `Your free trial has ended — ${businessName}`,
    html: wrap(`
      ${h('Free Trial Ended')}
      ${p(`The 7-day free trial for <strong>${esc(businessName)}</strong> has ended.`)}
      ${p('Your bot is still active on the <strong>Free plan</strong>. A 2% fee now applies to each transaction.')}
      ${p('Upgrade to reduce your fees and unlock premium features like loyalty programs, broadcasts, e-signatures, and more.')}
      ${btn('Upgrade Plan', `${appUrl}/dashboard/settings`)}
    `),
  };
}

export function subscriptionExpiringEmail(businessName: string, daysLeft: number, renewUrl: string) {
  const urgency = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  const urgencyTitle = daysLeft === 1 ? 'Your Subscription Expires Tomorrow' : 'Your Subscription Is Expiring Soon';
  return {
    subject: `Your subscription expires ${urgency} — ${businessName}`,
    html: wrap(`
      ${h(urgencyTitle)}
      ${p(`The paid subscription for <strong>${esc(businessName)}</strong> expires <strong>${urgency}</strong>.`)}
      ${p('After expiry, your business will be moved to the <strong>Free plan</strong>. You will lose access to premium features and your per-transaction fee will increase.')}
      ${table(
        kv('Business', esc(businessName)) +
        kv('Expires', urgency) +
        kv('After Expiry', 'Free plan (2.5% per transaction)')
      )}
      ${btn('Renew Subscription', renewUrl)}
      ${p('Renew now to keep your current plan and avoid any interruption to your premium features.')}
    `),
  };
}

export function subscriptionExpiredEmail(businessName: string, renewUrl: string) {
  return {
    subject: `Your subscription has expired — ${businessName}`,
    html: wrap(`
      ${h('Subscription Expired')}
      ${p(`The paid subscription for <strong>${esc(businessName)}</strong> has expired.`)}
      ${p('Your business has been moved to the <strong>Free plan</strong>. A 2.5% per-transaction fee now applies, and premium features have been disabled.')}
      ${table(
        kv('Business', esc(businessName)) +
        kv('Current Plan', 'Free') +
        kv('Transaction Fee', '2.5%')
      )}
      ${p('Your bot is still active and will continue to serve customers. Upgrade anytime to restore your previous plan and lower fees.')}
      ${btn('Renew Subscription', renewUrl)}
    `),
  };
}

export function payoutFailedEmail(businessName: string, amount: string, reason: string) {
  return {
    subject: `Payout failed — ${amount}`,
    html: wrap(`
      ${h('Payout Failed')}
      ${p(`A payout for <strong>${esc(businessName)}</strong> could not be completed.`)}
      ${table(
        kv('Business', esc(businessName)) +
        kv('Amount', esc(amount)) +
        kv('Reason', esc(reason || 'Transfer failed'))
      )}
      ${p('Please check your bank details in your dashboard settings. If your details are correct, the payout will be retried in the next cycle.')}
      ${btn('Check Bank Details', `${appUrl}/dashboard/settings`)}
    `),
  };
}

export function paymentFailedEmail(businessName: string, amount: string, reason: string) {
  return {
    subject: `Payment failed — ${businessName}`,
    html: wrap(`
      ${h('Payment Failed')}
      ${p(`A payment attempt for <strong>${esc(businessName)}</strong> was unsuccessful.`)}
      ${table(
        kv('Amount', esc(amount)) +
        kv('Reason', esc(reason || 'Payment was declined'))
      )}
      ${p('The customer may need to retry with a different payment method. No action is required from you — the customer has been notified.')}
      ${btn('View Dashboard', `${appUrl}/dashboard`)}
    `),
  };
}

export function weeklyDigestEmail(businessName: string, stats: {
  bookings: number;
  revenue: string;
  newCustomers: number;
  topService: string;
}) {
  return {
    subject: `Weekly summary — ${businessName}`,
    html: wrap(`
      ${h('Weekly Summary')}
      ${p(`Here's how <strong>${esc(businessName)}</strong> did this week:`)}
      ${table(
        kv('Bookings', String(stats.bookings)) +
        kv('Revenue', esc(stats.revenue)) +
        kv('New Customers', String(stats.newCustomers)) +
        kv('Top Service', esc(stats.topService))
      )}
      ${btn('View Full Analytics', `${appUrl}/dashboard/analytics`)}
      ${p('Keep up the great work!')}
    `),
  };
}

export function invoiceEmail(details: {
  businessName: string;
  businessLogoUrl?: string;
  referenceCode: string;
  totalAmount: string;
  dueDate: string;
  customerName: string;
  items: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
  invoiceUrl: string;
  currency: string;
}) {
  const { businessName, businessLogoUrl, referenceCode, totalAmount, dueDate, customerName, items, invoiceUrl } = details;

  const itemRows = items.map(i =>
    `<tr>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46;border-bottom:1px solid #f4f4f5">${esc(i.description)}</td>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46;text-align:center;border-bottom:1px solid #f4f4f5">x${i.quantity}</td>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46;text-align:right;border-bottom:1px solid #f4f4f5">${i.amount.toLocaleString()}</td>
    </tr>`
  ).join('');

  return {
    subject: `Invoice ${referenceCode} from ${businessName}`,
    from: businessFrom(businessName),
    html: wrap(`
      ${h(`Invoice from ${esc(businessName)}`)}
      ${p(`Hi ${esc(customerName)}, you have received an invoice from <strong>${esc(businessName)}</strong>.`)}
      ${table(
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(referenceCode)}</code>`) +
        kv('Amount', `<strong>${esc(totalAmount)}</strong>`) +
        kv('Due Date', esc(dueDate))
      )}
      ${items.length > 0 ? `
        ${p('<strong>Items:</strong>')}
        <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px">
          <tr>
            <td style="padding:6px 0;font-size:11px;font-weight:600;color:#71717a;border-bottom:1px solid #e4e4e7">Item</td>
            <td style="padding:6px 0;font-size:11px;font-weight:600;color:#71717a;text-align:center;border-bottom:1px solid #e4e4e7">Qty</td>
            <td style="padding:6px 0;font-size:11px;font-weight:600;color:#71717a;text-align:right;border-bottom:1px solid #e4e4e7">Amount</td>
          </tr>
          ${itemRows}
        </table>
      ` : ''}
      ${btn('View & Pay Invoice', invoiceUrl)}
      ${p('You can also copy and paste this link into your browser:')}
      ${p(`<a href="${invoiceUrl}" style="color:#7c3aed;word-break:break-all">${invoiceUrl}</a>`)}
    `, { businessName, logoUrl: businessLogoUrl }),
  };
}

export function ticketConfirmationEmail(details: {
  firstName: string;
  businessName: string;
  businessLogoUrl?: string;
  eventName: string;
  eventDate: string;
  eventTime?: string;
  venue: string;
  quantity: number;
  referenceCode: string;
  formattedAmount: string;
  ticketCodes: string[];
}) {
  const { firstName, businessName, businessLogoUrl, eventName, eventDate, eventTime, venue, quantity, referenceCode, formattedAmount, ticketCodes } = details;
  const ticketLabel = quantity === 1 ? 'ticket' : 'tickets';
  const ticketList = ticketCodes.map((code, i) => kv(`Ticket ${i + 1}`, `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(code)}</code>`)).join('');

  return {
    subject: `Your ${ticketLabel} for ${eventName} 🎫`,
    from: businessFrom(businessName),
    html: wrap(`
      ${h(`Ticket Confirmed! 🎫`)}
      ${p(`Hi ${esc(firstName)}, your ${quantity} ${ticketLabel} for <strong>${esc(eventName)}</strong> ${quantity === 1 ? 'is' : 'are'} confirmed!`)}
      ${table(
        kv('Event', `<strong>${esc(eventName)}</strong>`) +
        kv('Organizer', esc(businessName)) +
        kv('Date', esc(eventDate)) +
        (eventTime ? kv('Time', esc(eventTime)) : '') +
        (venue ? kv('Venue', esc(venue)) : '') +
        kv('Tickets', String(quantity)) +
        kv('Amount', esc(formattedAmount)) +
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(referenceCode)}</code>`)
      )}
      ${ticketList ? `${p('<strong>Your Ticket Codes:</strong>')}${table(ticketList)}` : ''}
      ${p('Show your QR code or ticket code at the entrance. Your tickets are also available on WhatsApp.')}
      ${p('Enjoy the event! 🎉')}
    `, { businessName, logoUrl: businessLogoUrl }),
  };
}

export function accountDeletionConfirmationEmail(name: string, deletionDate: string, isGracePeriod: boolean) {
  const subject = isGracePeriod
    ? 'Your Waaiio account is scheduled for deletion'
    : 'Your Waaiio account has been deleted';

  const body = isGracePeriod
    ? `
      ${h('Account Deletion Scheduled')}
      ${p(`Hi ${esc(name)}, your Waaiio account has been scheduled for deletion.`)}
      ${table(
        kv('Deletion Date', esc(deletionDate)) +
        kv('Grace Period', '30 days')
      )}
      ${p('If you change your mind, simply log back in before the deletion date and your account will be restored.')}
      ${p('After the deletion date, all your data will be permanently removed and cannot be recovered.')}
      ${btn('Cancel Deletion', `${appUrl}/login`)}
    `
    : `
      ${h('Account Deleted')}
      ${p(`Hi ${esc(name)}, your Waaiio account and all associated data have been permanently deleted.`)}
      ${p('This includes your business profiles, bookings, orders, payments, and customer data.')}
      ${p('If you believe this was done in error, please contact us immediately at support@waaiio.com.')}
      ${p('We\'re sorry to see you go. You can always create a new account at any time.')}
      ${btn('Visit Waaiio', appUrl)}
    `;

  return { subject, html: wrap(body) };
}

/**
 * Data Breach Notification Email
 * GDPR Article 34 — Communication of a personal data breach to the data subject
 * Must be sent within 72 hours of discovering a breach.
 */
export function dataBreachNotificationEmail(
  userName: string,
  breachDate: string,
  dataAffected: string[],
  actionsTaken: string[],
) {
  const affectedList = dataAffected.map(d => `<li>${esc(d)}</li>`).join('');
  const actionsList = actionsTaken.map(a => `<li>${esc(a)}</li>`).join('');

  return {
    subject: 'Important Security Notice — Waaiio',
    html: wrap(`
      ${h('Security Notice')}
      ${p(`Dear ${esc(userName)},`)}
      ${p('We are writing to inform you of a data security incident that may have affected your personal information.')}
      ${table(
        kv('Date Discovered', esc(breachDate)) +
        kv('Status', 'Under investigation')
      )}
      ${p('<strong>What information was affected:</strong>')}
      <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.8;color:#3f3f46">
        ${affectedList}
      </ul>
      ${p('<strong>What we have done:</strong>')}
      <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.8;color:#3f3f46">
        ${actionsList}
      </ul>
      ${p('<strong>What you should do:</strong>')}
      <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.8;color:#3f3f46">
        <li>Change your Waaiio password immediately</li>
        <li>If you used the same password elsewhere, change those too</li>
        <li>Monitor your accounts for suspicious activity</li>
        <li>Enable two-factor authentication if not already active</li>
      </ul>
      ${btn('Change Password', `${appUrl}/forgot-password`)}
      ${p('We take the security of your data extremely seriously and sincerely apologize for any inconvenience this may cause.')}
      ${p('If you have any questions or concerns, please contact our Data Protection Officer at <a href="mailto:dpo@waaiio.com" style="color:#7c3aed">dpo@waaiio.com</a>.')}
    `),
  };
}
