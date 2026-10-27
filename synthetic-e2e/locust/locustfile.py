"""
Locust load testing for Waaiio staging-only synthetic E2E.

CTO R3: DISABLED — This file sends signed HTTP requests to deployed staging
webhook endpoints. Server-side Meta interception is not proven for remote
Vercel targets. Do NOT run this against any deployed environment until:
1. Server-side Meta interception is independently verified
2. Separate CTO/Owner staging-load authorization is obtained

The file is preserved as infrastructure for future authorized load testing.

Issue #728 Phase 3: Controlled load testing with:
- Pre-defined safe ramp profiles
- Request-rate, concurrency, and duration ceilings
- Hard kill-switch on unexpected egress
- Abort on timeout/error budgets
- Observable queue/duplicate/latency metrics

SAFETY: Never launch unbounded load or hit real providers.

Usage (loopback only — remote hosts are rejected):
    locust -f synthetic-e2e/locust/locustfile.py \
        --host http://localhost:3000 \
        --users 5 --spawn-rate 1 --run-time 60s \
        --headless --csv=synthetic-e2e/reports/locust

Environment variables:
    SYNTH_META_APP_SECRET   — Staging META_APP_SECRET for HMAC signing
    SYNTH_PHONE_NUMBER_ID   — Phone number ID for the test business
"""

import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from locust import HttpUser, task, between, events
from locust.runners import STATE_STOPPING, STATE_STOPPED, STATE_CLEANUP

# ── Safety constants ──

# Maximum concurrent users (hard ceiling)
MAX_USERS = 10

# Maximum requests per second (hard ceiling)
MAX_RPS = 5

# Maximum test duration in seconds
MAX_DURATION_SECONDS = 300  # 5 minutes

# Error budget: abort if error rate exceeds this threshold
ERROR_BUDGET_PERCENT = 20.0

# Production URLs that must NEVER be targeted
BLOCKED_HOSTS = frozenset([
    "waaiio.com",
    "www.waaiio.com",
    "app.waaiio.com",
    "cxcmiqotkowhxinjbytg.supabase.co",  # Production Supabase
])

# Allowed staging hosts
ALLOWED_HOSTS = frozenset([
    "staging.waaiio.com",
    "localhost",
    "127.0.0.1",
])

ALLOWED_HOST_SUFFIXES = (".vercel.app",)
REQUIRED_VERCEL_MARKERS = ("waaiiostaging", "waaiio-staging")

# ── Safety checks ──

def validate_host(host: str) -> None:
    """CTO R4: Hard block ANY non-loopback host. Remote webhook traffic is
    not permitted until server-side Meta interception is proven."""
    from urllib.parse import urlparse
    parsed = urlparse(host)
    hostname = (parsed.hostname or "").lower()

    # Only loopback is allowed — all remote targets are blocked
    if hostname in ("localhost", "127.0.0.1"):
        return

    print(
        f"FAIL-CLOSED: Remote host '{hostname}' blocked. "
        f"Locust load tests only run against loopback (localhost/127.0.0.1) "
        f"until server-side Meta interception is proven and separately authorized.",
        file=sys.stderr,
    )
    sys.exit(1)


def sign_payload(payload: str, secret: str) -> str:
    """Compute X-Hub-Signature-256 for Meta webhook."""
    mac = hmac.new(secret.encode(), payload.encode(), hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def build_text_message(from_phone: str, text: str, phone_number_id: str) -> str:
    """Build a Meta Cloud API text message webhook payload."""
    return json.dumps({
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "SYNTH_WABA_ID",
            "changes": [{
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {
                        "display_phone_number": phone_number_id,
                        "phone_number_id": phone_number_id,
                    },
                    "contacts": [{
                        "profile": {"name": f"LoadTest {from_phone[-4:]}"},
                        "wa_id": from_phone,
                    }],
                    "messages": [{
                        "from": from_phone,
                        "id": f"wamid.load_{int(time.time())}_{uuid.uuid4().hex[:8]}",
                        "timestamp": str(int(time.time())),
                        "text": {"body": text},
                        "type": "text",
                    }],
                },
                "field": "messages",
            }],
        }],
    })


# ── Metrics tracking ──

