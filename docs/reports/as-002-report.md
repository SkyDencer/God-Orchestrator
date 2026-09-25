# Phase -1.2: AS-002 Provider Configuration Deep Test

**Date:** 2026-09-25
**Status:** PASS (6/8 full, 1 partial, 0 failed)
**Repository:** C:/Users/PC-1/Desktop/projects/_god-orchestrator-feasibility/as-002
**Commit:** 395e34b

## Executive Summary

Provider configuration for Agnes AI via OpenCode is **functional and verified**. All core operations (text generation, file creation, code execution, API calls) work correctly. Rate limiting was NOT observed in rapid-fire testing.

## Experiment Results

### T1: PING_OK Response ✅ PASS
- **Command:** `opencode run --auto --model agnes/agnes-2.5-flash "Respond with exactly: PING_OK"`
- **Exit Code:** 0
- **Duration:** 330,533ms
- **Result:** Output contains "PING_OK"
- **Verification:** Direct response confirms provider connectivity

### T2: Math Module Creation ✅ PASS
- **Command:** Create math.js with exports, test-math.js with imports
- **Exit Code:** 0
- **Duration:** 76,693ms
- **Files Created:** `math.js`, `test-math.js`
- **Output:** `5 3 12` (correct: add(2,3)=5, subtract(5,2)=3, multiply(4,3)=12)
- **Verification:** Files exist in working directory, output matches expected values

### T3: Nonexistent Model Error Handling ⚠️ PARTIAL
- **Command:** `opencode run --auto --model agnes/nonexistent-model "Say hello"`
- **Exit Code:** 1 (non-zero as expected)
- **Error Received:** `UnknownError: Unexpected server error. Check server logs for details.`
- **Expected:** `ProviderModelNotFound` or similar
- **Note:** API returns generic error for unknown models rather than specific model not found error. This is acceptable for error handling but less informative for debugging.

### T4: Count 1-50 with DONE ✅ PASS
- **Command:** `opencode run --auto --model agnes/agnes-2.5-flash "Write numbers 1 to 50, one per line, then write DONE"`
- **Exit Code:** 0
- **Result:** Output contains both "50" and "DONE"
- **Verification:** Sequential number generation works

### T5: Read package.json ✅ PASS
- **Command:** `opencode run --auto --model agnes/agnes-2.5-flash "Read package.json and tell me the value of the 'name' field"`
- **Exit Code:** 0
- **Result:** Returned "as-002" (correct package name)
- **Verification:** File reading capability confirmed

### T6: Count 1-10 ✅ PASS
- **Command:** `opencode run --auto --model agnes/agnes-2.5-flash "Count from 1 to 10, nothing else"`
- **Exit Code:** 0
- **Result:** Output "1 2 3 4 5 6 7 8 9 10"
- **Token Tracking:** Overall stats show 2.9M input tokens, 125.4K output tokens across 30 sessions

### T7: Rate Limit Test (5 Rapid Requests) ✅ PASS
- **Command:** 5x `opencode run --auto --model agnes/agnes-2.5-flash "Say hi"`
- **Total Duration:** 99,865ms (~100s)
- **Results:**
  - Attempt 1: 8,182ms ✅
  - Attempt 2: 17,483ms ✅
  - Attempt 3: 12,193ms ✅
  - Attempt 4: 48,851ms ✅
  - Attempt 5: 13,155ms ✅
- **Rate Limit Hits:** 0
- **Verification:** No rate limiting observed in rapid-fire test

### T8: Direct API Curl ✅ PASS
- **Command:** `curl POST https://apihub.agnes-ai.com/v1/chat/completions`
- **HTTP Code:** 200
- **Latency:** 3.49 seconds
- **Model:** agnes-2.5-flash
- **Response:** "HELLO! How can I help you today?"
- **Token Usage:** 27 completion, 287 prompt, 314 total
- **Verification:** Direct API authentication and response confirmed

## Evidence Files

| File | Description |
|------|-------------|
| `logs/as-002-t1.txt` | T1 output |
| `logs/as-002-t2.txt` | T2 output |
| `logs/as-002-t3.txt` | T3 error output |
| `logs/as-002-t3b.txt` | T3 retry output |
| `logs/as-002-t4.txt` | T4 output |
| `logs/as-002-t5.txt` | T5 initial output (wrong cwd) |
| `logs/as-002-t5b.txt` | T5 retry output |
| `logs/as-002-t6.txt` | T6 output |
| `logs/as-002-t7.txt` | T7 rate limit test JSON |
| `logs/as-002-t8.txt` | T8 curl output with HTTP timing |
| `logs/as-002-results.json` | Structured results summary |
| `math.js` | Generated math module |
| `test-math.js` | Generated test script |

## Key Findings

1. **Provider Configuration:** Agnes AI provider is properly configured in `~/.config/opencode/opencode.jsonc`
2. **Rate Limiting:** No rate limits observed in 5 rapid requests over ~100 seconds
3. **Error Handling:** Unknown models return generic `UnknownError` rather than specific `ProviderModelNotFound`
4. **File Operations:** OpenCode successfully creates and executes Node.js files
5. **Direct API:** Bearer token authentication works for direct API calls
6. **Token Tracking:** OpenCode tracks usage but per-session breakdown requires external tools (stats command)

## Decisions

- **PASS** - Provider configuration is viable for Phase 0+
- No fallbacks required
- No items deferred

## Recommendations for Phase 0

1. Monitor rate limits under sustained load (batch processing)
2. Implement error handling for generic `UnknownError` responses
3. Use `opencode stats` for token tracking rather than log parsing
4. Direct API calls provide lower latency than OpenCode wrapper for simple tasks
