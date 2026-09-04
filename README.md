# RecoverAI — AI-Powered Payment Recovery

RecoverAI is an AI-powered payment recovery system designed to identify and recover **failed and overdue payments** through intelligent, automated recovery workflows.

It combines a local Large Language Model (LLM), deterministic financial guardrails, Supabase persistence, and Razorpay Payment Links to create a controlled recovery system that can operate autonomously within predefined limits.

---

## Overview

Failed and overdue payments can lead to significant revenue loss when businesses rely entirely on manual follow-ups.

RecoverAI addresses this by:

- Analyzing payment recovery cases using a local LLM
- Assessing recovery risk
- Recommending an appropriate recovery action
- Automatically creating Razorpay Payment Links when permitted
- Tracking payment attempts
- Reacting to successful and failed payments through webhooks
- Blocking cases after repeated failures
- Requiring human approval for high-value recoveries
- Respecting customer opt-out preferences

The system is designed around a simple principle:

**Automate recovery where it is safe, and keep humans in control where financial risk is higher.**

---

## Key Features

### AI-Assisted Recovery Decisions

RecoverAI uses a locally hosted Qwen3 model through Ollama to analyze payment cases and provide:

- Risk assessment
- Confidence score
- Recommended recovery action
- Reasoning for the recommendation

The AI acts as a decision-support layer, while critical financial rules are enforced deterministically by the backend.

---

### Failed Payment Recovery

RecoverAI tracks failed payment attempts and changes the recovery state accordingly.

```text
READY
  │
  ▼
Create Payment Link
  │
  ▼
EXECUTING
  │
  ├── Payment succeeds ──► RECOVERED
  │
  └── Payment fails ─────► READY
                              │
                              ▼
                         Second failure
                              │
                              ▼
                           BLOCKED
```
Payment Link creation itself does not increase the failed-attempt counter.
Only an actual failed payment increments the counter.

## Payment State Management

RecoverAI maintains a clear state for each recovery case.
```text
PENDING
   ↓
READY
   ↓
EXECUTING
   ↓
┌───────────────┐
│               │
▼               ▼
RECOVERED      READY
               │
               ▼
            BLOCKED
```
## Attempt Semantics

Initial case
Attempts = 0

Payment Link created
Attempts = 0

Payment fails
Attempts = 1

Payment fails again
Attempts = 2
Status = BLOCKED

Payment succeeds
Status = RECOVERED
Attempts unchanged

This ensures that creating a recovery action is not incorrectly treated as a failed payment attempt.

## Razorpay Integration

RecoverAI integrates with Razorpay Test Mode for payment recovery.

The system uses Razorpay Payment Links and webhooks to track payment outcomes.

Supported Webhook Events
payment.failed
payment_link.paid
Successful Payment

When a Payment Link is successfully paid:

Payment → SUCCESS
Recovery Case → RECOVERED
Failed Payment

When a payment fails:

Failed Payment
      ↓
Attempt Count + 1
      ↓
Attempts < 2 → READY
Attempts = 2 → BLOCKED

Webhook requests are verified using the configured Razorpay webhook secret.

## AI Architecture

RecoverAI uses a local LLM through Ollama.
```text
Payment / Recovery Case
          │
          ▼
     Recovery API
          │
          ▼
       Qwen3 LLM
          │
          ▼
 Risk + Recommendation
          │
          ▼
Deterministic Guardrails
          │
          ▼
 Recovery Action
```
The LLM is therefore not the final authority for financial safety.

The backend validates the AI recommendation against application-level rules before executing an action.

## Architecture

                    ┌─────────────────────┐
                    │     RecoverAI UI    │
                    │      Next.js        │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Recovery APIs     │
                    │     Next.js         │
                    └───────┬─────┬───────┘
                            │     │
              ┌─────────────┘     └─────────────┐
              ▼                                 ▼
      ┌──────────────┐                  ┌──────────────┐
      │   Ollama     │                  │   Supabase   │
      │    Qwen3     │                  │   Database   │
      └──────────────┘                  └──────────────┘
                                              
                            │
                            ▼
                    ┌─────────────────────┐
                    │      Razorpay       │
                    │   Payment Links     │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Razorpay Webhooks   │
                    │ payment.failed     │
                    │ payment_link.paid  │
                    └─────────────────────┘

## Security & Safety

Important protections include:

* Server-side financial limits
* Customer opt-out enforcement
* Successful-payment checks
* Maximum failed-attempt protection
* Duplicate execution prevention
* Razorpay webhook signature verification
* Human approval for high-value recoveries
* Local AI inference instead of sending payment data to an external LLM API

AI recommendations are treated as inputs to the recovery system rather than unrestricted commands.

## Current Status

RecoverAI currently demonstrates:

* AI-assisted recovery analysis
* Failed payment recovery
* Overdue payment recovery
* Risk classification
* Autonomous recovery limits
* Razorpay Payment Link creation
* Razorpay payment success tracking
* Razorpay payment failure tracking
* Recovery attempt tracking
* Automatic blocking after repeated failures
* Customer opt-out protection
* Supabase persistence
* Local LLM inference through Ollama
* Future Improvements

## Potential future improvements include:

* More sophisticated overdue-payment strategies
* Automated reminder workflows
* Improved customer history analytics
* Recovery success-rate analytics
* Adaptive recovery strategies
* More advanced risk calibration
* Production Razorpay integration
* Authentication and role-based access
* Audit logs for financial decisions
* Evaluation of AI recommendations against historical recovery outcomes
## Disclaimer

RecoverAI is an academic/software prototype designed for demonstration and experimentation.

It currently uses Razorpay Test Mode and should not be considered a production financial recovery system without additional security, compliance, monitoring, testing, and operational controls.

## Author

Arsalna Yasir Elahi

B.Tech Computer Science & Engineering

GitHub: https://github.com/arsalnaye                    
