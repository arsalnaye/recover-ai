import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const MAX_RECOVERY_ATTEMPTS = 2;
const AUTONOMOUS_RECOVERY_LIMIT = 10000;

function getServerSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !secretKey) {
    throw new Error("Supabase server configuration is missing");
  }

  return createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function getRazorpayAuthHeader() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error("Razorpay server configuration is missing");
  }

  return `Basic ${Buffer.from(
    `${keyId}:${keySecret}`
  ).toString("base64")}`;
}

export async function POST(request: Request) {
  const supabase = getServerSupabase();

  let recoveryCaseId: string | null = null;

  try {
    /*
     * =========================================================
     * 1. READ REQUEST
     * =========================================================
     */

    const body = await request.json();

    recoveryCaseId = body?.recoveryCaseId ?? null;

    /*
     * IMPORTANT:
     *
     * Human approval is now explicit.
     *
     * For normal autonomous recovery:
     *   humanApproval = false
     *
     * For high-value recovery:
     *   humanApproval = true
     */

    const humanApproval =
      body?.humanApproval === true;

    const approvedBy =
      typeof body?.approvedBy === "string" &&
      body.approvedBy.trim().length > 0
        ? body.approvedBy.trim()
        : null;

    if (!recoveryCaseId) {
      return NextResponse.json(
        {
          success: false,
          error: "recoveryCaseId is required",
        },
        { status: 400 }
      );
    }

    /*
     * =========================================================
     * 2. LOAD RECOVERY CASE
     * =========================================================
     */

    const {
      data: recoveryCase,
      error: recoveryError,
    } = await supabase
      .from("recovery_cases")
      .select(`
        id,
        payment_id,
        risk_score,
        ai_reason,
        recommended_action,
        status,
        attempt_count,
        created_at,
        payments (
          id,
          amount,
          status,
          customer_id,
          razorpay_payment_id,
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
      .eq("id", recoveryCaseId)
      .single();

    if (recoveryError || !recoveryCase) {
      return NextResponse.json(
        {
          success: false,
          error: "Recovery case not found",
          details: recoveryError?.message,
        },
        { status: 404 }
      );
    }

    /*
     * =========================================================
     * 3. PAYMENT
     * =========================================================
     */

    const payment = Array.isArray(
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
        { status: 400 }
      );
    }

    /*
     * =========================================================
     * 4. CUSTOMER
     * =========================================================
     */

    const customer = Array.isArray(
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
        { status: 400 }
      );
    }

    const paymentAmount = Number(
      payment.amount ?? 0
    );

    const paymentStatus = String(
      payment.status ?? ""
    ).toUpperCase();

    const attemptCount = Number(
      recoveryCase.attempt_count ?? 0
    );

    const optedOut = Boolean(
      customer.opted_out
    );

    const requiresHumanApproval =
      paymentAmount >
      AUTONOMOUS_RECOVERY_LIMIT;

    /*
     * =========================================================
     * 5. HARD SAFETY CHECKS
     * =========================================================
     */

    /*
     * ---------------------------------------------------------
     * CUSTOMER OPT-OUT
     * ---------------------------------------------------------
     */

    if (optedOut) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Recovery blocked: customer has opted out of recovery communications.",
        },
        { status: 403 }
      );
    }

    /*
     * ---------------------------------------------------------
     * PAYMENT ALREADY SUCCESSFUL
     * ---------------------------------------------------------
     */

    if (
      paymentStatus === "SUCCESS" ||
      paymentStatus === "PAID" ||
      paymentStatus === "CAPTURED" ||
      paymentStatus === "RECOVERED"
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Recovery stopped: payment has already succeeded.",
        },
        { status: 409 }
      );
    }

    /*
     * ---------------------------------------------------------
     * MAXIMUM RECOVERY ATTEMPTS
     * ---------------------------------------------------------
     *
     * Current project semantics:
     *
     * 0 = no recovery link created
     * 1 = first recovery link created
     * 2 = second recovery link created
     *
     * A successful Payment Link creation consumes an attempt.
     */

    if (
      attemptCount >=
      MAX_RECOVERY_ATTEMPTS
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Recovery blocked: maximum recovery attempts reached.",
        },
        { status: 403 }
      );
    }

    /*
     * =========================================================
     * 6. AI RECOMMENDATION VALIDATION
     * =========================================================
     *
     * There are two valid paths:
     *
     * A. CREATE_PAYMENT_LINK
     *    → autonomous recovery
     *
     * B. HUMAN_APPROVAL
     *    → merchant explicitly approves
     *
     * In both cases, the actual financial action is:
     *
     * CREATE_PAYMENT_LINK
     */

    const recommendation =
      String(
        recoveryCase.recommended_action ??
        ""
      ).toUpperCase();

    const isPaymentLinkRecommendation =
      recommendation ===
      "CREATE_PAYMENT_LINK";

    const isHumanApprovalRecommendation =
      recommendation ===
      "HUMAN_APPROVAL";

    if (
      !isPaymentLinkRecommendation &&
      !isHumanApprovalRecommendation
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            `Recovery action "${recoveryCase.recommended_action}" is not supported.`,
        },
        { status: 403 }
      );
    }

    /*
     * =========================================================
     * 7. HUMAN APPROVAL GATE
     * =========================================================
     */

    /*
     * HIGH-VALUE CASE
     *
     * The amount exceeds the autonomous limit.
     *
     * It MUST NOT execute without:
     *
     *   humanApproval === true
     *   approvedBy being present
     */

    if (requiresHumanApproval) {
      if (!humanApproval) {
        return NextResponse.json(
          {
            success: false,

            requiresHumanApproval: true,

            error:
              "Human approval is required because the payment amount exceeds the ₹10,000 autonomous recovery limit.",

            approval: {
              required: true,
              amount: paymentAmount,
              autonomousLimit:
                AUTONOMOUS_RECOVERY_LIMIT,
            },
          },
          { status: 403 }
        );
      }

      if (!approvedBy) {
        return NextResponse.json(
          {
            success: false,

            requiresHumanApproval: true,

            error:
              "An approver identity is required for human-approved recovery.",
          },
          { status: 400 }
        );
      }

      /*
       * A high-value case must have been classified
       * as HUMAN_APPROVAL by the AI/policy layer.
       *
       * This prevents a client from simply taking a
       * CREATE_PAYMENT_LINK recommendation and adding
       * humanApproval=true to bypass the AI decision.
       */

      if (
        !isHumanApprovalRecommendation
      ) {
        return NextResponse.json(
          {
            success: false,

            requiresHumanApproval: true,

            error:
              "High-value recovery cannot bypass the human-approval decision.",
          },
          { status: 403 }
        );
      }
    }

    /*
     * LOW-VALUE / AUTONOMOUS CASE
     *
     * This path requires:
     *
     * CREATE_PAYMENT_LINK
     *
     * and must NOT pretend that human approval was
     * required.
     */

    if (!requiresHumanApproval) {
      if (
        !isPaymentLinkRecommendation
      ) {
        return NextResponse.json(
          {
            success: false,
            error:
              "This recovery case requires a different decision and cannot be autonomously executed.",
          },
          { status: 403 }
        );
      }
    }

    /*
     * =========================================================
     * 8. PREVENT DUPLICATE CONCURRENT EXECUTION
     * =========================================================
     */

    if (
      recoveryCase.status ===
        "EXECUTING" &&
      attemptCount > 0
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Recovery is already executing. Wait for the current payment attempt to finish.",
        },
        { status: 409 }
      );
    }

    /*
     * =========================================================
     * 9. GENERATE IDS
     * =========================================================
     */

    const recoveryActionId =
      crypto.randomUUID();

    const referenceId =
      `REC-${recoveryCaseId.slice(0, 8)}-` +
      `${recoveryActionId.slice(0, 8)}`;

    /*
     * =========================================================
     * 10. CREATE RAZORPAY PAYMENT LINK
     * =========================================================
     */

    const razorpayResponse =
      await fetch(
        "https://api.razorpay.com/v1/payment_links",
        {
          method: "POST",

          headers: {
            Authorization:
              getRazorpayAuthHeader(),

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            amount:
              Math.round(
                paymentAmount * 100
              ),

            currency: "INR",

            accept_partial: false,

            reference_id:
              referenceId,

            description:
              `RecoverAI payment recovery for ${customer.name}`,

            customer: {
              name:
                customer.name,

              email:
                customer.email,

              ...(customer.phone
                ? {
                    contact:
                      customer.phone,
                  }
                : {}),
            },

            notify: {
              sms: false,
              email: false,
            },

            reminder_enable:
              false,

            callback_method:
              "get",

            callback_url:
              process.env
                .NEXT_PUBLIC_APP_URL
                ? `${process.env.NEXT_PUBLIC_APP_URL}/`
                : undefined,
          }),
        }
      );

    const razorpayText =
      await razorpayResponse.text();

    let razorpayData: any =
      null;

    try {
      razorpayData =
        JSON.parse(
          razorpayText
        );
    } catch {
      razorpayData = null;
    }

    /*
     * =========================================================
     * 11. RAZORPAY FAILURE
     * =========================================================
     */

    if (
      !razorpayResponse.ok
    ) {
      const razorpayMessage =
        razorpayData?.error
          ?.description ||
        razorpayData?.error?.reason ||
        razorpayText ||
        "Razorpay Payment Link creation failed.";

      await supabase
        .from("audit_logs")
        .insert({
          recovery_case_id:
            recoveryCaseId,

          event:
            "RAZORPAY_PAYMENT_LINK_FAILED",

          metadata: {
            reference_id:
              referenceId,

            recovery_action_id:
              recoveryActionId,

            amount:
              paymentAmount,

            error:
              razorpayMessage,

            approval_type:
              requiresHumanApproval
                ? "HUMAN_APPROVAL"
                : "AUTONOMOUS",

            approved_by:
              approvedBy,
          },
        });

      return NextResponse.json(
        {
          success: false,

          error:
            `Razorpay Payment Link creation failed: ${razorpayMessage}`,
        },
        { status: 502 }
      );
    }

    /*
     * =========================================================
     * 12. VALIDATE RAZORPAY RESPONSE
     * =========================================================
     */

    const paymentLinkId =
      razorpayData?.id;

    const paymentLinkUrl =
      razorpayData?.short_url;

    if (
      !paymentLinkId ||
      !paymentLinkUrl
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Razorpay returned an invalid Payment Link response.",
        },
        { status: 502 }
      );
    }

    /*
     * =========================================================
     * 13. CALCULATE NEW ATTEMPT
     * =========================================================
     *
     * Current project semantics:
     *
     * successful Payment Link creation
     * = one recovery attempt consumed.
     */

    const newAttemptCount =
      attemptCount + 1;

    /*
     * =========================================================
     * 14. SAVE RECOVERY ACTION
     * =========================================================
     */

    const {
      error:
        actionInsertError,
    } = await supabase
      .from("recovery_actions")
      .insert({
        id:
          recoveryActionId,

        recovery_case_id:
          recoveryCaseId,

        action:
          "CREATE_PAYMENT_LINK",

        approved_by:
          approvedBy,

        executed_at:
          new Date().toISOString(),

        result:
          JSON.stringify({
            status:
              "PAYMENT_LINK_CREATED",

            reference_id:
              referenceId,

            razorpay_payment_link_id:
              paymentLinkId,

            payment_link:
              paymentLinkUrl,

            amount:
              paymentAmount,

            attempt:
              newAttemptCount,

            max_attempts:
              MAX_RECOVERY_ATTEMPTS,

            approval_type:
              requiresHumanApproval
                ? "HUMAN_APPROVAL"
                : "AUTONOMOUS",

            human_approved:
              requiresHumanApproval
                ? true
                : false,

            approved_by:
              approvedBy,
          }),
      });

    if (actionInsertError) {
      /*
       * Razorpay created the link but RecoverAI could not
       * persist the action.
       *
       * DO NOT automatically retry.
       */

      console.error(
        "Recovery action save error:",
        actionInsertError
      );

      return NextResponse.json(
        {
          success: false,

          error:
            "Payment Link was created by Razorpay, but RecoverAI could not save the recovery action. Do NOT retry automatically.",

          payment_link:
            paymentLinkUrl,

          razorpay_payment_link_id:
            paymentLinkId,

          reference_id:
            referenceId,
        },
        { status: 500 }
      );
    }

    /*
     * =========================================================
     * 15. UPDATE RECOVERY CASE
     * =========================================================
     */

    const {
      data: updatedCase,
      error:
        caseUpdateError,
    } = await supabase
      .from("recovery_cases")
      .update({
        attempt_count:
          newAttemptCount,

        status:
          "EXECUTING",

        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        recoveryCaseId
      )
      .eq(
        "attempt_count",
        attemptCount
      )
      .select(
        "id, attempt_count, status"
      )
      .single();

    if (
      caseUpdateError ||
      !updatedCase
    ) {
      console.error(
        "Recovery case update error:",
        caseUpdateError
      );

      return NextResponse.json(
        {
          success: false,

          error:
            "Payment link was created, but the recovery attempt could not be safely recorded. Do NOT retry automatically.",

          payment_link:
            paymentLinkUrl,

          razorpay_payment_link_id:
            paymentLinkId,

          reference_id:
            referenceId,
        },
        { status: 500 }
      );
    }

    /*
     * =========================================================
     * 16. AUDIT
     * =========================================================
     */

    await supabase
      .from("audit_logs")
      .insert({
        recovery_case_id:
          recoveryCaseId,

        event:
          "RAZORPAY_PAYMENT_LINK_CREATED",

        metadata: {
          recovery_action_id:
            recoveryActionId,

          reference_id:
            referenceId,

          razorpay_payment_link_id:
            paymentLinkId,

          payment_link:
            paymentLinkUrl,

          amount:
            paymentAmount,

          attempt:
            newAttemptCount,

          max_attempts:
            MAX_RECOVERY_ATTEMPTS,

          approval_type:
            requiresHumanApproval
              ? "HUMAN_APPROVAL"
              : "AUTONOMOUS",

          human_approved:
            requiresHumanApproval
              ? true
              : false,

          approved_by:
            approvedBy,

          status:
            "EXECUTING",
        },
      });

    /*
     * =========================================================
     * 17. RETURN SUCCESS
     * =========================================================
     */

    return NextResponse.json({
      success: true,

      message:
        requiresHumanApproval
          ? "Human-approved recovery payment link created successfully."
          : "Recovery payment link created successfully.",

      recovery: {
        recovery_case_id:
          recoveryCaseId,

        recovery_action_id:
          recoveryActionId,

        reference_id:
          referenceId,

        attempt:
          newAttemptCount,

        max_attempts:
          MAX_RECOVERY_ATTEMPTS,

        remaining_attempts:
          MAX_RECOVERY_ATTEMPTS -
          newAttemptCount,

        amount:
          paymentAmount,

        customer:
          customer.name,

        status:
          "EXECUTING",

        approval_type:
          requiresHumanApproval
            ? "HUMAN_APPROVAL"
            : "AUTONOMOUS",

        approved_by:
          approvedBy,
      },

      razorpay: {
        payment_link_id:
          paymentLinkId,

        payment_link:
          paymentLinkUrl,

        status:
          razorpayData?.status ||
          "created",
      },
    });
  } catch (error) {
    console.error(
      "RecoverAI recovery execution error:",
      error
    );

    if (recoveryCaseId) {
      try {
        await supabase
          .from("audit_logs")
          .insert({
            recovery_case_id:
              recoveryCaseId,

            event:
              "RECOVERY_EXECUTION_FAILED",

            metadata: {
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            },
          });
      } catch (auditError) {
        console.error(
          "Failed to save execution failure audit:",
          auditError
        );
      }
    }

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Recovery execution failed",
      },
      { status: 500 }
    );
  }
}