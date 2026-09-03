import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const OLLAMA_URL =
  process.env.OLLAMA_URL || "http://localhost:11434";

const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || "qwen3:4b";

type AIRecommendation =
  | "CREATE_PAYMENT_LINK"
  | "HUMAN_APPROVAL"
  | "DO_NOT_CONTACT";

type AIResult = {
  risk_score: number;
  confidence: number;
  recommendation: AIRecommendation;
  reason: string;
};

function getServerSupabase() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const secretKey =
    process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !secretKey) {
    throw new Error(
      "Supabase server configuration is missing"
    );
  }

  return createClient(
    supabaseUrl,
    secretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

/*
 * ---------------------------------------------------------
 * VALIDATE AI RESULT
 * ---------------------------------------------------------
 */

function isValidRecommendation(
  value: unknown
): value is AIRecommendation {
  return (
    value === "CREATE_PAYMENT_LINK" ||
    value === "HUMAN_APPROVAL" ||
    value === "DO_NOT_CONTACT"
  );
}

function validateAIResult(
  value: unknown
): value is AIResult {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const result =
    value as Record<string, unknown>;

  return (
    typeof result.risk_score === "number" &&
    result.risk_score >= 0 &&
    result.risk_score <= 1 &&
    typeof result.confidence === "number" &&
    result.confidence >= 0 &&
    result.confidence <= 1 &&
    isValidRecommendation(
      result.recommendation
    ) &&
    typeof result.reason === "string" &&
    result.reason.trim().length > 0
  );
}

/*
 * ---------------------------------------------------------
 * RISK POLICY
 *
 * IMPORTANT:
 * Risk is controlled by RecoverAI policy.
 * Qwen does NOT get final authority over risk.
 * ---------------------------------------------------------
 */

function calculateRiskScore(
  amount: number,
  attemptCount: number,
  paymentStatus: string
): number {
  /*
   * Maximum recovery attempts reached.
   */
  if (attemptCount >= 2) {
    return 0.95;
  }

  /*
   * Large payments are high risk.
   */
  if (amount > 10000) {
    return 0.90;
  }

  /*
   * Medium-value payments.
   */
  if (amount > 5000) {
    return 0.55;
  }

  /*
   * Small payments are low risk.
   */
  if (
    amount > 0 &&
    (paymentStatus === "FAILED" ||
      paymentStatus === "OVERDUE")
  ) {
    return 0.20;
  }

  return 0.10;
}

/*
 * ---------------------------------------------------------
 * LOCAL QWEN3 AI
 * ---------------------------------------------------------
 */

async function askLocalAI(
  customer: {
    name: string;
    email: string;
    opted_out: boolean;
  },
  payment: {
    amount: number;
    status: string;
  },
  attemptCount: number
): Promise<AIResult> {

  const prompt = `
You are RecoverAI, a payment recovery decision engine.

Analyze this payment recovery case.

Customer name: ${customer.name}
Payment amount: ₹${payment.amount}
Payment status: ${payment.status}
Previous recovery attempts: ${attemptCount}
Customer opted out: ${customer.opted_out}

Rules:

1. If customer opted_out is true:
   recommendation = DO_NOT_CONTACT

2. If payment amount is greater than 10000:
   recommendation = HUMAN_APPROVAL

3. If previous recovery attempts are 2 or more:
   recommendation = HUMAN_APPROVAL

4. If payment amount is 10000 or less and the payment is FAILED:
   recommendation = CREATE_PAYMENT_LINK

5. If payment amount is 10000 or less and the payment is OVERDUE:
   recommendation = CREATE_PAYMENT_LINK

6. Never use SEND_REMINDER.

7. If uncertain:
   recommendation = HUMAN_APPROVAL

Allowed recommendation values:

CREATE_PAYMENT_LINK
HUMAN_APPROVAL
DO_NOT_CONTACT

Return ONLY valid JSON.

Do not return markdown.
Do not return code fences.
Do not return customer information.
Do not return payment information.

The JSON must contain exactly:

{
  "risk_score": 0.2,
  "confidence": 0.9,
  "recommendation": "CREATE_PAYMENT_LINK",
  "reason": "Payment is within the autonomous recovery limit."
}
`;

  async function callOllama(
    currentPrompt: string
  ): Promise<AIResult> {

    const controller =
      new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      60_000
    );

    try {
      const response =
        await fetch(
          `${OLLAMA_URL}/api/chat`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            signal: controller.signal,

            body: JSON.stringify({
              model: OLLAMA_MODEL,

              /*
               * Disable Qwen thinking.
               */
              think: false,

              stream: false,

              format: "json",

              options: {
                temperature: 0,
                num_predict: 200,
                keep_alive: "10m",
              },

              messages: [
                {
                  role: "user",
                  content:
                    currentPrompt,
                },
              ],
            }),
          }
        );

      if (!response.ok) {
        const errorText =
          await response.text();

        throw new Error(
          `Ollama request failed (${response.status}): ${errorText}`
        );
      }

      const data =
        await response.json();

      const content =
        data?.message?.content;

      if (
        typeof content !== "string" ||
        content.trim().length === 0
      ) {
        throw new Error(
          "Ollama returned an empty response"
        );
      }

      console.log(
        "Qwen raw response:",
        content
      );

      let parsed: unknown;

      try {
        parsed =
          JSON.parse(content);
      } catch {
        throw new Error(
          "Qwen3 returned invalid JSON"
        );
      }

      if (
        !validateAIResult(parsed)
      ) {
        console.error(
          "Qwen returned unexpected JSON:",
          parsed
        );

        throw new Error(
          "Qwen3 returned an invalid RecoverAI decision"
        );
      }

      return parsed;

    } catch (error) {

      if (
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        throw new Error(
          "Qwen3 AI timed out after 60 seconds."
        );
      }

      throw error;

    } finally {
      clearTimeout(timeout);
    }
  }

  /*
   * First attempt
   */

  try {
    return await callOllama(
      prompt
    );

  } catch (firstError) {

    console.warn(
      "First Qwen attempt failed. Retrying..."
    );

    const retryPrompt = `
Return ONLY valid JSON.

Payment amount: ₹${payment.amount}
Payment status: ${payment.status}
Previous attempts: ${attemptCount}
Customer opted out: ${customer.opted_out}

Rules:

- opted out = DO_NOT_CONTACT
- amount > 10000 = HUMAN_APPROVAL
- attempts >= 2 = HUMAN_APPROVAL
- amount <= 10000 and FAILED = CREATE_PAYMENT_LINK
- amount <= 10000 and OVERDUE = CREATE_PAYMENT_LINK
- NEVER use SEND_REMINDER

Allowed values:

CREATE_PAYMENT_LINK
HUMAN_APPROVAL
DO_NOT_CONTACT

Return:

{
  "risk_score": 0.2,
  "confidence": 0.9,
  "recommendation": "CREATE_PAYMENT_LINK",
  "reason": "Payment is within the autonomous recovery limit."
}
`;

    try {
      return await callOllama(
        retryPrompt
      );

    } catch (secondError) {

      console.error(
        "Qwen first attempt:",
        firstError
      );

      console.error(
        "Qwen retry attempt:",
        secondError
      );

      throw secondError;
    }
  }
}

