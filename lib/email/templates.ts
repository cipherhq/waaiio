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
        <td style="background:#ffffff;width:32px;height:32px;border-radius:8px;text-align:center;line-height:32px;font-weight:700;font-size:14px;color:#7c3aed">S</td>
        <td style="padding-left:12px;font-size:18px;font-weight:700;color:#ffffff">Waaiio</td>
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
      ${h(`Welcome, ${name}!`)}
      ${p("Thanks for joining Waaiio. You're on your way to automating your business with AI-powered WhatsApp bots.")}
      ${p('Here\'s what you can do next:')}
      <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.8;color:#3f3f46">
        <li>Register your business</li>
        <li>Customize your bot greeting</li>
        <li>Share your WhatsApp link</li>
      </ul>
      ${btn('Go to Dashboard', 'https://app.waaiio.com/dashboard')}
      ${p("If you have any questions, reply to this email. We're happy to help!")}
    `),
  };
}

export function businessRegisteredEmail(businessName: string, botCode: string, category: string) {
  return {
    subject: `${businessName} is live on Waaiio!`,
    html: wrap(`
      ${h('Your business is registered!')}
      ${p(`<strong>${businessName}</strong> has been set up on Waaiio. Your bot is ready to receive customers.`)}
      ${table(
        kv('Business', businessName) +
        kv('Category', category.replace(/_/g, ' ')) +
        kv('Bot Code', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${botCode}</code>`)
      )}
      ${btn('Set Up Your Bot', 'https://app.waaiio.com/dashboard/whatsapp')}
      ${p('Share your bot code with customers so they can start interacting with your business on WhatsApp.')}
    `),
  };
}

export function payoutApprovedEmail(businessName: string, amount: string, method: string) {
  return {
    subject: `Payout approved — ${amount}`,
    html: wrap(`
      ${h('Payout Approved')}
      ${p(`Good news! A payout for <strong>${businessName}</strong> has been approved and is being processed.`)}
      ${table(
        kv('Business', businessName) +
        kv('Amount', amount) +
        kv('Method', method)
      )}
      ${p('Funds will arrive in your account within 1-3 business days depending on your bank.')}
      ${btn('View Payouts', 'https://app.waaiio.com/dashboard/payouts')}
    `),
  };
}

export function payoutPaidEmail(businessName: string, amount: string, reference: string) {
  return {
    subject: `Payout sent — ${amount}`,
    html: wrap(`
      ${h('Payout Sent!')}
      ${p(`Your payout for <strong>${businessName}</strong> has been sent to your bank account.`)}
      ${table(
        kv('Business', businessName) +
        kv('Amount', amount) +
        kv('Reference', reference || '—')
      )}
      ${p('The funds should reflect in your account shortly.')}
      ${btn('View Payouts', 'https://app.waaiio.com/dashboard/payouts')}
    `),
  };
}

export function payoutRejectedEmail(businessName: string, amount: string, reason: string) {
  return {
    subject: `Payout rejected — ${amount}`,
    html: wrap(`
      ${h('Payout Rejected')}
      ${p(`A payout for <strong>${businessName}</strong> was not approved.`)}
      ${table(
        kv('Business', businessName) +
        kv('Amount', amount) +
        kv('Reason', reason)
      )}
      ${p('If you believe this is a mistake, please contact support or reply to this email.')}
      ${btn('View Payouts', 'https://app.waaiio.com/dashboard/payouts')}
    `),
  };
}

export function kycRequestedEmail(businessName: string, level: string, documentsNeeded: string[]) {
  const docList = documentsNeeded.map(d => `<li>${d}</li>`).join('');
  return {
    subject: `Verification required for ${businessName}`,
    html: wrap(`
      ${h('Verification Required')}
      ${p(`To unlock higher payout limits for <strong>${businessName}</strong>, we need you to verify your business.`)}
      ${table(kv('Requested Level', level))}
      ${p('<strong>Documents needed:</strong>')}
      <ul style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.8;color:#3f3f46">
        ${docList}
      </ul>
      ${btn('Upload Documents', 'https://app.waaiio.com/dashboard/verification')}
      ${p('Verification typically takes 1-2 business days after submission.')}
    `),
  };
}

export function kycApprovedEmail(businessName: string, level: string, newLimit: string) {
  return {
    subject: `Verification approved — ${businessName}`,
    html: wrap(`
      ${h('Verification Approved!')}
      ${p(`<strong>${businessName}</strong> has been verified at the <strong>${level}</strong> level.`)}
      ${table(
        kv('Level', level) +
        kv('Monthly Payout Limit', newLimit)
      )}
      ${p('You can now receive payouts up to your new limit.')}
      ${btn('View Dashboard', 'https://app.waaiio.com/dashboard')}
    `),
  };
}

