// routes/payments.js
import express from "express";
import Stripe from "stripe";
import { db } from "../utils/firebase.js"; // Assuming this path is correct

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const PLATFORM_FEE = 0.5;

router.post("/create-account-link", async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "Missing userId." });
  }

  try {
    // 1. Check if the user already has a Stripe Account ID stored in Firestore
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    let stripeAccountId = userDoc.data()?.stripeAccountId;
    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "DE", // Or dynamically set based on user's location
        email: userDoc.data()?.email, // Pre-fill email if available
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: "individual", // Or 'company'
        // Add metadata to easily link back to your userId
        metadata: {
          yourAppUserId: userId,
        },
      });
      stripeAccountId = account.id;
      // Store the new stripeAccountId in Firestore
      await userRef.update({ stripeAccountId: stripeAccountId });
    }

    // 3. Create an Account Link for the user to onboard
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${process.env.FRONTEND_BASE_URL}/wallet?refresh=true`, // Your app's URL to handle refresh
      return_url: `${process.env.FRONTEND_BASE_URL}/wallet?success=true&stripeAccountId=${stripeAccountId}`, // Your app's URL to handle success
      type: "account_onboarding",
    });

    res.status(200).json({ url: accountLink.url });
  } catch (err) {
    console.error("Error creating Stripe Account Link:", err.message);
    res.status(500).json({ error: err.message });
  }
});

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

    // Handle the account.updated webhook event to save the stripeAccountId
    if (event.type === "account.updated") {
      const account = event.data.object;
      const stripeAccountId = account.id;
      const userId = account.metadata?.yourAppUserId; // Retrieve your internal userId from metadata

      if (userId) {
        try {
          await db.collection("users").doc(userId).update({
            stripeAccountId: stripeAccountId,
            payoutsEnabled: account.payouts_enabled,
            chargesEnabled: account.charges_enabled,
            // Add other relevant account details if needed
          });
          console.log(
            `Stripe Account ID ${stripeAccountId} updated for user ${userId}. Payouts Enabled: ${account.payouts_enabled}`
          );
        } catch (error) {
          console.error(
            "Error updating user's stripeAccountId in Firestore from webhook:",
            error
          );
        }
      }
    }

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      const rentalId = paymentIntent.metadata.rentalId;
      const userId = paymentIntent.metadata.userId; // This is the renter's ID
      const amount = paymentIntent.amount / 100;

      try {
        const rentalRef = db.collection("rentals").doc(rentalId);
        const rentalDoc = await rentalRef.get();

        if (!rentalDoc.exists) throw new Error("Rental not found");

        const ownerId = rentalDoc.data().ownerId; // This is the owner's ID
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
  const { amount, userId, stripeAccountId } = req.body; // stripeAccountId is passed from frontend

  try {
    // Validate that the user has sufficient balance in Firestore before attempting transfer
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found." });
    }
    const currentBalance = userDoc.data().accountBalance || 0;

    if (currentBalance < amount + PLATFORM_FEE) {
      return res.status(400).json({ error: "Insufficient balance." });
    }

    // --- CORRECTED TRANSFER LOGIC ---
    // Directly transfer to the connected Stripe account using its ID (acct_XXXXX)
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100), // Amount in cents
      currency: "eur",
      destination: stripeAccountId, // This is the ID of the user's connected Stripe account
      metadata: {
        userId: userId, // Optional: useful for your own logging/tracking
      },
    });

    // Update user's balance in Firestore after successful transfer creation
    await userRef.update({
      accountBalance: currentBalance - (amount + PLATFORM_FEE),
    });

    res.send({
      success: true,
      transferId: transfer.id,
      newBalance: currentBalance - (amount + PLATFORM_FEE),
    });
  } catch (err) {
    console.error("Withdrawal Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