/*
 * ---------------------------------------------------------
 * POST /api/ai/analyze
 * ---------------------------------------------------------
 */

export async function POST(
  request: Request
) {
  try {

    /*
     * -------------------------------------------------------
     * 1. READ REQUEST
     * -------------------------------------------------------
     */

    const body =
      await request.json();

    const recoveryCaseId =
      body?.recoveryCaseId;

    if (!recoveryCaseId) {
      return NextResponse.json(
        {
          success: false,
          error:
            "recoveryCaseId is required",
        },
        {
          status: 400,
        }
      );
    }

    /*
     * -------------------------------------------------------
     * 2. SUPABASE
     * -------------------------------------------------------
     */

    const supabase =
      getServerSupabase();

    /*
     * -------------------------------------------------------
     * 3. LOAD RECOVERY CASE
     * -------------------------------------------------------
     */

    const {
      data: recoveryCase,
      error: recoveryError,
    } =
      await supabase
        .from("recovery_cases")
        .select(`
          id,
          risk_score,
          ai_reason,
          recommended_action,
          status,
          attempt_count,
          created_at,
          updated_at,
          payments (
            id,
            amount,
            status,
            customer_id,
            customers (
              id,
              name,
              email,
              phone,
              opted_out,
              created_at
            )
          )
        `)
        .eq(
          "id",
          recoveryCaseId
        )
        .single();

    if (
      recoveryError ||
      !recoveryCase
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Recovery case not found",
          details:
            recoveryError?.message,
        },
        {
          status: 404,
        }
      );
    }

    /*
     * -------------------------------------------------------
     * 4. PAYMENT
     * -------------------------------------------------------
     */

    const payment =
      Array.isArray(
        recoveryCase.payments
      )
        ? recoveryCase.payments[0]
        : recoveryCase.payments;

    if (!payment) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Recovery case does not contain payment data",
        },
        {
          status: 400,
        }
      );
    }

    /*
     * -------------------------------------------------------
     * 5. CUSTOMER
     * -------------------------------------------------------
     */

    const customer =
      Array.isArray(
        payment.customers
      )
        ? payment.customers[0]
        : payment.customers;

    if (!customer) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Recovery case does not contain customer data",
        },
        {
          status: 400,
        }
      );
    }

    const paymentAmount =
      Number(
        payment.amount ?? 0
      );

    const paymentStatus =
      String(
        payment.status ?? ""
      ).toUpperCase();

    const attemptCount =
      Number(
        recoveryCase.attempt_count ?? 0
      );

    const optedOut =
      Boolean(
        customer.opted_out
      );

    /*
     * -------------------------------------------------------
     * 6. HARD POLICY: OPTED OUT
     * -------------------------------------------------------
     */

    if (optedOut) {

      const decision: AIResult = {
        risk_score: 0,
        confidence: 1,
        recommendation:
          "DO_NOT_CONTACT",
        reason:
          "Customer has opted out of recovery communications.",
      };

      await saveDecision(
        supabase,
        recoveryCaseId,
        decision,
        "BLOCKED"
      );

      return NextResponse.json({
        success: true,
        source: "policy-engine",

        result: {
          recovery_case_id:
            recoveryCaseId,

          customer:
            customer.name,

          payment_amount:
            paymentAmount,

          payment_status:
            paymentStatus,

          ...decision,

          status: "BLOCKED",
        },
      });
    }

    /*
     * -------------------------------------------------------
     * 7. HARD POLICY: MAX ATTEMPTS
     * -------------------------------------------------------
     */

    if (
      attemptCount >= 2
    ) {

      const decision: AIResult = {
        risk_score: 0.95,
        confidence: 1,
        recommendation:
          "HUMAN_APPROVAL",
        reason:
          "Maximum recovery attempts have already been reached.",
      };

      await saveDecision(
        supabase,
        recoveryCaseId,
        decision,
        "PENDING"
      );

      return NextResponse.json({
        success: true,
        source: "policy-engine",

        result: {
          recovery_case_id:
            recoveryCaseId,

          customer:
            customer.name,

          payment_amount:
            paymentAmount,

          payment_status:
            paymentStatus,

          ...decision,

          status: "PENDING",
        },
      });
    }

    /*
     * -------------------------------------------------------
     * 8. ASK QWEN
     * -------------------------------------------------------
     */

    const aiDecision =
      await askLocalAI(
        {
          name:
            String(
              customer.name ?? ""
            ),

          email:
            String(
              customer.email ?? ""
            ),

          opted_out:
            optedOut,
        },

        {
          amount:
            paymentAmount,

          status:
            paymentStatus,
        },

        attemptCount
      );

    /*
     * -------------------------------------------------------
     * 9. POLICY ENGINE
     *
     * Qwen recommends.
     * RecoverAI policy decides.
     * -------------------------------------------------------
     */

    let finalRecommendation:
      AIRecommendation;

    let finalReason:
      string;

    let finalStatus:
      | "READY"
      | "PENDING"
      | "BLOCKED"
      | "STOPPED";

    /*
     * IMPORTANT:
     * Risk score is calculated by RecoverAI,
     * NOT trusted from Qwen.
     */

    const finalRiskScore =
      calculateRiskScore(
        paymentAmount,
        attemptCount,
        paymentStatus
      );

    /*
     * Large amount.
     */

    if (
      paymentAmount > 10000
    ) {

      finalRecommendation =
        "HUMAN_APPROVAL";

      finalStatus =
        "PENDING";

      finalReason =
        "Policy engine requires human approval because the payment exceeds the autonomous recovery limit of ₹10,000.";

    } else if (
      paymentStatus === "FAILED" ||
      paymentStatus === "OVERDUE"
    ) {

      /*
       * All autonomous failed/overdue
       * payments use the payment-link
       * mechanism.
       *
       * No SEND_REMINDER.
       */

      finalRecommendation =
        "CREATE_PAYMENT_LINK";

      finalStatus =
        "READY";

      if (
        paymentStatus === "FAILED"
      ) {
        finalReason =
          paymentAmount <= 5000
            ? "Low-risk failed payment within the autonomous recovery limit."
            : "Medium-risk failed payment within the autonomous recovery limit.";
      } else {
        finalReason =
          paymentAmount <= 5000
            ? "Low-risk overdue payment within the autonomous recovery limit."
            : "Medium-risk overdue payment within the autonomous recovery limit.";
      }

    } else {

      /*
       * Unknown payment status.
       */

      finalRecommendation =
        "HUMAN_APPROVAL";

      finalStatus =
        "PENDING";

      finalReason =
        "Payment status requires human review before recovery.";
    }

    /*
     * -------------------------------------------------------
     * 10. FINAL DECISION
     * -------------------------------------------------------
     */

    const finalDecision: AIResult = {
      risk_score:
        finalRiskScore,

      confidence:
        Math.max(
          aiDecision.confidence,
          0.90
        ),

      recommendation:
        finalRecommendation,

      reason:
        finalReason,
    };

    /*
     * -------------------------------------------------------
     * 11. SAVE
     * -------------------------------------------------------
     */

    await saveDecision(
      supabase,
      recoveryCaseId,
      finalDecision,
      finalStatus
    );

    /*
     * -------------------------------------------------------
     * 12. RETURN
     * -------------------------------------------------------
     */

    return NextResponse.json({
      success: true,

      source:
        "ollama-qwen3-4b-policy-engine",

      result: {
        recovery_case_id:
          recoveryCaseId,

        customer:
          customer.name,

        payment_amount:
          paymentAmount,

        payment_status:
          paymentStatus,

        risk_score:
          finalDecision.risk_score,

        confidence:
          finalDecision.confidence,

        recommendation:
          finalDecision.recommendation,

        reason:
          finalDecision.reason,

        status:
          finalStatus,
      },
    });

  } catch (error) {

    console.error(
      "RecoverAI AI analysis error:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "AI analysis failed",
      },
      {
        status: 500,
      }
    );
  }
}

