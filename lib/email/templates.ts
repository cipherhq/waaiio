// ─── App URL ──────────────────────────────────────────────────────

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

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

function wrap(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waaiio</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
  <!-- Header -->
  <tr>
    <td style="background:#7c3aed;padding:24px 32px">
      <table cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:18px;font-weight:700"><span style="color:#25D366">wa</span><span style="color:#E5993E">ai</span><span style="color:#B5A3E0">io</span></td>
      </tr></table>
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

// ─── Templates ────────────────────────────────────────────────────

export function welcomeEmail(name: string) {
  return {
    subject: 'Welcome to Waaiio!',
    html: wrap(`
      ${h(`Welcome, ${esc(name)}!`)}
      ${p("Thanks for joining Waaiio. You're on your way to automating your business with AI-powered WhatsApp bots.")}
      ${p('Here\'s what you can do next:')}
      <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.8;color:#3f3f46">
        <li>Register your business</li>
        <li>Customize your bot greeting</li>
        <li>Share your WhatsApp link</li>
      </ul>
      ${btn('Go to Dashboard', `${appUrl}/dashboard`)}
      ${p("If you have any questions, reply to this email. We're happy to help!")}
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
  date: string;
  time: string;
  quantity: number;
  referenceCode: string;
  amount: number;
  formattedAmount?: string;
  quantityLabel: string;
  confirmationEmoji: string;
}) {
  const { firstName, businessName, date, time, quantity, referenceCode, amount, formattedAmount, quantityLabel, confirmationEmoji } = details;
  const amountDisplay = formattedAmount || (amount > 0 ? amount.toLocaleString() : '');
  return {
    subject: `Confirmed at ${businessName} ${confirmationEmoji}`,
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
      ${p("We'll send you a reminder beforehand. See you soon!")}
    `),
  };
}

export function bookingReminderEmail(
  businessName: string,
  guestName: string,
  serviceName: string,
  date: string,
  time: string,
  referenceCode: string,
) {
  return {
    subject: `Reminder: ${businessName} is tomorrow`,
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
    `),
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
      ${p('After the trial, a small per-transaction fee will apply on the Free plan. Upgrade to Growth or Business to reduce fees and unlock more features.')}
      ${table(
        kv('Free Plan', '2% per transaction') +
        kv('Growth Plan', '1.5% per transaction — lower fees, more features') +
        kv('Business Plan', '1% per transaction — lowest fees, all features')
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
  referenceCode: string;
  totalAmount: string;
  dueDate: string;
  customerName: string;
  items: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
  invoiceUrl: string;
  currency: string;
}) {
  const { businessName, referenceCode, totalAmount, dueDate, customerName, items, invoiceUrl } = details;

  const itemRows = items.map(i =>
    `<tr>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46;border-bottom:1px solid #f4f4f5">${esc(i.description)}</td>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46;text-align:center;border-bottom:1px solid #f4f4f5">x${i.quantity}</td>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46;text-align:right;border-bottom:1px solid #f4f4f5">${i.amount.toLocaleString()}</td>
    </tr>`
  ).join('');

  return {
    subject: `Invoice ${referenceCode} from ${businessName}`,
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
    `),
  };
}
