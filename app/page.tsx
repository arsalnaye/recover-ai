"use client";

import { useEffect, useState } from "react";

type RecoveryCase = {
  id: string;
  customer: string;
  email: string;
  amount: number;
  problem: string;

  status:
    | "Review"
    | "Ready"
    | "Blocked"
    | "Executing"
    | "Recovered";

  risk: "Low" | "Medium" | "High";

  attempts: number;

  optedOut: boolean;

  paymentStatus: string;

  customerHistory: {
    successfulPayments: number;
    averagePayment: number;
  };
};

type AIDecision = {
  recommendation?: string;
  confidence?: number;
  reason?: string;
  status?: string;
};

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function Home() {
  const [recoveryCases, setRecoveryCases] =
    useState<RecoveryCase[]>([]);

  const [metrics, setMetrics] = useState({
    revenueAtRisk: 0,
    recoverableRevenue: 0,
    recoveredRevenue: 0,
  });

  const [selectedCase, setSelectedCase] =
    useState<RecoveryCase | null>(null);

  const [approved, setApproved] =
    useState(false);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState<string | null>(null);

  const [aiLoading, setAiLoading] =
    useState(false);

  const [aiError, setAiError] =
    useState<string | null>(null);

  const [aiDecision, setAiDecision] =
    useState<AIDecision | null>(null);

  const [executionLoading, setExecutionLoading] =
    useState(false);

  const [executionError, setExecutionError] =
    useState<string | null>(null);

  const [paymentLink, setPaymentLink] =
    useState<string | null>(null);

  /*
   * =========================================================
   * LOAD RECOVERY CASES
   * =========================================================
   */

  async function loadRecoveryCases(
    showLoading = false
  ) {
    try {
      if (showLoading) {
        setLoading(true);
      }

      setError(null);

      const response = await fetch(
        "/api/recovery",
        {
          cache: "no-store",
        }
      );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.success
      ) {
        throw new Error(
          result.error ||
            "Failed to load recovery cases"
        );
      }

      const transformedCases: RecoveryCase[] =
        (result.cases ?? []).map(
          (item: any) => {
            const payment =
              Array.isArray(
                item.payments
              )
                ? item.payments[0]
                : item.payments;

            const customer =
              Array.isArray(
                payment?.customers
              )
                ? payment.customers[0]
                : payment?.customers;

            const paymentAmount =
              Number(
                payment?.amount ?? 0
              );

            /*
             * =================================================
             * RISK POLICY
             * =================================================
             *
             * > ₹10,000       -> High
             * ₹5,000-₹10,000  -> Medium
             * < ₹5,000        -> Low
             *
             * Queue risk is intentionally based on financial
             * exposure rather than allowing Qwen's raw score
             * to determine the displayed financial risk tier.
             */

            let risk:
              RecoveryCase["risk"] =
              "Low";

            if (paymentAmount > 10000) {
              risk = "High";
            } else if (
              paymentAmount >= 5000
            ) {
              risk = "Medium";
            } else {
              risk = "Low";
            }

            /*
             * =================================================
             * STATUS
             * =================================================
             */

            let status:
              RecoveryCase["status"] =
              "Review";

            if (
              item.status === "READY" ||
              item.status === "APPROVED"
            ) {
              status = "Ready";
            } else if (
              item.status === "EXECUTING"
            ) {
              status = "Executing";
            } else if (
              item.status === "RECOVERED"
            ) {
              status = "Recovered";
            } else if (
              item.status === "BLOCKED"
            ) {
              status = "Blocked";
            } else if (
              item.status ===
              "MAX_ATTEMPTS_REACHED"
            ) {
              status = "Review";
            }

            /*
             * =================================================
             * CUSTOMER HISTORY
             * =================================================
             */

            const customerHistory =
              item.customer_history ?? {};

            return {
              id: String(item.id),

              customer:
                customer?.name ??
                "Unknown Customer",

              email:
                customer?.email ??
                "No email available",

              amount:
                paymentAmount,

              problem:
                payment?.status ===
                "OVERDUE"
                  ? "Payment overdue"
                  : payment?.status ===
                      "FAILED"
                    ? "Payment failed"
                    : payment?.status ===
                        "SUCCESS"
                      ? "Payment recovered"
                      : "Payment issue",

              status,

              risk,

              attempts:
                Number(
                  item.attempt_count ??
                    0
                ),

              optedOut:
                Boolean(
                  customer?.opted_out ??
                    false
                ),

              paymentStatus:
                String(
                  payment?.status ??
                    "UNKNOWN"
                ).toUpperCase(),

              customerHistory: {
                successfulPayments:
                  Number(
                    customerHistory
                      ?.successfulPayments ??
                      0
                  ),

                averagePayment:
                  Number(
                    customerHistory
                      ?.averagePayment ??
                      0
                  ),
              },
            };
          }
        );

      /*
       * IMPORTANT:
       *
       * Do not sort again here.
       *
       * The API already provides the queue ordering.
       */

      setRecoveryCases(
        transformedCases
      );

      setMetrics({
        revenueAtRisk:
          Number(
            result.metrics
              ?.revenueAtRisk ?? 0
          ),

        recoverableRevenue:
          Number(
            result.metrics
              ?.recoverableRevenue ?? 0
          ),

        recoveredRevenue:
          Number(
            result.metrics
              ?.recoveredRevenue ?? 0
          ),
      });

      /*
       * Keep currently opened case synchronized.
       */

      setSelectedCase(
        (current) => {
          if (!current) {
            return null;
          }

          const updated =
            transformedCases.find(
              (item) =>
                item.id ===
                current.id
            );

          if (!updated) {
            return current;
          }

          /*
           * Clear stale local payment link after recovery
           * or when the case is ready for another attempt.
           */

          if (
            updated.status === "Ready" ||
            updated.status === "Recovered" ||
            updated.attempts >= 2
          ) {
            setPaymentLink(null);
          }

          return {
            ...current,
            ...updated,
          };
        }
      );
    } catch (err) {
      console.error(
        "Failed to load recovery cases:",
        err
      );

      setError(
        "Unable to load recovery cases from Supabase."
      );
    } finally {
      setLoading(false);
    }
  }

  /*
   * =========================================================
   * INITIAL LOAD + AUTO REFRESH
   * =========================================================
   */

  useEffect(() => {
    loadRecoveryCases(true);

    const interval =
      setInterval(() => {
        loadRecoveryCases(false);
      }, 3000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  /*
   * =========================================================
   * OPEN RECOVERY CASE
   * =========================================================
   */

  function openRecoveryCase(
    item: RecoveryCase
  ) {
    setSelectedCase(item);

    setApproved(
      item.status === "Executing" ||
        item.status === "Recovered"
    );

    setAiDecision(null);

    setAiError(null);

    setExecutionError(null);

    setPaymentLink(null);
  }

  /*
   * =========================================================
   * AI ANALYSIS
   * =========================================================
   */

  async function analyzeCase(
    recoveryCaseId: string
  ) {
    try {
      setAiLoading(true);

      setAiError(null);

      setAiDecision(null);

      setExecutionError(null);

      setPaymentLink(null);

      setApproved(false);

      const response =
        await fetch(
          "/api/ai/analyze",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              recoveryCaseId,
            }),
          }
        );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.success
      ) {
        throw new Error(
          result.error ||
            "AI analysis failed"
        );
      }

      const aiResult =
        result.result ?? {};

      setAiDecision({
        recommendation:
          aiResult.recommendation ??
          aiResult.recommended_action,

        confidence:
          Number(
            aiResult.confidence ??
              0
          ),

        reason:
          aiResult.reason ??
          aiResult.ai_reason ??
          "AI analysis completed.",

        status:
          aiResult.status ??
          "READY",
      });
    } catch (err) {
      console.error(
        "AI analysis failed:",
        err
      );

      setAiError(
        err instanceof Error
          ? err.message
          : "AI analysis failed"
      );
    } finally {
      setAiLoading(false);
    }
  }

  /*
   * =========================================================
   * CAN EXECUTE AUTONOMOUS RECOVERY?
   * =========================================================
   *
   * This function is intentionally ONLY for autonomous
   * recovery.
   *
   * Human-approved high-value recovery has its own function.
   */

  function canExecuteRecovery() {
    if (!selectedCase) {
      return false;
    }

    if (!aiDecision) {
      return false;
    }

    if (
      selectedCase.status ===
        "Recovered" ||
      selectedCase.status ===
        "Executing" ||
      selectedCase.status ===
        "Blocked"
    ) {
      return false;
    }

    if (selectedCase.optedOut) {
      return false;
    }

    /*
     * High-value payments cannot use autonomous execution.
     */

    if (
      selectedCase.amount >
      10000
    ) {
      return false;
    }

    if (
      selectedCase.attempts >=
      2
    ) {
      return false;
    }

    if (
      selectedCase.paymentStatus ===
        "SUCCESS" ||
      selectedCase.paymentStatus ===
        "PAID" ||
      selectedCase.paymentStatus ===
        "CAPTURED" ||
      selectedCase.paymentStatus ===
        "RECOVERED"
    ) {
      return false;
    }

    if (
      aiDecision.recommendation !==
      "CREATE_PAYMENT_LINK"
    ) {
      return false;
    }

    if (
      aiDecision.status !==
      "READY"
    ) {
      return false;
    }

    return true;
  }

  /*
   * =========================================================
   * EXECUTE AUTONOMOUS RECOVERY
   * =========================================================
   */

  async function executeRecovery(
    recoveryCaseId: string
  ) {
    if (executionLoading) {
      return;
    }

    if (!canExecuteRecovery()) {
      setExecutionError(
        "This recovery action is not allowed by the current policy."
      );

      return;
    }

    try {
      setExecutionLoading(true);

      setExecutionError(null);

      const response =
        await fetch(
          "/api/recovery/execute",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              recoveryCaseId,

              /*
               * Normal autonomous execution.
               *
               * The backend remains authoritative.
               */
              humanApproval: false,

              approvedBy: null,
            }),
          }
        );

      const result =
        await response.json();

      console.log(
        "Recovery execution response:",
        result
      );

      if (
        !response.ok ||
        !result.success
      ) {
        throw new Error(
          result.error ||
            "Recovery execution failed"
        );
      }

      /*
       * Existing payment link.
       */

      if (
        result.alreadyExecuted &&
        result.action
      ) {
        let storedResult: any =
          null;

        try {
          storedResult =
            typeof result.action
              .result ===
            "string"
              ? JSON.parse(
                  result.action.result
                )
              : result.action.result;
        } catch {
          storedResult = null;
        }

        const existingLink =
          storedResult?.payment_link ??
          storedResult?.paymentLink ??
          null;

        if (existingLink) {
          setPaymentLink(
            existingLink
          );
        }

        setApproved(true);

        await loadRecoveryCases();

        return;
      }

      /*
       * Newly generated payment link.
       */

      const generatedPaymentLink =
        result.paymentLink ??
        result.razorpay?.payment_link ??
        result.razorpay?.short_url ??
        null;

      if (
        generatedPaymentLink
      ) {
        setPaymentLink(
          generatedPaymentLink
        );
      }

      setApproved(true);

      /*
       * Get new attempt count.
       */

      const newAttemptCount =
        Number(
          result.attemptCount ??
            result.recovery
              ?.attempt ??
            result.attempt_count ??
            ((selectedCase?.attempts ??
              0) + 1)
        );

      /*
       * Immediately update UI.
       */

      setSelectedCase(
        (current) =>
          current
            ? {
                ...current,

                attempts:
                  newAttemptCount,

                status:
                  "Executing",
              }
            : null
      );

      setRecoveryCases(
        (current) =>
          current.map(
            (item) =>
              item.id ===
              recoveryCaseId
                ? {
                    ...item,

                    attempts:
                      newAttemptCount,

                    status:
                      "Executing",
                  }
                : item
          )
      );

      await loadRecoveryCases();
    } catch (err) {
      console.error(
        "Recovery execution failed:",
        err
      );

      setExecutionError(
        err instanceof Error
          ? err.message
          : "Recovery execution failed"
      );
    } finally {
      setExecutionLoading(false);
    }
  }

  /*
   * =========================================================
   * HUMAN-APPROVED RECOVERY
   * =========================================================
   *
   * This is the new demo-critical functionality.
   *
   * > ₹10,000:
   *
   * AI recommendation
   *       ↓
   * HUMAN_APPROVAL
   *       ↓
   * Merchant clicks Approve & Execute
   *       ↓
   * humanApproval = true
   *       ↓
   * Backend performs authoritative checks
   *       ↓
   * Razorpay Payment Link
   */

  async function executeHumanApprovedRecovery(
    recoveryCaseId: string
  ) {
    if (executionLoading) {
      return;
    }

    if (!selectedCase) {
      return;
    }

    /*
     * ---------------------------------------------------------
     * FRONTEND SAFETY CHECKS
     * ---------------------------------------------------------
     */

    if (
      selectedCase.amount <=
      10000
    ) {
      setExecutionError(
        "This case does not require human approval."
      );

      return;
    }

    if (
      selectedCase.optedOut
    ) {
      setExecutionError(
        "Recovery is blocked because the customer has opted out."
      );

      return;
    }

    if (
      selectedCase.attempts >=
      2
    ) {
      setExecutionError(
        "Maximum recovery attempts reached."
      );

      return;
    }

    if (
      selectedCase.paymentStatus ===
        "SUCCESS" ||
      selectedCase.paymentStatus ===
        "PAID" ||
      selectedCase.paymentStatus ===
        "CAPTURED" ||
      selectedCase.paymentStatus ===
        "RECOVERED"
    ) {
      setExecutionError(
        "Recovery is blocked because the payment has already succeeded."
      );

      return;
    }

    if (
      aiDecision?.recommendation !==
      "HUMAN_APPROVAL"
    ) {
      setExecutionError(
        "Human approval cannot be used unless the AI decision requires human approval."
      );

      return;
    }

    try {
      setExecutionLoading(true);

      setExecutionError(null);

      /*
       * Explicit merchant approval.
       *
       * The backend MUST verify this independently.
       */

      const response =
        await fetch(
          "/api/recovery/execute",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              recoveryCaseId,

              humanApproval: true,

              approvedBy:
                "merchant",
            }),
          }
        );

      const result =
        await response.json();

      console.log(
        "Human-approved recovery response:",
        result
      );

      if (
        !response.ok ||
        !result.success
      ) {
        throw new Error(
          result.error ||
            "Human-approved recovery failed"
        );
      }

      /*
       * Get newly generated payment link.
       */

      const generatedPaymentLink =
        result.paymentLink ??
        result.razorpay?.payment_link ??
        result.razorpay?.short_url ??
        null;

      if (
        generatedPaymentLink
      ) {
        setPaymentLink(
          generatedPaymentLink
        );
      }

      /*
       * Mark human approval locally.
       */

      setApproved(true);

      /*
       * Get new attempt count.
       */

      const newAttemptCount =
        Number(
          result.attemptCount ??
            result.recovery
              ?.attempt ??
            result.attempt_count ??
            ((selectedCase.attempts ??
              0) + 1)
        );

      /*
       * Update selected case immediately.
       */

      setSelectedCase(
        (current) =>
          current
            ? {
                ...current,

                attempts:
                  newAttemptCount,

                status:
                  "Executing",
              }
            : null
      );

      /*
       * Update queue immediately.
       */

      setRecoveryCases(
        (current) =>
          current.map(
            (item) =>
              item.id ===
              recoveryCaseId
                ? {
                    ...item,

                    attempts:
                      newAttemptCount,

                    status:
                      "Executing",
                  }
                : item
          )
      );

      /*
       * Refresh from Supabase.
       */

      await loadRecoveryCases();
    } catch (err) {
      console.error(
        "Human-approved recovery failed:",
        err
      );

      setExecutionError(
        err instanceof Error
          ? err.message
          : "Human-approved recovery failed"
      );
    } finally {
      setExecutionLoading(false);
    }
  }

  /*
   * =========================================================
   * REJECT HUMAN APPROVAL
   * =========================================================
   *
   * We intentionally do NOT pretend to write a rejection
   * record because the current API/schema supplied to us does
   * not provide a dedicated rejection endpoint.
   *
   * For the demo, Reject simply exits the approval action
   * without creating a Razorpay payment link.
   */

  function rejectHumanApproval() {
    setExecutionError(null);

    setAiError(null);

    setApproved(false);

    setPaymentLink(null);

    setAiDecision(null);
  }

  /*
   * =========================================================
   * UI
   * =========================================================
   */

  return (
    <main className="min-h-screen bg-[#f7f9fc] text-slate-900">

      {/* =====================================================
          HEADER
          ===================================================== */}

      <header className="border-b border-slate-200 bg-white">

        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">

          <div className="flex items-center gap-3">

            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-sm font-bold text-white">
              R
            </div>

            <div>

              <h1 className="text-lg font-bold tracking-tight">
                RecoverAI
              </h1>

              <p className="text-xs text-slate-500">
                AI Revenue Recovery Agent
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <div className="hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 sm:flex">

              <span className="h-2 w-2 rounded-full bg-emerald-500" />

              Razorpay Connected

            </div>

            <button
              type="button"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              Merchant
            </button>

          </div>

        </div>

      </header>

      {/* =====================================================
          MAIN
          ===================================================== */}

      <div className="mx-auto max-w-7xl px-6 py-8">

        {/* ===================================================
            HEADING
            =================================================== */}

        <div className="mb-8">

          <p className="mb-2 text-sm font-medium text-slate-500">
            Revenue Recovery Command Center
          </p>

          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">

            <div>

              <h2 className="text-3xl font-bold tracking-tight">
                Recover revenue before it slips away.
              </h2>

              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                RecoverAI identifies at-risk payments,
                explains recovery opportunities,
                and executes bounded recovery actions.
              </p>

            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">

              <p className="text-xs text-slate-500">
                Last analysis
              </p>

              <p className="mt-1 text-sm font-semibold">
                Just now
              </p>

            </div>

          </div>

        </div>

        {/* ===================================================
            KPI
            =================================================== */}

        <section className="grid gap-4 md:grid-cols-3">

          <MetricCard
            label="Revenue at risk"
            value={formatCurrency(
              metrics.revenueAtRisk
            )}
            description="Across failed and overdue payments"
            accent="dark"
          />

          <MetricCard
            label="Recoverable"
            value={formatCurrency(
              metrics.recoverableRevenue
            )}
            description="Within current recovery policies"
            accent="blue"
          />

          <MetricCard
            label="Recovered"
            value={formatCurrency(
              metrics.recoveredRevenue
            )}
            description="Successfully recovered revenue"
            accent="green"
          />

        </section>

        {/* ===================================================
            LOADING
            =================================================== */}

        {loading && (
          <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
            Loading recovery cases from Supabase...
          </div>
        )}

        {/* ===================================================
            ERROR
            =================================================== */}

        {error && (
          <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 shadow-sm">

            <p className="font-semibold">
              Unable to load recovery cases
            </p>

            <p className="mt-1">
              {error}
            </p>

          </div>
        )}

        {/* ===================================================
            QUEUE
            =================================================== */}

        {!loading &&
          !error && (
            <section className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">

              <div className="flex flex-col justify-between gap-3 border-b border-slate-200 px-6 py-5 sm:flex-row sm:items-center">

                <div>

                  <h3 className="font-semibold">
                    Recovery Queue
                  </h3>

                  <p className="mt-1 text-sm text-slate-500">
                    AI-identified opportunities requiring action.
                  </p>

                </div>

                <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
                  {recoveryCases.length} active cases
                </div>

              </div>

              {recoveryCases.length ===
              0 ? (

                <div className="px-6 py-10 text-center">

                  <p className="font-medium text-slate-700">
                    No recovery cases found.
                  </p>

                  <p className="mt-1 text-sm text-slate-500">
                    Supabase currently has no recovery opportunities.
                  </p>

                </div>

              ) : (

                <div className="divide-y divide-slate-100">

                  {recoveryCases.map(
                    (item) => (

                      <div
                        key={item.id}
                        className="grid grid-cols-[minmax(220px,2fr)_minmax(100px,1fr)_minmax(150px,1.3fr)_minmax(80px,.7fr)_100px] items-center gap-4 px-6 py-5 transition hover:bg-slate-50"
                      >

                        {/* CUSTOMER */}

                        <div className="flex min-w-0 items-center gap-4">

                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 font-semibold text-slate-600">
                            {item.customer
                              .split(" ")
                              .map(
                                (name) =>
                                  name[0]
                              )
                              .join("")
                              .slice(0, 2)
                              .toUpperCase()}
                          </div>

                          <div className="min-w-0">

                            <p className="truncate font-semibold">
                              {item.customer}
                            </p>

                            <p className="truncate text-xs text-slate-500">
                              {item.email}
                            </p>

                          </div>

                        </div>

                        {/* AMOUNT */}

                        <div>

                          <p className="text-xs text-slate-400">
                            Amount
                          </p>

                          <p className="mt-1 text-sm font-semibold">
                            {formatCurrency(
                              item.amount
                            )}
                          </p>

                        </div>

                        {/* PROBLEM */}

                        <div>

                          <p className="text-xs text-slate-400">
                            Problem
                          </p>

                          <p className="mt-1 text-sm font-medium">
                            {item.problem}
                          </p>

                        </div>

                        {/* RISK */}

                        <div>

                          <p className="text-xs text-slate-400">
                            Risk
                          </p>

                          <div className="mt-1">
                            <RiskBadge
                              risk={
                                item.risk
                              }
                            />
                          </div>

                        </div>

                        {/* ACTION */}

                        <div className="flex justify-end">

                          <button
                            type="button"
                            onClick={() =>
                              openRecoveryCase(
                                item
                              )
                            }
                            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
                          >
                            Review
                          </button>

                        </div>

                      </div>

                    )
                  )}

                </div>

              )}

            </section>
          )}

        {/* ===================================================
            SYSTEM STATUS
            =================================================== */}

        <section className="mt-8 grid gap-4 lg:grid-cols-3">

          <StatusCard
            title="AI Decision Engine"
            status="Operational"
            description="Analyzing payment recovery opportunities"
          />

          <StatusCard
            title="Policy Engine"
            status="Operational"
            description="Financial guardrails are active"
          />

          <StatusCard
            title="Razorpay Test Mode"
            status="Connected"
            description="Ready for test payment actions"
          />

        </section>

        {/* ===================================================
            DEMO NOTICE
            =================================================== */}

        <div className="mt-8 rounded-xl border border-blue-100 bg-blue-50 px-5 py-4">

          <p className="text-sm font-semibold text-blue-900">
            Demo environment
          </p>

          <p className="mt-1 text-sm leading-6 text-blue-800">
            RecoverAI uses local Qwen3 AI analysis,
            deterministic financial guardrails,
            Supabase for persistence, and Razorpay Test Mode
            for recovery actions.
          </p>

        </div>

      </div>

      {/* =====================================================
          RECOVERY MODAL
          ===================================================== */}

      {selectedCase && (

        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">

          <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white shadow-2xl">

            {/* =================================================
                MODAL HEADER
                ================================================= */}

            <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5">

              <div>

                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Recovery Case
                </p>

                <h3 className="mt-1 text-xl font-bold">
                  {selectedCase.customer}
                </h3>

                <p className="mt-1 text-sm text-slate-500">

                  {formatCurrency(
                    selectedCase.amount
                  )}

                  {" "}

                  {selectedCase.status ===
                  "Recovered"
                    ? "recovered"
                    : "at risk"}

                </p>

              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedCase(null)
                }
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close recovery case"
              >
                ✕
              </button>

            </div>

            {/* =================================================
                MODAL BODY
                ================================================= */}

            <div className="space-y-6 px-6 py-6">

              {/* =================================================
                  CUSTOMER HISTORY
                  ================================================= */}

              <div>

                <h4 className="text-sm font-semibold">
                  Customer history
                </h4>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">

                  <HistoryItem
                    label="Successful payments"
                    value={String(
                      selectedCase
                        .customerHistory
                        .successfulPayments
                    )}
                  />

                  <HistoryItem
                    label="Average payment"
                    value={formatCurrency(
                      selectedCase
                        .customerHistory
                        .averagePayment
                    )}
                  />

                  <HistoryItem
                    label="Recovery attempts"
                    value={`${selectedCase.attempts}/2`}
                  />

                </div>

              </div>

              {/* =================================================
                  AI ANALYSIS
                  ================================================= */}

              <div className="rounded-xl border border-blue-100 bg-blue-50 p-5">

                <div className="flex items-center justify-between gap-3">

                  <h4 className="font-semibold text-blue-950">
                    AI Recommendation
                  </h4>

                  {aiDecision?.confidence !==
                    undefined && (

                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-blue-700">

                      {Math.round(
                        aiDecision.confidence *
                          100
                      )}

                      % confidence

                    </span>

                  )}

                </div>

                {/* ANALYZE BUTTON */}

                {!aiDecision &&
                  !aiLoading &&
                  !aiError &&
                  selectedCase.status !==
                    "Recovered" && (

                    <div>

                      <p className="mt-4 text-sm leading-6 text-blue-900">
                        Analyze this recovery case with
                        RecoverAI's local Qwen3 AI engine.
                      </p>

                      <button
                        type="button"
                        onClick={() =>
                          analyzeCase(
                            selectedCase.id
                          )
                        }
                        className="mt-4 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
                      >
                        Analyze with AI
                      </button>

                    </div>

                  )}

                {/* AI LOADING */}

                {aiLoading && (

                  <div className="mt-4 rounded-lg bg-white p-4">

                    <div className="flex items-center gap-3">

                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-700" />

                      <p className="text-sm font-medium text-blue-900">
                        Qwen3 is analyzing this recovery case...
                      </p>

                    </div>

                  </div>

                )}

                {/* AI ERROR */}

                {aiError && (

                  <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">

                    <p className="text-sm font-semibold text-red-800">
                      AI analysis failed
                    </p>

                    <p className="mt-1 text-sm text-red-700">
                      {aiError}
                    </p>

                    <button
                      type="button"
                      onClick={() =>
                        analyzeCase(
                          selectedCase.id
                        )
                      }
                      className="mt-3 rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white hover:bg-red-800"
                    >
                      Retry AI Analysis
                    </button>

                  </div>

                )}

                {/* AI RESULT */}

                {aiDecision && (

                  <>

                    <p className="mt-4 text-xs font-medium uppercase tracking-wider text-blue-600">
                      Recommended action
                    </p>

                    <p className="mt-1 font-semibold text-blue-950">

                      {aiDecision.recommendation ===
                      "CREATE_PAYMENT_LINK"
                        ? "Create payment recovery link"
                        : aiDecision.recommendation ===
                            "SEND_REMINDER"
                          ? "Send payment reminder"
                          : aiDecision.recommendation ===
                              "HUMAN_APPROVAL"
                            ? "Human approval required"
                            : aiDecision.recommendation ===
                                "DO_NOT_CONTACT"
                              ? "Do not contact customer"
                              : aiDecision.recommendation ??
                                "Review recovery case"}

                    </p>

                    <p className="mt-4 text-sm leading-6 text-blue-900">
                      {aiDecision.reason ??
                        "AI analysis completed."}
                    </p>

                    <div className="mt-4 rounded-lg border border-blue-100 bg-white p-3">

                      <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                        AI status
                      </p>

                      <p className="mt-1 text-sm font-semibold text-slate-800">
                        {aiDecision.status ??
                          "READY"}
                      </p>

                    </div>

                  </>

                )}

              </div>
              {/* =================================================
    FINANCIAL GUARDRAILS
    ================================================= */}

<div>

  <h4 className="text-sm font-semibold">
    Financial guardrails
  </h4>

  <div className="mt-3 space-y-2">

    {/* AMOUNT LIMIT */}

    <Guardrail
      text={
        selectedCase.amount <= 10000
          ? "Amount is within autonomous recovery limit"
          : "Amount is NOT within autonomous recovery limit"
      }
      passed={
        selectedCase.amount <= 10000
      }
      bold={
        selectedCase.amount > 10000
      }
    />

    {/* RECOVERY ATTEMPTS */}

    <Guardrail
      text={`Recovery attempts: ${selectedCase.attempts}/2`}
      passed={
        selectedCase.attempts < 2
      }
    />

    {/* DISCOUNT */}

    <Guardrail
      text="No discount required"
      passed={true}
    />

    {/* PAYMENT STATUS */}

    <Guardrail
      text={
        selectedCase.paymentStatus === "SUCCESS" ||
        selectedCase.paymentStatus === "PAID" ||
        selectedCase.paymentStatus === "CAPTURED" ||
        selectedCase.paymentStatus === "RECOVERED"
          ? "Payment has already succeeded"
          : "Payment has NOT already succeeded"
      }
      passed={
        selectedCase.paymentStatus === "SUCCESS" ||
        selectedCase.paymentStatus === "PAID" ||
        selectedCase.paymentStatus === "CAPTURED" ||
        selectedCase.paymentStatus === "RECOVERED"
      }
      bold={
        selectedCase.paymentStatus === "SUCCESS" ||
        selectedCase.paymentStatus === "PAID" ||
        selectedCase.paymentStatus === "CAPTURED" ||
        selectedCase.paymentStatus === "RECOVERED"
      }
    />

    {/* OPT-OUT */}

    <Guardrail
      text={
        selectedCase.optedOut
          ? "Customer has opted out of recovery communications"
          : "Customer has not opted out of recovery communications"
      }
      passed={
        !selectedCase.optedOut
      }
    />

  </div>

</div>  
              
              {/* =================================================
                  EXECUTION AREA
                  ================================================= */}

              <div className="border-t border-slate-200 pt-5">

                {/* EXECUTION ERROR */}

                {executionError && (

                  <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4">

                    <p className="text-sm font-semibold text-red-800">
                      Recovery execution failed
                    </p>

                    <p className="mt-1 text-sm text-red-700">
                      {executionError}
                    </p>

                  </div>

                )}

                {/* =================================================
                    RECOVERED
                    ================================================= */}

                {selectedCase.status ===
                "Recovered" ? (

                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">

                    <div className="flex items-start gap-3">

                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                        ✓
                      </div>

                      <div className="flex-1">

                        <p className="font-semibold text-emerald-800">
                          Payment recovered
                        </p>

                        <p className="mt-1 text-sm text-emerald-700">

                          RecoverAI successfully recovered{" "}

                          {formatCurrency(
                            selectedCase.amount
                          )}

                          {" "}from this customer through Razorpay.

                        </p>

                      </div>

                    </div>

                    <div className="mt-4 rounded-lg border border-emerald-200 bg-white p-4">

                      <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                        Recovery completed
                      </p>

                      <div className="mt-3 space-y-2 text-sm text-slate-700">

                        <p>
                          ✓ AI recovery recommendation generated
                        </p>

                        <p>
                          ✓ Recovery policy approved
                        </p>

                        <p>
                          ✓ Razorpay payment link created
                        </p>

                        <p>
                          ✓ Payment successfully received
                        </p>

                        <p>
                          ✓ Recovery case marked RECOVERED
                        </p>

                        <p>
                          ✓ Recovery attempts:{" "}
                          {selectedCase.attempts}/2
                        </p>

                      </div>

                    </div>

                  </div>

                ) : paymentLink &&
                  selectedCase.status ===
                    "Executing" ? (

                  /* =================================================
                     PAYMENT LINK CREATED
                     ================================================= */

                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">

                    <div className="flex items-start gap-3">

                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                        ✓
                      </div>

                      <div className="flex-1">

                        <p className="font-semibold text-emerald-800">
                          Recovery action executed
                        </p>

                        <p className="mt-1 text-sm text-emerald-700">

                          RecoverAI successfully created
                          a Razorpay Test Mode payment
                          link for{" "}

                          {formatCurrency(
                            selectedCase.amount
                          )}.

                        </p>

                        <a
                          href={paymentLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-4 inline-flex rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                        >
                          Open Payment Link →
                        </a>

                      </div>

                    </div>

                    <div className="mt-4 rounded-lg border border-emerald-200 bg-white p-4">

                      <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                        Execution status
                      </p>

                      <div className="mt-3 space-y-2 text-sm text-slate-700">

                        <p>
                          ✓ Policy guardrails passed
                        </p>

                        {selectedCase.amount >
                          10000 && (

                          <p>
                            ✓ Human approval recorded
                          </p>

                        )}

                        <p>
                          ✓ Razorpay payment link created
                        </p>

                        <p>
                          ✓ Recovery action recorded
                        </p>

                        <p>
                          ✓ Audit event recorded
                        </p>

                        <p>
                          ✓ Payment link sent:{" "}
                          {selectedCase.attempts}/2
                        </p>

                        <p>
                          ⏳ Waiting for customer payment
                        </p>

                      </div>

                    </div>

                  </div>

                ) : (

                  /* =================================================
                     NON-EXECUTING STATES
                     ================================================= */

                  <>

                    {/* =================================================
                        DO NOT CONTACT
                        ================================================= */}

                    {aiDecision?.recommendation ===
                      "DO_NOT_CONTACT" ||
                    selectedCase.optedOut ? (

                      <div className="rounded-xl border border-red-200 bg-red-50 p-5">

                        <div className="flex items-start gap-3">

                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500 text-white">
                            !
                          </div>

                          <div>

                            <p className="font-semibold text-red-800">
                              Recovery blocked
                            </p>

                            <p className="mt-1 text-sm leading-6 text-red-700">

                              This customer has opted out
                              of recovery communications.
                              No recovery action will be executed.

                            </p>

                          </div>

                        </div>

                      </div>

                    ) : aiDecision?.recommendation ===
                      "HUMAN_APPROVAL" ? (

                      /* =================================================
                         HUMAN APPROVAL
                         ================================================= */

                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">

                        <div className="flex items-start gap-3">

                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
                            !
                          </div>

                          <div className="flex-1">

                            <p className="font-semibold text-amber-900">
                              Human approval required
                            </p>

                            <p className="mt-1 text-sm leading-6 text-amber-800">

                              RecoverAI will not autonomously
                              execute this financial action because
                              the payment exceeds the ₹10,000
                              autonomous recovery limit.

                            </p>

                            {/* DECISION TRACE */}

                            <div className="mt-4 rounded-xl border border-amber-200 bg-white p-4">

                              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                                Decision trace
                              </p>

                              <div className="mt-3 space-y-3">

                                <DecisionTraceRow
                                  label="Payment amount"
                                  value={formatCurrency(
                                    selectedCase.amount
                                  )}
                                />

                                <DecisionTraceRow
                                  label="Autonomous limit"
                                  value="₹10,000"
                                />

                                <DecisionTraceRow
                                  label="Risk level"
                                  value={
                                    selectedCase.risk
                                  }
                                />

                                <DecisionTraceRow
                                  label="AI recommendation"
                                  value="Human approval"
                                />

                                <DecisionTraceRow
                                  label="AI confidence"
                                  value={
                                    aiDecision.confidence !==
                                    undefined
                                      ? `${Math.round(
                                          aiDecision.confidence *
                                            100
                                        )}%`
                                      : "N/A"
                                  }
                                />

                                <DecisionTraceRow
                                  label="Recovery attempts"
                                  value={`${selectedCase.attempts}/2`}
                                />

                              </div>

                            </div>

                            {/* WHY */}

                            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-100/60 p-4">

                              <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">
                                Why human review?
                              </p>

                              <p className="mt-1 text-sm leading-6 text-amber-900">

                                The AI may recommend a recovery
                                action, but RecoverAI's financial
                                policy prevents autonomous execution
                                above ₹10,000.

                              </p>

                            </div>

                            {/* APPROVAL BUTTONS */}

                            {!approved && (

                              <div className="mt-4">

                                <p className="text-xs font-medium text-amber-800">
                                  Review the AI decision before
                                  allowing the recovery action.
                                </p>

                                <div className="mt-3 grid gap-3 sm:grid-cols-2">

                                  <button
                                    type="button"
                                    disabled={
                                      executionLoading
                                    }
                                    onClick={
                                      rejectHumanApproval
                                    }
                                    className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    Reject
                                  </button>

                                  <button
                                    type="button"
                                    disabled={
                                      executionLoading ||
                                      selectedCase.attempts >=
                                        2 ||
                                      selectedCase.amount <=
                                        10000
                                    }
                                    onClick={() =>
                                      executeHumanApprovedRecovery(
                                        selectedCase.id
                                      )
                                    }
                                    className="rounded-lg bg-amber-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                                  >
                                    {executionLoading
                                      ? "Executing..."
                                      : "Approve & Execute"}
                                  </button>

                                </div>

                              </div>

                            )}

                          </div>

                        </div>

                      </div>

                    ) : aiDecision?.recommendation ===
                      "SEND_REMINDER" ? (

                      /* =================================================
                         SEND REMINDER
                         ================================================= */

                      <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">

                        <div className="flex items-start gap-3">

                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white">
                            i
                          </div>

                          <div>

                            <p className="font-semibold text-blue-800">
                              Reminder recommended
                            </p>

                            <p className="mt-1 text-sm leading-6 text-blue-700">

                              The AI recommends sending
                              a payment reminder. Automatic
                              reminder execution is not enabled
                              by the current recovery endpoint.

                            </p>

                          </div>

                        </div>

                      </div>

                    ) : selectedCase.status ===
                      "Blocked" ? (

                      /* =================================================
                         BLOCKED
                         ================================================= */

                      <div className="rounded-xl border border-red-200 bg-red-50 p-5">

                        <p className="font-semibold text-red-800">
                          Recovery blocked by policy
                        </p>

                        <p className="mt-1 text-sm text-red-700">
                          This recovery case cannot be executed.
                        </p>

                      </div>

                    ) : selectedCase.status ===
                      "Executing" ? (

                      /* =================================================
                         EXECUTING
                         ================================================= */

                      <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">

                        <p className="font-semibold text-blue-800">
                          Recovery already executing
                        </p>

                        <p className="mt-1 text-sm text-blue-700">
                          Waiting for the payment status to update.
                        </p>

                      </div>

                    ) : selectedCase.attempts >=
                      2 ? (

                      /* =================================================
                         MAX ATTEMPTS
                         ================================================= */

                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">

                        <p className="font-semibold text-amber-800">
                          Maximum recovery attempts reached
                        </p>

                        <p className="mt-1 text-sm text-amber-700">
                          No additional recovery attempt can be executed.
                        </p>

                      </div>

                    ) : selectedCase.amount >
                      10000 ? (

                      /* =================================================
                         HIGH VALUE WITHOUT AI DECISION
                         ================================================= */

                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">

                        <p className="font-semibold text-amber-800">
                          Human approval required
                        </p>

                        <p className="mt-1 text-sm text-amber-700">

                          {formatCurrency(
                            selectedCase.amount
                          )}

                          {" "}exceeds the ₹10,000 autonomous
                          recovery limit. Analyze the case with
                          AI to obtain the human-approval decision.

                        </p>

                      </div>

                    ) : aiDecision &&
                      aiDecision.recommendation !==
                        "CREATE_PAYMENT_LINK" ? (

                      /* =================================================
                         NON-EXECUTABLE AI ACTION
                         ================================================= */

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">

                        <p className="font-semibold text-slate-800">
                          Recovery action not executable
                        </p>

                        <p className="mt-1 text-sm text-slate-600">

                          The current AI recommendation
                          does not correspond to an executable
                          recovery endpoint.

                        </p>

                      </div>

                    ) : (

                      /* =================================================
                         READY / AUTONOMOUS RECOVERY
                         ================================================= */

                      <div className="space-y-3">

                        {selectedCase.attempts > 0 && (

                          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">

                            <p className="font-semibold text-amber-800">
                              Previous payment attempt
                            </p>

                            <p className="mt-1 text-sm text-amber-700">

                              A previous recovery payment link
                              has already been created.

                            </p>

                            <p className="mt-2 text-sm font-semibold text-amber-800">
                              {selectedCase.attempts}/2 recovery links used
                            </p>

                          </div>

                        )}

                        <button
                          type="button"
                          disabled={
                            !canExecuteRecovery() ||
                            executionLoading ||
                            aiLoading
                          }
                          onClick={() =>
                            executeRecovery(
                              selectedCase.id
                            )
                          }
                          className="w-full rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                        >

                          {executionLoading
                            ? "Creating Razorpay Payment Link..."
                            : !aiDecision
                              ? "AI Analysis Required"
                              : selectedCase.attempts > 0
                                ? "Send Payment Link Again"
                                : "Approve & Execute Recovery"}

                        </button>

                      </div>

                    )}

                  </>

                )}

              </div>

            </div>

          </div>

        </div>

      )}

    </main>
  );
}

