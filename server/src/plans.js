'use strict';

// Authoritative plan list (the app only displays what the server returns).
const PLANS = {
  monthly: { id: 'monthly', name: 'Monthly', priceLabel: 'PKR 3,000', price: 3000, currency: 'PKR', months: 1, duration: '1 month' },
  six_months: { id: 'six_months', name: 'Six Months', priceLabel: 'PKR 10,000', price: 10000, currency: 'PKR', months: 6, duration: '6 months' },
  lifetime: { id: 'lifetime', name: 'Lifetime', priceLabel: 'PKR 20,000', price: 20000, currency: 'PKR', months: null, duration: 'One-time payment, never expires' },
};

// Calendar-month addition; the 31st becomes the month's last day if needed.
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

module.exports = { PLANS, addMonths };
