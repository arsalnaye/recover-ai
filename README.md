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

> **Automate recovery where it is safe, and keep humans in control where financial risk is higher.**

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


AI Architecture

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



Architecture

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

                              ▼
                           BL