/*
 * ---------------------------------------------------------
 * SAVE AI DECISION
 * ---------------------------------------------------------
 */

async function saveDecision(
  supabase: ReturnType<
    typeof getServerSupabase
  >,

  recoveryCaseId: string,

  decision: AIResult,

  status:
    | "READY"
    | "PENDING"
    | "BLOCKED"
    | "STOPPED"
) {

  /*
   * Update recovery case.
   */

  const {
    error: updateError,
  } =
    await supabase
      .from("recovery_cases")
      .update({
        risk_score:
          decision.risk_score,

        ai_reason:
          decision.reason,

        recommended_action:
          decision.recommendation,

        status,

        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        recoveryCaseId
      );

  if (updateError) {
    throw new Error(
      `Failed to save recovery decision: ${updateError.message}`
    );
  }

  /*
   * Audit log.
   */

  const {
    error: auditError,
  } =
    await supabase
      .from("audit_logs")
      .insert({
        recovery_case_id:
          recoveryCaseId,

        event:
          "QWEN_AI_DECISION_CREATED",

        metadata: {
          engine:
            "Ollama + Qwen3 4B + RecoverAI Policy Engine",

          risk_score:
            decision.risk_score,

          confidence:
            decision.confidence,

          recommendation:
            decision.recommendation,

          status,

          reason:
            decision.reason,
        },
      });

  if (auditError) {
    console.error(
      "Audit log error:",
      auditError
    );
  }
}