#!/bin/bash
# Shortest AI E2E Test Runner - Rate-limit aware with dynamic cooldown & retry
# Runs tests one file at a time with smart cooldown based on token usage

MIN_COOLDOWN=${MIN_COOLDOWN:-120}  # minimum seconds between tests
RATE_LIMIT=${RATE_LIMIT:-30000}    # tokens per minute limit
MODE=${MODE:-"--headless"}          # --headless or empty for headed
LOG_DIR=".shortest/run-logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_FILE="$LOG_DIR/results_$TIMESTAMP.txt"
PREV_TOKENS=0

mkdir -p "$LOG_DIR"

# Collect test files
if [ -n "$1" ]; then
  TEST_FILES=$(find "$1" -name "*.test.ts" | sort)
else
  TEST_FILES=$(find __shortest__ -name "*.test.ts" | sort)
fi

TOTAL=$(echo "$TEST_FILES" | wc -l | tr -d ' ')
PASSED=0
FAILED=0
RATE_LIMIT_FAILS=0
CURRENT=0

# Calculate dynamic cooldown based on token usage
calc_cooldown() {
  local tokens=$1
  # Remove commas from token count
  tokens=$(echo "$tokens" | tr -d ',')
  if [ "$tokens" -gt "$RATE_LIMIT" ] 2>/dev/null; then
    # Need to wait for tokens to expire from the 1-minute sliding window
    # Formula: ceil(tokens / rate_limit) * 70 seconds (extra buffer)
    local minutes=$(( (tokens + RATE_LIMIT - 1) / RATE_LIMIT ))
    local cooldown=$(( minutes * 70 ))
    if [ "$cooldown" -lt "$MIN_COOLDOWN" ]; then
      echo "$MIN_COOLDOWN"
    else
      echo "$cooldown"
    fi
  else
    echo "$MIN_COOLDOWN"
  fi
}

# Extract token count as a number from test output
extract_token_count() {
  local output="$1"
  local token_str=$(echo "$output" | grep -o '[0-9,]* tokens' | head -1)
  echo "$token_str" | tr -d ', tokens' | tr -d 'a-z'
}

# Run a single test file and return status
run_test() {
  local test_file="$1"
  local attempt="$2"
  local log_suffix="$3"

  OUTPUT=$(npx shortest $MODE "$test_file" 2>&1)

  TOKENS_DISPLAY=$(echo "$OUTPUT" | grep -o '[0-9,]* tokens' | head -1)
  TOKENS_DISPLAY=${TOKENS_DISPLAY:-"0 tokens"}
  TOKEN_NUM=$(extract_token_count "$OUTPUT")
  TOKEN_NUM=${TOKEN_NUM:-0}
  DURATION=$(echo "$OUTPUT" | grep 'Duration' | sed 's/.*Duration[[:space:]]*//' | tr -d ' ')
  DURATION=${DURATION:-"?"}

  # Save full output
  echo "$OUTPUT" > "$LOG_DIR/${TIMESTAMP}_${log_suffix}.log"

  if echo "$OUTPUT" | grep -q "Error processing file"; then
    if [ "$TOKEN_NUM" -eq 0 ] 2>/dev/null || [ -z "$TOKEN_NUM" ]; then
      TEST_STATUS="RATE_LIMIT"
    else
      TEST_STATUS="FAIL"
    fi
  elif echo "$OUTPUT" | grep -q "0 passed"; then
    if [ "$TOKEN_NUM" -eq 0 ] 2>/dev/null || [ -z "$TOKEN_NUM" ]; then
      TEST_STATUS="RATE_LIMIT"
    else
      TEST_STATUS="FAIL"
    fi
  else
    TEST_STATUS="PASS"
  fi
}

echo "=========================================="
echo " Shortest AI E2E Test Runner v2"
echo " Total test files: $TOTAL"
echo " Min cooldown: ${MIN_COOLDOWN}s"
echo " Rate limit: ${RATE_LIMIT} tokens/min"
echo " Mode: $MODE"
echo " Results: $RESULTS_FILE"
echo "=========================================="
echo ""

for TEST_FILE in $TEST_FILES; do
  CURRENT=$((CURRENT + 1))
  BASENAME=$(basename "$TEST_FILE" .test.ts)
  echo "[$CURRENT/$TOTAL] Running: $TEST_FILE"
  echo "  Started: $(date '+%H:%M:%S')"

  # Run the test
  run_test "$TEST_FILE" 1 "$BASENAME"

  if [ "$TEST_STATUS" = "RATE_LIMIT" ]; then
    echo "  RATE LIMITED (0 tokens, $DURATION) — retrying after 180s..."
    RATE_LIMIT_FAILS=$((RATE_LIMIT_FAILS + 1))
    sleep 180

    # Retry once
    echo "  Retrying: $(date '+%H:%M:%S')"
    run_test "$TEST_FILE" 2 "${BASENAME}_retry"
  fi

  if [ "$TEST_STATUS" = "PASS" ]; then
    PASSED=$((PASSED + 1))
    echo "  PASSED ($TOKENS_DISPLAY, $DURATION)"
    echo "PASS | $TEST_FILE | $TOKENS_DISPLAY | $DURATION" >> "$RESULTS_FILE"
  elif [ "$TEST_STATUS" = "RATE_LIMIT" ]; then
    FAILED=$((FAILED + 1))
    echo "  FAILED — RATE LIMITED ($TOKENS_DISPLAY, $DURATION)"
    echo "RATE_LIMIT | $TEST_FILE | $TOKENS_DISPLAY | $DURATION" >> "$RESULTS_FILE"
  else
    FAILED=$((FAILED + 1))
    echo "  FAILED ($TOKENS_DISPLAY, $DURATION)"
    echo "FAIL | $TEST_FILE | $TOKENS_DISPLAY | $DURATION" >> "$RESULTS_FILE"
  fi

  # Dynamic cooldown based on tokens used
  if [ "$CURRENT" -lt "$TOTAL" ]; then
    COOLDOWN=$(calc_cooldown "$TOKEN_NUM")
    echo "  Tokens used: $TOKEN_NUM → cooling down ${COOLDOWN}s..."
    sleep "$COOLDOWN"
  fi
  echo ""
done

echo "=========================================="
echo " RESULTS SUMMARY"
echo "=========================================="
echo " Total files: $TOTAL"
echo " Passed: $PASSED"
echo " Failed: $FAILED"
echo " Rate limit retries: $RATE_LIMIT_FAILS"
echo " Results saved to: $RESULTS_FILE"
echo "=========================================="
echo ""
cat "$RESULTS_FILE"
