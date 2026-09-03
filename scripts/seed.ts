import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
}

if (!secretKey) {
  throw new Error("Missing SUPABASE_SECRET_KEY");
}

const supabase = createClient(supabaseUrl, secretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

type Customer = {
  name: string;
  email: string;
  phone: string;
  opted_out: boolean;
};

type Payment = {
  customer_id: string;
  amount: number;
  status:
    | "SUCCESS"
    | "FAILED"
    | "OVERDUE"
    | "PENDING"
    | "RECOVERED"
    | "CANCELLED";
  razorpay_payment_id: string | null;
  razorpay_payment_link_id: string | null;
};

const firstNames = [
  "Rahul",
  "Priya",
  "Amit",
  "Neha",
  "Arjun",
  "Ananya",
  "Rohan",
  "Kavya",
  "Aditya",
  "Sneha",
  "Vikram",
  "Ishita",
  "Karan",
  "Meera",
  "Nikhil",
  "Riya",
  "Varun",
  "Pooja",
  "Sahil",
  "Ayesha",
];

const lastNames = [
  "Sharma",
  "Shah",
  "Kumar",
  "Verma",
  "Patel",
  "Singh",
  "Gupta",
  "Mehta",
  "Joshi",
  "Malhotra",
  "Kapoor",
  "Agarwal",
  "Bansal",
  "Reddy",
  "Nair",
  "Iyer",
  "Desai",
  "Chopra",
  "Sethi",
  "Mishra",
];

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function randomAmount(): number {
  const amounts = [
    499,
    799,
    999,
    1299,
    1499,
    1999,
    2499,
    2999,
    3999,
    4999,
    6999,
    8999,
    9999,
    12000,
    15000,
    20000,
    25000,
  ];

  return randomItem(amounts);
}

function createCustomer(index: number): Customer {
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);

  return {
    name: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${index}@example.com`,
    phone: `+91${9000000000 + index}`,
    opted_out: index >= 450 && index < 500,
  };
}

function createPayment(
  customerId: string,
  index: number
): Payment {
  let status: Payment["status"];

  /*
    Dataset distribution:

    0-149   → SUCCESS
    150-249 → FAILED
    250-349 → OVERDUE
    350-399 → repeated failures
    400-449 → RECOVERED
    450-499 → should not contact / opted out
  */

  if (index < 150) {
    status = "SUCCESS";
  } else if (index < 250) {
    status = "FAILED";
  } else if (index < 350) {
    status = "OVERDUE";
  } else if (index < 400) {
    status = "FAILED";
  } else if (index < 450) {
    status = "RECOVERED";
  } else {
    status = "FAILED";
  }

  return {
    customer_id: customerId,
    amount: randomAmount(),
    status,
    razorpay_payment_id:
      status === "SUCCESS" || status === "RECOVERED"
        ? `pay_test_${index}_${Date.now()}`
        : null,
    razorpay_payment_link_id: null,
  };
}

async function clearExistingData() {
  console.log("Clearing previous seed data...");

  /*
   * Recovery records reference payments,
   * and payments reference customers.
   * Delete in dependency order.
   */

  const tables = [
    "audit_logs",
    "recovery_actions",
    "recovery_cases",
    "payments",
    "customers",
  ];

  for (const table of tables) {
    const { error } = await supabase
      .from(table)
      .delete()
      .not("id", "is", null);

    if (error) {
      throw new Error(
        `Failed clearing ${table}: ${error.message}`
      );
    }
  }

  console.log("Previous seed data cleared.");
}

async function insertCustomers(customers: Customer[]) {
  console.log(`Inserting ${customers.length} customers...`);

  const { data, error } = await supabase
    .from("customers")
    .insert(customers)
    .select("id");

  if (error) {
    throw new Error(
      `Customer insertion failed: ${error.message}`
    );
  }

  if (!data) {
    throw new Error("No customer records returned.");
  }

  return data;
}

async function insertPayments(payments: Payment[]) {
  console.log(`Inserting ${payments.length} payments...`);

  const batchSize = 100;

  for (let i = 0; i < payments.length; i += batchSize) {
    const batch = payments.slice(i, i + batchSize);

    const { error } = await supabase
      .from("payments")
      .insert(batch);

    if (error) {
      throw new Error(
        `Payment insertion failed: ${error.message}`
      );
    }

    console.log(
      `Inserted payments ${i + 1}-${Math.min(
        i + batchSize,
        payments.length
      )}`
    );
  }
}

async function createRecoveryCases() {
  console.log("Creating recovery cases...");

  const { data: payments, error } = await supabase
    .from("payments")
    .select("id, customer_id, amount, status");

  if (error) {
    throw new Error(
      `Could not retrieve payments: ${error.message}`
    );
  }

  if (!payments) {
    return;
  }

  const recoveryCases = [];

  for (const payment of payments) {
    if (
      payment.status === "FAILED" ||
      payment.status === "OVERDUE"
    ) {
      const { data: customer } = await supabase
        .from("customers")
        .select("opted_out")
        .eq("id", payment.customer_id)
        .single();

      const optedOut = customer?.opted_out ?? false;

      let status = "READY";
      let recommendedAction = "CREATE_PAYMENT_LINK";
      let riskScore = 0.75;
      let reason =
        "Payment is at risk and the customer may be suitable for recovery.";

      if (optedOut) {
        status = "BLOCKED";
        recommendedAction = "DO_NOT_CONTACT";
        riskScore = 0;
        reason =
          "Customer has opted out of recovery communications.";
      } else if (payment.amount > 10000) {
        status = "PENDING";
        recommendedAction = "HUMAN_APPROVAL";
        riskScore = 0.65;
        reason =
          "Payment exceeds the autonomous recovery limit.";
      } else if (payment.status === "OVERDUE") {
        recommendedAction = "SEND_REMINDER";
        riskScore = 0.8;
        reason =
          "Payment is overdue and may be recovered through a reminder.";
      } else {
        recommendedAction = "CREATE_PAYMENT_LINK";
        riskScore = 0.92;
        reason =
          "Recent payment failure with a recoverable payment amount.";
      }

      recoveryCases.push({
        payment_id: payment.id,
        risk_score: riskScore,
        ai_reason: reason,
        recommended_action: recommendedAction,
        status,
        attempt_count: 0,
      });
    }
  }

  const batchSize = 100;

  for (let i = 0; i < recoveryCases.length; i += batchSize) {
    const batch = recoveryCases.slice(i, i + batchSize);

    const { error } = await supabase
      .from("recovery_cases")
      .insert(batch);

    if (error) {
      throw new Error(
        `Recovery case insertion failed: ${error.message}`
      );
    }
  }

  console.log(
    `Created ${recoveryCases.length} recovery cases.`
  );
}

async function main() {
  console.log("");
  console.log("====================================");
  console.log("        RecoverAI Data Seeder       ");
  console.log("====================================");
  console.log("");

  await clearExistingData();

  const customers = Array.from(
    { length: 500 },
    (_, index) => createCustomer(index + 1)
  );

  const insertedCustomers =
    await insertCustomers(customers);

  const payments = insertedCustomers.map(
    (customer, index) =>
      createPayment(customer.id, index)
  );

  await insertPayments(payments);

  await createRecoveryCases();

  console.log("");
  console.log("====================================");
  console.log("        SEEDING COMPLETE             ");
  console.log("====================================");
  console.log("");
  console.log("500 customers created.");
  console.log("500 payments created.");
  console.log("Recovery cases generated.");
  console.log("");
}

main().catch((error) => {
  console.error("");
  console.error("SEEDING FAILED");
  console.error(error);
  process.exit(1);
});