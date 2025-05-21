import express from "express";
import Stripe from "stripe";
import { db } from "../utils/firebase.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const PLATFORM_FEE = 0.5;

// Create payment intent
router.post("/create-payment-intent", async (req, res) => {
  const { amount, userId, rentalId } = req.body;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "eur",
      metadata: {
        userId,
        rentalId,
      },
    });
    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("PaymentIntent Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Handle Stripe webhook
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      const rentalId = paymentIntent.metadata.rentalId;
      const userId = paymentIntent.metadata.userId;
      const amount = paymentIntent.amount / 100;

      try {
        const rentalRef = db.collection("rentals").doc(rentalId);
        const rentalDoc = await rentalRef.get();

        if (!rentalDoc.exists) throw new Error("Rental not found");

        const ownerId = rentalDoc.data().ownerId;
        const ownerRef = db.collection("users").doc(ownerId);
        const ownerDoc = await ownerRef.get();
        if (!ownerDoc.exists) throw new Error("Owner not found");

        const currentBalance = ownerDoc.data().accountBalance || 0;

        await rentalRef.update({ paymentStatus: "paid" });
        await ownerRef.update({
          accountBalance: currentBalance + (amount - PLATFORM_FEE),
        });

        console.log(
          `Rental ${rentalId} marked as paid. Owner balance updated.`
        );
        res.status(200).json({ received: true });
      } catch (err) {
        console.error("Firestore update error:", err.message);
        res.status(500).send("Server error");
      }
    } else {
      res.status(200).send("Event ignored");
    }
  }
);

// Withdraw funds to connected Stripe account
router.post("/withdraw", async (req, res) => {
  const { amount, userId, stripeAccountId } = req.body;

  try {
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100),
      currency: "eur",
      destination: stripeAccountId,
    });

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    const currentBalance = userDoc.data().accountBalance || 0;

    if (currentBalance < amount + PLATFORM_FEE) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    await userRef.update({
      accountBalance: currentBalance - (amount + PLATFORM_FEE),
    });

    res.send({ success: true, transferId: transfer.id });
  } catch (err) {
    console.error("Withdrawal Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
