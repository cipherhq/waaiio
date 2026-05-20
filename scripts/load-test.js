import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const pageLoadTime = new Trend('page_load_time');

// Test configuration: ramp to 100 virtual users
export const options = {
  stages: [
    { duration: '15s', target: 25 },   // Ramp up to 25 users
    { duration: '15s', target: 50 },   // Ramp to 50
    { duration: '15s', target: 100 },  // Ramp to 100
    { duration: '30s', target: 100 },  // Hold at 100 for 30s
    { duration: '15s', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'],  // 95% of requests under 3s
    errors: ['rate<0.05'],               // Less than 5% error rate
  },
};

const BASE_URL = 'https://www.waaiio.com';

export default function () {
  // ── Public Pages (no auth needed) ──
  group('Public Pages', () => {
    // Homepage
    let res = http.get(`${BASE_URL}/`);
    check(res, { 'homepage 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
    pageLoadTime.add(res.timings.duration);

    sleep(0.5);

    // Pricing
    res = http.get(`${BASE_URL}/pricing`);
    check(res, { 'pricing 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
    pageLoadTime.add(res.timings.duration);

    sleep(0.5);

    // Directory
    res = http.get(`${BASE_URL}/directory`);
    check(res, { 'directory 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
    pageLoadTime.add(res.timings.duration);

    sleep(0.3);

    // About
    res = http.get(`${BASE_URL}/about`);
    check(res, { 'about 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);

    sleep(0.3);

    // Contact
    res = http.get(`${BASE_URL}/contact`);
    check(res, { 'contact 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
  });

  // ── API Endpoints (public, no auth) ──
  group('Public API', () => {
    // Health check
    let res = http.get(`${BASE_URL}/api/health`);
    check(res, { 'health 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);

    sleep(0.3);

    // Directory API
    res = http.get(`${BASE_URL}/api/directory`);
    check(res, { 'directory API 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);

    sleep(0.3);

    // FAQ API (requires auth — expect 401)
    res = http.get(`${BASE_URL}/api/faq`);
    check(res, { 'faq API 401 (auth required)': (r) => r.status === 401 });
    errorRate.add(res.status >= 500);
  });

  // ── Auth Pages (render check, no login) ──
  group('Auth Pages', () => {
    let res = http.get(`${BASE_URL}/login`);
    check(res, { 'login 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);

    sleep(0.3);

    res = http.get(`${BASE_URL}/signup`, { redirects: 0 });
    check(res, { 'signup redirects': (r) => r.status === 307 || r.status === 302 || r.status === 200 });
    errorRate.add(res.status >= 500);

    sleep(0.3);

    res = http.get(`${BASE_URL}/get-started`);
    check(res, { 'get-started 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
  });

  // ── Dashboard (expects redirect to login — tests middleware speed) ──
  group('Dashboard Auth Gate', () => {
    const res = http.get(`${BASE_URL}/dashboard`, { redirects: 0 });
    check(res, {
      'dashboard redirects to login': (r) => r.status === 307 || r.status === 302 || r.status === 308,
    });
    errorRate.add(res.status >= 500);
  });

  // ── Static Assets ──
  group('Static Assets', () => {
    const res = http.get(`${BASE_URL}/robots.txt`);
    check(res, { 'robots.txt 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);

    sleep(0.2);

    const res2 = http.get(`${BASE_URL}/sitemap.xml`);
    check(res2, { 'sitemap 200': (r) => r.status === 200 });
    errorRate.add(res2.status !== 200);
  });

  sleep(1); // Think time between iterations
}