/* =============================================================
   DECISION TRACE ROW
   ============================================================= */

function DecisionTraceRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2 last:border-b-0 last:pb-0">

      <span className="text-sm text-slate-500">
        {label}
      </span>

      <span className="text-right text-sm font-semibold text-slate-900">
        {value}
      </span>

    </div>
  );
}

/* =============================================================
   METRIC CARD
   ============================================================= */

function MetricCard({
  label,
  value,
  description,
  accent,
}: {
  label: string;
  value: string;
  description: string;
  accent: "dark" | "blue" | "green";
}) {
  const accentClasses = {
    dark: "bg-slate-900",
    blue: "bg-blue-600",
    green: "bg-emerald-600",
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">

      <div
        className={`mb-5 h-1 w-10 rounded-full ${accentClasses[accent]}`}
      />

      <p className="text-sm font-medium text-slate-500">
        {label}
      </p>

      <p className="mt-2 text-3xl font-bold tracking-tight">
        {value}
      </p>

      <p className="mt-2 text-xs leading-5 text-slate-500">
        {description}
      </p>

    </div>
  );
}

/* =============================================================
   RISK BADGE
   ============================================================= */

function RiskBadge({
  risk,
}: {
  risk: RecoveryCase["risk"];
}) {
  const classes = {
    Low:
      "bg-emerald-50 text-emerald-700",

    Medium:
      "bg-amber-50 text-amber-700",

    High:
      "bg-red-50 text-red-700",
  };

  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${classes[risk]}`}
    >
      {risk}
    </span>
  );
}

/* =============================================================
   STATUS CARD
   ============================================================= */

function StatusCard({
  title,
  status,
  description,
}: {
  title: string;
  status: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">

      <div className="flex items-center justify-between gap-3">

        <h4 className="text-sm font-semibold">
          {title}
        </h4>

        <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">

          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />

          {status}

        </span>

      </div>

      <p className="mt-2 text-xs leading-5 text-slate-500">
        {description}
      </p>

    </div>
  );
}

/* =============================================================
   HISTORY ITEM
   ============================================================= */

function HistoryItem({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">

      <p className="text-xs text-slate-500">
        {label}
      </p>

      <p className="mt-1 font-semibold">
        {value}
      </p>

    </div>
  );
}

/* =============================================================
   GUARDRAIL
   ============================================================= */

function Guardrail({
  text,
  passed = true,
  bold = false,
}: {
  text: string;
  passed?: boolean;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">

      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          passed
            ? "bg-emerald-100 text-emerald-700"
            : "bg-red-100 text-red-700"
        }`}
      >
        {passed ? "✓" : "!"}
      </span>

      <span
        className={`text-sm text-slate-700 ${
          bold ? "font-bold" : ""
        }`}
      >
        {text}
      </span>

    </div>
  );
}