export function kycRejectedEmail(businessName: string, reason: string) {
  return {
    subject: `Verification update — ${businessName}`,
    html: wrap(`
      ${h('Verification Not Approved')}
      ${p(`We were unable to verify <strong>${businessName}</strong> at this time.`)}
      ${table(kv('Reason', reason))}
      ${p('Please review the feedback, update your documents, and resubmit.')}
      ${btn('Resubmit Documents', 'https://app.waaiio.com/dashboard/verification')}
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
    subject: `Booking confirmed at ${businessName} ${confirmationEmoji}`,
    html: wrap(`
      ${h(`Booking Confirmed ${confirmationEmoji}`)}
      ${p(`Hi ${firstName}, your booking at <strong>${businessName}</strong> is confirmed!`)}
      ${table(
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${referenceCode}</code>`) +
        kv('Date', date) +
        kv('Time', time) +
        kv(quantityLabel, String(quantity)) +
        (amount > 0 ? kv('Amount', amountDisplay) : '')
      )}
      ${p("We'll send you a reminder before your booking. See you soon!")}
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
    subject: `Reminder: Your booking at ${businessName} is tomorrow`,
    html: wrap(`
      ${h('Booking Reminder')}
      ${p(`Hi ${guestName}, this is a friendly reminder that your appointment at <strong>${businessName}</strong> is tomorrow.`)}
      ${table(
        kv('Service', serviceName) +
        kv('Date', date) +
        (time ? kv('Time', time) : '') +
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${referenceCode}</code>`)
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
      ${p(`<strong>${businessName}</strong> received a new payment.`)}
      ${table(
        kv('Service', service) +
        kv('Amount', amount)
      )}
      ${btn('View Payments', 'https://app.waaiio.com/dashboard/payments')}
    `),
  };
}

export function subscriptionActivatedEmail(businessName: string, tier: string, trialEnds: string) {
  return {
    subject: `Subscription activated — ${tier} plan`,
    html: wrap(`
      ${h('Subscription Activated')}
      ${p(`<strong>${businessName}</strong> is now on the <strong>${tier}</strong> plan.`)}
      ${table(
        kv('Plan', tier) +
        kv('Trial Ends', trialEnds)
      )}
      ${p('Enjoy all the features of your new plan!')}
      ${btn('View Dashboard', 'https://app.waaiio.com/dashboard')}
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
    const label = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
    return `<tr>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46">${label}</td>
      <td style="padding:6px 0;font-size:13px;color:#3f3f46;text-align:center">x${i.quantity}</td>
    </tr>`;
  }).join('');

  return {
    subject: `New order received — ${referenceCode}`,
    html: wrap(`
      ${h('New Order Received!')}
      ${p(`<strong>${businessName}</strong> just received a new order.`)}
      ${table(
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${referenceCode}</code>`) +
        kv('Customer', customerName) +
        kv('Total', `<strong>${totalAmount}</strong>`) +
        (deliveryAddress ? kv('Delivery', deliveryAddress) : '')
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
      ${p(`<strong>${businessName}</strong> just received a new booking.`)}
      ${table(
        kv('Reference', `<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;font-family:monospace">${referenceCode}</code>`) +
        kv('Customer', customerName) +
        kv('Date', date) +
        kv('Time', time) +
        kv(quantityLabel, String(quantity)) +
        (amount ? kv('Amount', amount) : '')
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
      ${p(`The 7-day free trial for <strong>${businessName}</strong> ends in <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong>.`)}
      ${p('After the trial, a small per-transaction fee will apply on the Free plan. Upgrade to Growth or Business to reduce fees and unlock more features.')}
      ${table(
        kv('Free Plan', '2.5% + flat fee per transaction') +
        kv('Growth Plan', '1.5% + flat fee — lower fees, more features') +
        kv('Business Plan', '1.0% + flat fee — lowest fees, all features')
      )}
      ${btn('Upgrade Now', 'https://app.waaiio.com/dashboard/settings')}
      ${p('Your bot will continue working on the Free plan — nothing breaks. You just start paying per-transaction fees.')}
    `),
  };
}

export function trialEndedEmail(businessName: string) {
  return {
    subject: `Your free trial has ended — ${businessName}`,
    html: wrap(`
      ${h('Free Trial Ended')}
      ${p(`The 7-day free trial for <strong>${businessName}</strong> has ended.`)}
      ${p('Your bot is still active on the <strong>Free plan</strong>. A 2.5% + flat fee now applies to each transaction.')}
      ${p('Upgrade to reduce your fees and unlock premium features like loyalty programs, broadcasts, e-signatures, and more.')}
      ${btn('Upgrade Plan', 'https://app.waaiio.com/dashboard/settings')}
    `),
  };
}

export function paymentFailedEmail(businessName: string, amount: string, reason: string) {
  return {
    subject: `Payment failed — ${businessName}`,
    html: wrap(`
      ${h('Payment Failed')}
      ${p(`A payment attempt for <strong>${businessName}</strong> was unsuccessful.`)}
      ${table(
        kv('Amount', amount) +
        kv('Reason', reason || 'Payment was declined')
      )}
      ${p('The customer may need to retry with a different payment method. No action is required from you — the customer has been notified.')}
      ${btn('View Dashboard', 'https://app.waaiio.com/dashboard')}
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
      ${p(`Here's how <strong>${businessName}</strong> did this week:`)}
      ${table(
        kv('Bookings', String(stats.bookings)) +
        kv('Revenue', stats.revenue) +
        kv('New Customers', String(stats.newCustomers)) +
        kv('Top Service', stats.topService)
      )}
      ${btn('View Full Analytics', 'https://app.waaiio.com/dashboard/analytics')}
      ${p('Keep up the great work!')}
    `),
  };
}
