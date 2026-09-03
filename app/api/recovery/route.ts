import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET() {
  try {
    /*
     * =========================================================
     * SUPABASE CONFIGURATION
     * =========================================================
     */

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const secretKey =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !secretKey) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Supabase server configuration is missing",
        },
        { status: 500 }
      );
    }

    const supabase = createClient(
      supabaseUrl,
      secretKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );

    /*
     * =========================================================
     * RECOVERY CASES
     * =========================================================
     *
     * Load recovery cases together with their payment and
     * customer information.
     */

    const {
      data: recoveryData,
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
        updated_at,
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
      .order("created_at", {
        ascending: false,
      });

    if (recoveryError) {
      console.error(
        "Recovery query error:",
        recoveryError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Failed to retrieve recovery cases",
          details:
            recoveryError.message,
        },
        { status: 500 }
      );
    }

    /*
     * =========================================================
     * ALL PAYMENTS
     * =========================================================
     *
     * Used for revenue-at-risk calculation.
     */

    const {
      data: paymentData,
      error: paymentError,
    } = await supabase
      .from("payments")
      .select(
        "id, amount, status"
      );

    if (paymentError) {
      console.error(
        "Payment query error:",
        paymentError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Failed to retrieve payment data",
          details:
            paymentError.message,
        },
        { status: 500 }
      );
    }

    /*
     * =========================================================
     * CALCULATE REVENUE AT RISK
     * =========================================================
     *
     * Failed and overdue payments are considered revenue
     * currently at risk.
     */

    let revenueAtRisk = 0;

    for (const payment of paymentData ?? []) {
      const amount = Number(
        payment.amount ?? 0
      );

      const paymentStatus =
        String(
          payment.status ?? ""
        ).toUpperCase();

      if (
        paymentStatus === "FAILED" ||
        paymentStatus === "OVERDUE"
      ) {
        revenueAtRisk += amount;
      }
    }

    /*
     * =========================================================
     * CALCULATE RECOVERED REVENUE
     * =========================================================
     *
     * IMPORTANT FIX
     *
     * Do NOT check:
     *
     * payment.status === "RECOVERED"
     *
     * because the webhook changes the payment status to
     * SUCCESS after a successful Razorpay payment.
     *
     * The recovery case itself is changed to:
     *
     * RECOVERED
     *
     * Therefore the recovery case is the correct source of
     * truth for revenue actually recovered by RecoverAI.
     */

    let recoveredRevenue = 0;

    for (const recoveryCase of recoveryData ?? []) {
      const recoveryStatus =
        String(
          recoveryCase.status ?? ""
        ).toUpperCase();

      if (
        recoveryStatus !== "RECOVERED"
      ) {
        continue;
      }

      const payment =
        Array.isArray(
          recoveryCase.payments
        )
          ? recoveryCase.payments[0]
          : recoveryCase.payments;

      recoveredRevenue += Number(
        payment?.amount ?? 0
      );
    }

    /*
     * =========================================================
     * CALCULATE RECOVERABLE REVENUE
     * =========================================================
     *
     * READY cases are currently eligible for recovery.
     *
     * IMPORTANT:
     * High-value cases are not autonomously executable,
     * so they should not be counted as currently autonomous
     * recoverable revenue.
     */

    let recoverableRevenue = 0;

    for (const recoveryCase of recoveryData ?? []) {
      const recoveryStatus =
        String(
          recoveryCase.status ?? ""
        ).toUpperCase();

      if (
        recoveryStatus !== "READY"
      ) {
        continue;
      }

      const payment =
        Array.isArray(
          recoveryCase.payments
        )
          ? recoveryCase.payments[0]
          : recoveryCase.payments;

      if (!payment) {
        continue;
      }

      const amount = Number(
        payment.amount ?? 0
      );

      /*
       * Only amounts at or below ₹10,000 are currently
       * eligible for autonomous recovery.
       */

      if (amount <= 10000) {
        recoverableRevenue += amount;
      }
    }

    /*
     * =========================================================
     * SORT RECOVERY QUEUE
     * =========================================================
     *
     * Priority:
     *
     * 1. Cases requiring action
     * 2. Higher payment amount
     * 3. Newer cases
     *
     * Recovered cases are placed at the bottom.
     */

    const statusPriority: Record<
      string,
      number
    > = {
      PENDING: 1,
      READY: 2,
      EXECUTING: 3,
      FAILED: 4,
      BLOCKED: 5,
      STOPPED: 6,
      RECOVERED: 7,
    };

    const sortedRecoveryData = [
      ...(recoveryData ?? []),
    ].sort((a, b) => {
      /*
       * -------------------------------------------------------
       * 1. STATUS PRIORITY
       * -------------------------------------------------------
       */

      const priorityA =
        statusPriority[
          String(
            a.status ?? ""
          ).toUpperCase()
        ] ?? 99;

      const priorityB =
        statusPriority[
          String(
            b.status ?? ""
          ).toUpperCase()
        ] ?? 99;

      if (
        priorityA !== priorityB
      ) {
        return (
          priorityA - priorityB
        );
      }

      /*
       * -------------------------------------------------------
       * 2. PAYMENT AMOUNT
       * -------------------------------------------------------
       *
       * Higher financial exposure appears first.
       */

      const paymentA =
        Array.isArray(a.payments)
          ? a.payments[0]
          : a.payments;

      const paymentB =
        Array.isArray(b.payments)
          ? b.payments[0]
          : b.payments;

      const amountA = Number(
        paymentA?.amount ?? 0
      );

      const amountB = Number(
        paymentB?.amount ?? 0
      );

      if (
        amountA !== amountB
      ) {
        return (
          amountB - amountA
        );
      }

      /*
       * -------------------------------------------------------
       * 3. NEWEST CASE FIRST
       * -------------------------------------------------------
       */

      const dateA =
        new Date(
          a.created_at
        ).getTime();

      const dateB =
        new Date(
          b.created_at
        ).getTime();

      return dateB - dateA;
    });

    /*
     * =========================================================
     * RETURN RESPONSE
     * =========================================================
     */

    return NextResponse.json({
      success: true,

      count:
        sortedRecoveryData.length,

      metrics: {
        revenueAtRisk:
          Number(
            revenueAtRisk.toFixed(2)
          ),

        recoverableRevenue:
          Number(
            recoverableRevenue.toFixed(2)
          ),

        recoveredRevenue:
          Number(
            recoveredRevenue.toFixed(2)
          ),
      },

      cases:
        sortedRecoveryData,
    });
  } catch (error) {
    console.error(
      "Recovery API error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          "Internal server error",
      },
      { status: 500 }
    );
  }
}