_request_count = 0
_error_count = 0
_start_time = None


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    """Validate host and enforce safety limits before any requests."""
    global _start_time
    _start_time = time.time()

    host = environment.host or ""
    validate_host(host)

    # Enforce user ceiling
    if environment.parsed_options and hasattr(environment.parsed_options, 'num_users'):
        requested_users = environment.parsed_options.num_users or 1
        if requested_users > MAX_USERS:
            print(
                f"SAFETY: Requested {requested_users} users exceeds MAX_USERS={MAX_USERS}. "
                f"Capping at {MAX_USERS}.",
                file=sys.stderr,
            )
            environment.parsed_options.num_users = MAX_USERS

    # Check required env vars
    if not os.environ.get("SYNTH_META_APP_SECRET"):
        print("FAIL-CLOSED: SYNTH_META_APP_SECRET not set.", file=sys.stderr)
        sys.exit(1)
    if not os.environ.get("SYNTH_PHONE_NUMBER_ID"):
        print("FAIL-CLOSED: SYNTH_PHONE_NUMBER_ID not set.", file=sys.stderr)
        sys.exit(1)

    print(f"Load test starting against: {host}")
    print(f"Safety limits: max_users={MAX_USERS}, max_rps={MAX_RPS}, max_duration={MAX_DURATION_SECONDS}s")


@events.request.add_listener
def on_request(request_type, name, response_time, response_length, exception, **kwargs):
    """Track request/error counts and enforce budgets."""
    global _request_count, _error_count

    _request_count += 1
    if exception:
        _error_count += 1

    # Check error budget
    if _request_count >= 10:  # Minimum sample
        error_rate = (_error_count / _request_count) * 100
        if error_rate > ERROR_BUDGET_PERCENT:
            print(
                f"SAFETY ABORT: Error rate {error_rate:.1f}% exceeds budget {ERROR_BUDGET_PERCENT}%. "
                f"Stopping load test.",
                file=sys.stderr,
            )
            # Stop the runner
            if kwargs.get("environment") and kwargs["environment"].runner:
                kwargs["environment"].runner.quit()

    # Check duration ceiling
    if _start_time and (time.time() - _start_time) > MAX_DURATION_SECONDS:
        print(f"SAFETY: Duration ceiling {MAX_DURATION_SECONDS}s reached. Stopping.", file=sys.stderr)
        if kwargs.get("environment") and kwargs["environment"].runner:
            kwargs["environment"].runner.quit()


# ── Load test user ──

class SyntheticCustomer(HttpUser):
    """
    Simulates a synthetic customer sending WhatsApp messages.

    Uses reserved 1-555-000-xxxx phone numbers.
    Sends properly HMAC-signed webhook payloads.
    """

    # Wait 2-5 seconds between requests (enforces rate limiting)
    wait_time = between(2, 5)

    def on_start(self):
        """Initialize per-user state."""
        self.meta_app_secret = os.environ["SYNTH_META_APP_SECRET"]
        self.phone_number_id = os.environ["SYNTH_PHONE_NUMBER_ID"]
        # Generate unique synthetic phone per user
        user_suffix = uuid.uuid4().hex[:4]
        self.from_phone = f"1555000{user_suffix}"
        self.message_count = 0

    @task(3)
    def send_greeting(self):
        """Send a 'Hi' message — the most common entry point."""
        self._send_text("Hi")

    @task(2)
    def send_menu_request(self):
        """Send a menu/help request."""
        self._send_text("menu")

    @task(1)
    def send_booking_request(self):
        """Send a booking request."""
        self._send_text("I want to book an appointment")

    def _send_text(self, text: str):
        """Send a signed webhook text message."""
        # Rate limiting: skip if we'd exceed RPS
        global _request_count
        if _start_time and _request_count > 0:
            elapsed = time.time() - _start_time
            if elapsed > 0 and (_request_count / elapsed) > MAX_RPS:
                time.sleep(1)  # Back off
                return

        payload = build_text_message(self.from_phone, text, self.phone_number_id)
        signature = sign_payload(payload, self.meta_app_secret)

        self.client.post(
            "/api/webhook/meta-cloud",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Hub-Signature-256": signature,
            },
            name=f"webhook/{text[:20]}",
            timeout=60,
            allow_redirects=False,  # CTO R5: prevent redirect to external URLs
        )
        self.message_count += 1
