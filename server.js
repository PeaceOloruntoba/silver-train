import express from "express";
import Stripe from "stripe";
import cors from "cors";
import admin from "firebase-admin";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" }; // your Firebase admin SDK key

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// Firebase Admin Initialization
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Middlewares
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

// ✅ Route: Create Payment Intent
app.post("/create-payment-intent", async (req, res) => {
  const { amount, userId, rentalId } = req.body;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "eur",
      metadata: { userId, rentalId },
    });

    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error("Payment Intent Error:", error.message);
    res.status(500).send({ error: "Payment initiation failed." });
  }
});

// ✅ Route: Withdraw Funds
app.post("/withdraw", async (req, res) => {
  const { amount, accountId, userId } = req.body;
  const PLATFORM_FEE = 50; // in cents (0.5 EUR)

  try {
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100 - PLATFORM_FEE),
      currency: "eur",
      destination: accountId, // Connected Stripe Account ID
    });

    // Decrease user balance
    const userRef = db.collection("users").doc(userId);
    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      const currentBalance = userSnap.data()?.accountBalance || 0;
      if (currentBalance < amount) throw new Error("Insufficient funds");
      transaction.update(userRef, {
        accountBalance: currentBalance - amount,
      });
    });

    res.send({ success: true, transferId: transfer.id });
  } catch (error) {
    console.error("Withdrawal Error:", error.message);
    res.status(500).send({ error: "Withdrawal failed." });
  }
});

// ✅ Stripe Webhook
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    const rentalId = paymentIntent.metadata.rentalId;
    const userId = paymentIntent.metadata.userId;

    console.log(`✅ Payment for rental ${rentalId} confirmed.`);

    // Update Firestore
    const updatePaymentStatus = async () => {
      const rentalRef = db.collection("rentals").doc(rentalId);
      const rentalSnap = await rentalRef.get();
      const ownerId = rentalSnap.data()?.ownerId;
      const rentalAmount = paymentIntent.amount / 100;
      const PLATFORM_FEE = 0.5;

      const ownerRef = db.collection("users").doc(ownerId);
      await db.runTransaction(async (transaction) => {
        const ownerSnap = await transaction.get(ownerRef);
        const currentBalance = ownerSnap.data()?.accountBalance || 0;

        transaction.update(rentalRef, { paymentStatus: "paid" });
        transaction.update(ownerRef, {
          accountBalance: currentBalance + rentalAmount - PLATFORM_FEE,
        });
      });
    };

    updatePaymentStatus()
      .then(() => {
        res.json({ received: true });
      })
      .catch((err) => {
        console.error("Firestore update error:", err.message);
        res.status(500).send("Failed to update payment status.");
      });
  } else {
    res.json({ received: true });
  }
});

app.get("/", (req, res) => {
  res.send("Silver Train Backend is running ✅");
});

app.listen(port, () => {
  console.log(`🚂 Silver Train backend is running at http://localhost:${port}`);
});
