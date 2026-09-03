import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createClient } from "@supabase/supabase-js";

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

function verifyRazorpaySignature(
  rawBody: string,
  signature: string,
  secret: string
) {
  const expectedSignature = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    const expectedBuffer = Buffer.from(
      expectedSignature,
      "utf8"
    );

    const signatureBuffer = Buffer.from(
      signature,
      "utf8"
    );

    if (
      expectedBuffer.length !==
      signatureBuffer.length
    ) {
      return false;
    }

    return timingSafeEqual(
      expectedBuffer,
      signatureBuffer
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const supabase = getServerSupabase();

  try {
    // =========================================================
    // 1. READ RAW BODY
    // =========================================================

    const rawBody = await request.text();

    const signature = request.headers.get(
      "x-razorpay-signature"
    );

    const webhookSecret =
      process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!signature) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Missing Razorpay webhook signature",
        },
        { status: 400 }
      );
    }

    if (!webhookSecret) {
      console.error(
        "RAZORPAY_WEBHOOK_SECRET is missing"
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Webhook configuration is missing",
        },
        { status: 500 }
      );
    }

    // =========================================================
    // 2. VERIFY RAZORPAY SIGNATURE
    // =========================================================

    const validSignature =
      verifyRazorpaySignature(
        rawBody,
        signature,
        webhookSecret
      );

    if (!validSignature) {
      console.error(
        "Invalid Razorpay webhook signature"
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid webhook signature",
        },
        { status: 401 }
      );
    }

    // =========================================================
    // 3. PARSE EVENT
    // =========================================================

    let event: any;

    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid JSON payload",
        },
        { status: 400 }
      );
    }

    const eventName = event?.event;

    console.log(
      "Razorpay webhook:",
      eventName
    );

    // =========================================================
    // 4. EXTRACT PAYMENT INFORMATION
    // =========================================================

    const paymentLink =
      event?.payload?.payment_link?.entity;

    const razorpayPayment =
      event?.payload?.payment?.entity;

    const paymentLinkId =
      paymentLink?.id ||
      razorpayPayment?.payment_link_id ||
      null;

    const referenceId =
      paymentLink?.reference_id ||
      null;

    const razorpayPaymentId =
      razorpayPayment?.id ||
      null;

    console.log(
      "Razorpay event data:",
      {
        eventName,
        paymentLinkId,
        referenceId,
        razorpayPaymentId,
      }
    );

    // =========================================================
    // 5. IGNORE UNRELATED EVENTS
    // =========================================================
    //
    // We care about:
    //
    // payment_link.paid
    // payment.failed
    //
    // We also handle payment_link.expired and
    // payment_link.cancelled so an unusable link
    // does not leave the case stuck in EXECUTING.
    //
    // =========================================================

    const supportedEvents = [
      "payment_link.paid",
      "payment.failed",
      "payment_link.expired",
      "payment_link.cancelled",
    ];

    if (!supportedEvents.includes(eventName)) {
      return NextResponse.json({
        success: true,
        ignored: true,
        event: eventName,
      });
    }

    // =========================================================
    // 6. PAYMENT SUCCESS
    // =========================================================

    if (eventName === "payment_link.paid") {
      if (!paymentLinkId) {
        console.error(
          "Missing Razorpay payment link ID"
        );

        return NextResponse.json(
          {
            success: false,
            error:
              "Missing Razorpay payment link information",
          },
          { status: 400 }
        );
      }

      console.log(
        "Razorpay payment link PAID:",
        {
          paymentLinkId,
          referenceId,
          razorpayPaymentId,
        }
      );

      // =======================================================
      // 6A. FIND RECOVERY ACTION
      // =======================================================

      const {
        data: actions,
        error: actionsError,
      } = await supabase
        .from("recovery_actions")
        .select(`
          id,
          recovery_case_id,
          action,
          result,
          executed_at
        `)
        .eq(
          "action",
          "CREATE_PAYMENT_LINK"
        )
        .order(
          "executed_at",
          {
            ascending: false,
          }
        )
        .limit(100);

      if (actionsError) {
        throw new Error(
          `Failed to find recovery action: ${actionsError.message}`
        );
      }

      let matchedAction: any = null;

      for (const action of actions ?? []) {
        try {
          const result =
            typeof action.result === "string"
              ? JSON.parse(action.result)
              : action.result;

          if (
            result?.razorpay_payment_link_id ===
              paymentLinkId ||
            result?.reference_id ===
              referenceId
          ) {
            matchedAction = action;
            break;
          }
        } catch {
          // Ignore malformed historical action
        }
      }

      if (!matchedAction) {
        console.error(
          "No RecoverAI recovery action found:",
          {
            paymentLinkId,
            referenceId,
          }
        );

        return NextResponse.json(
          {
            success: false,
            error:
              "Recovery action not found",
          },
          { status: 404 }
        );
      }

      const recoveryCaseId =
        matchedAction.recovery_case_id;

      console.log(
        "Matched recovery action:",
        {
          recoveryCaseId,
          recoveryActionId:
            matchedAction.id,
        }
      );

      // =======================================================
      // 6B. GET RECOVERY CASE
      // =======================================================

      const {
        data: recoveryCase,
        error: recoveryCaseError,
      } = await supabase
        .from("recovery_cases")
        .select(`
          id,
          payment_id,
          attempt_count,
          status
        `)
        .eq(
          "id",
          recoveryCaseId
        )
        .single();

      if (
        recoveryCaseError ||
        !recoveryCase
      ) {
        throw new Error(
          `Recovery case not found: ${
            recoveryCaseError?.message ??
            recoveryCaseId
          }`
        );
      }

      const currentAttemptCount =
        Number(
          recoveryCase.attempt_count ?? 0
        );

      // =======================================================
      // 6C. ALREADY RECOVERED
      // =======================================================

      if (
        recoveryCase.status ===
        "RECOVERED"
      ) {
        console.log(
          "Duplicate payment webhook ignored:",
          {
            recoveryCaseId,
            paymentLinkId,
          }
        );

        return NextResponse.json({
          success: true,
          duplicate: true,
          message:
            "Recovery case was already recovered.",
          recoveryCaseId,
          status: "RECOVERED",
          attemptCount:
            currentAttemptCount,
          razorpayPaymentLinkId:
            paymentLinkId,
          razorpayPaymentId:
            razorpayPaymentId ?? null,
        });
      }

      // =======================================================
      // 6D. MARK PAYMENT SUCCESS
      // =======================================================

      const paymentId =
        recoveryCase.payment_id;

      const {
        error: paymentUpdateError,
      } = await supabase
        .from("payments")
        .update({
          status: "SUCCESS",
          razorpay_payment_id:
            razorpayPaymentId ?? null,
        })
        .eq(
          "id",
          paymentId
        );

      if (paymentUpdateError) {
        throw new Error(
          `Failed to update payment: ${paymentUpdateError.message}`
        );
      }

      // =======================================================
      // 6E. MARK RECOVERY AS RECOVERED
      // =======================================================

      const {
        data: updatedRecoveryCase,
        error: caseUpdateError,
      } = await supabase
        .from("recovery_cases")
        .update({
          status: "RECOVERED",

          // IMPORTANT:
          // Never increment attempts here.
          attempt_count:
            currentAttemptCount,

          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          recoveryCaseId
        )
        .neq(
          "status",
          "RECOVERED"
        )
        .select(
          "id, status, attempt_count"
        )
        .maybeSingle();

      if (caseUpdateError) {
        throw new Error(
          `Failed to mark recovery case as recovered: ${caseUpdateError.message}`
        );
      }

      // =======================================================
      // 6F. DUPLICATE WEBHOOK
      // =======================================================

      if (!updatedRecoveryCase) {
        return NextResponse.json({
          success: true,
          duplicate: true,
          message:
            "Recovery was already processed.",
          recoveryCaseId,
          status: "RECOVERED",
          attemptCount:
            currentAttemptCount,
          razorpayPaymentLinkId:
            paymentLinkId,
          razorpayPaymentId:
            razorpayPaymentId ?? null,
        });
      }

      // =======================================================
      // 6G. UPDATE RECOVERY ACTION
      // =======================================================

      let previousResult: any = {};

      try {
        previousResult =
          typeof matchedAction.result ===
          "string"
            ? JSON.parse(
                matchedAction.result
              )
            : matchedAction.result ?? {};
      } catch {
        previousResult = {};
      }

      const updatedActionResult =
        JSON.stringify({
          ...previousResult,

          status:
            "PAYMENT_RECOVERED",

          paid_at:
            new Date().toISOString(),

          razorpay_payment_id:
            razorpayPaymentId ?? null,

          razorpay_payment_link_id:
            paymentLinkId,

          reference_id:
            referenceId,
        });

      const {
        error: actionUpdateError,
      } = await supabase
        .from("recovery_actions")
        .update({
          result:
            updatedActionResult,
        })
        .eq(
          "id",
          matchedAction.id
        );

      if (actionUpdateError) {
        throw new Error(
          `Failed to update recovery action: ${actionUpdateError.message}`
        );
      }

      // =======================================================
      // 6H. AUDIT
      // =======================================================

      await supabase
        .from("audit_logs")
        .insert({
          recovery_case_id:
            recoveryCaseId,

          event:
            "RAZORPAY_PAYMENT_RECOVERED",

          metadata: {
            razorpay_payment_link_id:
              paymentLinkId,

            razorpay_payment_id:
              razorpayPaymentId,

            reference_id:
              referenceId,

            previous_status:
              recoveryCase.status,

            new_status:
              "RECOVERED",

            attempt_count:
              currentAttemptCount,
          },
        });

      // =======================================================
      // 6I. SUCCESS
      // =======================================================

      return NextResponse.json({
        success: true,

        duplicate: false,

        message:
          "Payment successfully recorded and recovery case marked as RECOVERED.",

        recoveryCaseId,

        status:
          "RECOVERED",

        attemptCount:
          currentAttemptCount,

        razorpayPaymentLinkId:
          paymentLinkId,

        razorpayPaymentId:
          razorpayPaymentId ?? null,

        referenceId,
      });
    }

    // =========================================================
    // 7. PAYMENT FAILED
    // =========================================================
    //
    // THIS IS THE IMPORTANT FIX.
    //
    // A failed payment DOES NOT consume another attempt.
    //
    // The link was already counted when it was created:
    //
    // 0/2 -> link created -> 1/2
    //
    // If customer fails:
    //
    // 1/2 -> STILL 1/2
    //
    // We simply make the case READY again so the merchant
    // can send another payment link.
    //
    // =========================================================

    if (
      eventName ===
      "payment.failed"
    ) {
      if (!paymentLinkId) {
        console.error(
          "Payment failed event does not contain payment_link_id"
        );

        return NextResponse.json({
          success: true,
          ignored: true,
          reason:
            "No payment link ID available",
        });
      }

      console.log(
        "Razorpay payment FAILED:",
        {
          paymentLinkId,
          razorpayPaymentId,
        }
      );

      // =======================================================
      // FIND RECOVERY ACTION
      // =======================================================

      const {
        data: actions,
        error: actionsError,
      } = await supabase
        .from("recovery_actions")
        .select(`
          id,
          recovery_case_id,
          action,
          result,
          executed_at
        `)
        .eq(
          "action",
          "CREATE_PAYMENT_LINK"
        )
        .order(
          "executed_at",
          {
            ascending: false,
          }
        )
        .limit(100);

      if (actionsError) {
        throw new Error(
          `Failed to find recovery action: ${actionsError.message}`
        );
      }

      let matchedAction: any = null;

      for (const action of actions ?? []) {
        try {
          const result =
            typeof action.result === "string"
              ? JSON.parse(action.result)
              : action.result;

          if (
            result?.razorpay_payment_link_id ===
            paymentLinkId
          ) {
            matchedAction = action;
            break;
          }
        } catch {
          // Ignore malformed historical action
        }
      }

      if (!matchedAction) {
        console.error(
          "No RecoverAI action found for failed payment:",
          {
            paymentLinkId,
          }
        );

        return NextResponse.json({
          success: true,
          ignored: true,
          reason:
            "Recovery action not found",
        });
      }

      const recoveryCaseId =
        matchedAction.recovery_case_id;

      // =======================================================
      // GET CASE
      // =======================================================

      const {
        data: recoveryCase,
        error: recoveryCaseError,
      } = await supabase
        .from("recovery_cases")
        .select(`
          id,
          payment_id,
          attempt_count,
          status
        `)
        .eq(
          "id",
          recoveryCaseId
        )
        .single();

      if (
        recoveryCaseError ||
        !recoveryCase
      ) {
        throw new Error(
          `Recovery case not found: ${
            recoveryCaseError?.message ??
            recoveryCaseId
          }`
        );
      }

      const attemptCount =
        Number(
          recoveryCase.attempt_count ?? 0
        );

      // =======================================================
      // DO NOT CHANGE ATTEMPT COUNT
      // =======================================================

      /*
       * A failed payment means:
       *
       * The link was used.
       *
       * But no NEW link was sent.
       *
       * Therefore:
       *
       * attempt_count stays exactly the same.
       */

      const {
        error: paymentUpdateError,
      } = await supabase
        .from("payments")
        .update({
          status: "FAILED",
        })
        .eq(
          "id",
          recoveryCase.payment_id
        );

      if (paymentUpdateError) {
        console.error(
          "Failed to mark payment as FAILED:",
          paymentUpdateError
        );
      }

      // =======================================================
      // MAKE CASE READY FOR RETRY
      // =======================================================

      /*
       * If attempt_count is already 2, do NOT allow retry.
       *
       * Otherwise return to READY.
       */

      const newStatus =
        attemptCount >= 2
          ? "MAX_ATTEMPTS_REACHED"
          : "READY";

      const {
        error: caseUpdateError,
      } = await supabase
        .from("recovery_cases")
        .update({
          status: newStatus,

          // IMPORTANT:
          // Failure does NOT increment attempts.
          attempt_count:
            attemptCount,

          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          recoveryCaseId
        )
        .neq(
          "status",
          "RECOVERED"
        );

      if (caseUpdateError) {
        throw new Error(
          `Failed to update failed recovery case: ${caseUpdateError.message}`
        );
      }

      // =======================================================
      // UPDATE ACTION RESULT
      // =======================================================

      let previousResult: any = {};

      try {
        previousResult =
          typeof matchedAction.result ===
          "string"
            ? JSON.parse(
                matchedAction.result
              )
            : matchedAction.result ?? {};
      } catch {
        previousResult = {};
      }

      const failedActionResult =
        JSON.stringify({
          ...previousResult,

          status:
            "PAYMENT_ATTEMPT_FAILED",

          failed_at:
            new Date().toISOString(),

          razorpay_payment_id:
            razorpayPaymentId ?? null,

          razorpay_payment_link_id:
            paymentLinkId,

          attempt:
            attemptCount,

          max_attempts: 2,

          retry_available:
            attemptCount < 2,
        });

      await supabase
        .from("recovery_actions")
        .update({
          result:
            failedActionResult,
        })
        .eq(
          "id",
          matchedAction.id
        );

      // =======================================================
      // AUDIT
      // =======================================================

      await supabase
        .from("audit_logs")
        .insert({
          recovery_case_id:
            recoveryCaseId,

          event:
            "RAZORPAY_PAYMENT_FAILED",

          metadata: {
            razorpay_payment_link_id:
              paymentLinkId,

            razorpay_payment_id:
              razorpayPaymentId,

            attempt_count:
              attemptCount,

            max_attempts: 2,

            retry_available:
              attemptCount < 2,

            new_status:
              newStatus,
          },
        });

      console.log(
        "Failed payment processed:",
        {
          recoveryCaseId,
          attemptCount,
          newStatus,
          retryAvailable:
            attemptCount < 2,
        }
      );

      return NextResponse.json({
        success: true,

        message:
          "Payment failure recorded. Recovery attempt count was not increased.",

        recoveryCaseId,

        status:
          newStatus,

        attemptCount,

        maxAttempts: 2,

        remainingAttempts:
          Math.max(
            0,
            2 - attemptCount
          ),

        retryAvailable:
          attemptCount < 2,
      });
    }

    // =========================================================
    // 8. PAYMENT LINK EXPIRED / CANCELLED
    // =========================================================
    //
    // These are NOT payment attempts.
    //
    // The link already consumed its try when it was created.
    //
    // If there is still an attempt available, allow another
    // link to be generated.
    //
    // =========================================================

    if (
      eventName ===
        "payment_link.expired" ||
      eventName ===
        "payment_link.cancelled"
    ) {
      if (!paymentLinkId) {
        return NextResponse.json({
          success: true,
          ignored: true,
          reason:
            "No payment link ID available",
        });
      }

      console.log(
        "Payment link expired/cancelled:",
        {
          paymentLinkId,
          eventName,
        }
      );

      // =======================================================
      // FIND ACTION
      // =======================================================

      const {
        data: actions,
      } = await supabase
        .from("recovery_actions")
        .select(`
          id,
          recovery_case_id,
          action,
          result,
          executed_at
        `)
        .eq(
          "action",
          "CREATE_PAYMENT_LINK"
        )
        .order(
          "executed_at",
          {
            ascending: false,
          }
        )
        .limit(100);

      let matchedAction: any = null;

      for (const action of actions ?? []) {
        try {
          const result =
            typeof action.result === "string"
              ? JSON.parse(action.result)
              : action.result;

          if (
            result?.razorpay_payment_link_id ===
            paymentLinkId
          ) {
            matchedAction = action;
            break;
          }
        } catch {
          // Ignore malformed action
        }
      }

      if (!matchedAction) {
        return NextResponse.json({
          success: true,
          ignored: true,
          reason:
            "Recovery action not found",
        });
      }

      const recoveryCaseId =
        matchedAction.recovery_case_id;

      const {
        data: recoveryCase,
      } = await supabase
        .from("recovery_cases")
        .select(`
          id,
          attempt_count,
          status
        `)
        .eq(
          "id",
          recoveryCaseId
        )
        .single();

      if (!recoveryCase) {
        return NextResponse.json({
          success: true,
          ignored: true,
          reason:
            "Recovery case not found",
        });
      }

      const attemptCount =
        Number(
          recoveryCase.attempt_count ?? 0
        );

      const newStatus =
        attemptCount >= 2
          ? "MAX_ATTEMPTS_REACHED"
          : "READY";

      await supabase
        .from("recovery_cases")
        .update({
          status:
            newStatus,

          // Never increment here.
          attempt_count:
            attemptCount,

          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          recoveryCaseId
        )
        .neq(
          "status",
          "RECOVERED"
        );

      await supabase
        .from("audit_logs")
        .insert({
          recovery_case_id:
            recoveryCaseId,

          event:
            eventName ===
            "payment_link.expired"
              ? "RAZORPAY_PAYMENT_LINK_EXPIRED"
              : "RAZORPAY_PAYMENT_LINK_CANCELLED",

          metadata: {
            razorpay_payment_link_id:
              paymentLinkId,

            attempt_count:
              attemptCount,

            retry_available:
              attemptCount < 2,

            new_status:
              newStatus,
          },
        });

      return NextResponse.json({
        success: true,

        message:
          "Payment link status processed.",

        recoveryCaseId,

        status:
          newStatus,

        attemptCount,

        retryAvailable:
          attemptCount < 2,
      });
    }

    // =========================================================
    // 9. FALLBACK
    // =========================================================

    return NextResponse.json({
      success: true,
      ignored: true,
      event: eventName,
    });
  } catch (error) {
    console.error(
      "RecoverAI Razorpay webhook error:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Webhook processing failed",
      },
      { status: 500 }
    );
  }
}