export type RecoveryRecommendation =
  | "CREATE_PAYMENT_LINK"
  | "SEND_REMINDER"
  | "HUMAN_APPROVAL"
  | "DO_NOT_CONTACT";

export type RecoveryDecision = {
  risk_score: number;
  confidence: number;
  recommendation: RecoveryRecommendation;
  reason: string;
};

type RecoveryInput = {
  paymentAmount: number;
  paymentStatus: string;
  attemptCount: number;
  optedOut: boolean;
};

const AUTONOMOUS_LIMIT = 10000;
const MAX_ATTEMPTS = 2;

export function analyzeRecoveryCase(
  input: RecoveryInput
): RecoveryDecision {
  /*
   * ---------------------------------------------------------
   * HARD SAFETY RULE 1
   * ---------------------------------------------------------
   *
   * Never contact a customer who opted out.
   */

  if (input.optedOut) {
    return {
      risk_score: 0,
      confidence: 1,
      recommendation: "DO_NOT_CONTACT",
      reason:
        "Customer has opted out of recovery communications.",
    };
  }

  /*
   * ---------------------------------------------------------
   * HARD SAFETY RULE 2
   * ---------------------------------------------------------
   *
   * Stop repeated recovery attempts.
   */

  if (input.attemptCount >= MAX_ATTEMPTS) {
    return {
      risk_score: 0.15,
      confidence: 1,
      recommendation: "HUMAN_APPROVAL",
      reason:
        "Maximum recovery attempts have already been reached.",
    };
  }

  /*
   * ---------------------------------------------------------
   * HARD SAFETY RULE 3
   * ---------------------------------------------------------
   *
   * Large amounts require human approval.
   */

  if (input.paymentAmount > AUTONOMOUS_LIMIT) {
    return {
      risk_score: 0.5,
      confidence: 1,
      recommendation: "HUMAN_APPROVAL",
      reason:
        "Payment amount exceeds the autonomous recovery limit of ₹10,000.",
    };
  }

  /*
   * ---------------------------------------------------------
   * BASE RISK SCORE
   * ---------------------------------------------------------
   */

  let riskScore = 0.5;

  const reasons: string[] = [];

  /*
   * Failed payments are usually strong recovery candidates.
   */

  if (input.paymentStatus === "FAILED") {
    riskScore += 0.25;

    reasons.push(
      "The payment recently failed."
    );
  }

  /*
   * Overdue payments are also recoverable, but slightly
   * less certain than an immediate payment failure.
   */

  if (input.paymentStatus === "OVERDUE") {
    riskScore += 0.15;

    reasons.push(
      "The payment is overdue."
    );
  }

  /*
   * More attempts reduce recovery confidence.
   */

  if (input.attemptCount === 1) {
    riskScore -= 0.10;

    reasons.push(
      "One recovery attempt has already occurred."
    );
  }

  /*
   * Clamp score between 0 and 1.
   */

  riskScore = Math.max(
    0,
    Math.min(1, riskScore)
  );

  /*
   * ---------------------------------------------------------
   * RECOMMENDATION
   * ---------------------------------------------------------
   */

  let recommendation:
    | "CREATE_PAYMENT_LINK"
    | "SEND_REMINDER"
    | "HUMAN_APPROVAL"
    | "DO_NOT_CONTACT";

  if (
    input.paymentStatus === "FAILED" &&
    riskScore >= 0.7
  ) {
    recommendation = "CREATE_PAYMENT_LINK";

    reasons.push(
      "A payment recovery link is appropriate within the autonomous limit."
    );
  } else if (
    input.paymentStatus === "OVERDUE" &&
    riskScore >= 0.6
  ) {
    recommendation = "SEND_REMINDER";

    reasons.push(
      "A reminder is appropriate for the overdue payment."
    );
  } else {
    recommendation = "HUMAN_APPROVAL";

    reasons.push(
      "The case does not meet the confidence threshold for autonomous recovery."
    );
  }

  /*
   * ---------------------------------------------------------
   * CONFIDENCE
   * ---------------------------------------------------------
   */

  let confidence = 0.75;

  if (
    input.paymentStatus === "FAILED" &&
    input.attemptCount === 0
  ) {
    confidence = 0.92;
  }

  if (
    input.paymentStatus === "OVERDUE"
  ) {
    confidence = 0.85;
  }

  if (input.attemptCount === 1) {
    confidence -= 0.10;
  }

  confidence = Math.max(
    0,
    Math.min(1, confidence)
  );

  return {
    risk_score: Number(
      riskScore.toFixed(2)
    ),

    confidence: Number(
      confidence.toFixed(2)
    ),

    recommendation,

    reason: reasons.join(" "),
  };
}