require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

// Firebase Admin SDK add karo
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); // apni file ka naam

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(cors());
app.use(express.json());

const PKR_TO_USD = 278;

// ─────────────────────────────────────────
// ROUTE 1: existing route ()
// ─────────────────────────────────────────
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amountPKR } = req.body;
    const amountUSDCents = Math.round((amountPKR / PKR_TO_USD) * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountUSDCents,
      currency: 'usd',
    });
    res.json({
      clientSecret: paymentIntent.client_secret,
      amountUSD: (amountUSDCents / 100).toFixed(2),
      paymentIntentId: paymentIntent.id  // ← ye add kiya
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// ROUTE 2: COD Order Firestore mein save karo
// ─────────────────────────────────────────
app.post('/orders/create-cod', async (req, res) => {
  try {
    const { buyerId, sellerId, items, totalAmountPKR, address } = req.body;

    const db = admin.firestore();
    const orderRef = db.collection('orders').doc();

    await orderRef.set({
      orderId: orderRef.id,
      buyerId,
      sellerId,
      items,
      address,
      totalAmountPKR,
      paymentMethod: 'cash_on_delivery',
      status: 'PENDING',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ orderId: orderRef.id });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// ROUTE 3: Stripe payment success ke baad order save karo
// ─────────────────────────────────────────
app.post('/orders/save-after-payment', async (req, res) => {
  try {
    const {
      buyerId,
      sellerId,
      items,
      totalAmountPKR,
      address,
      paymentIntentId
    } = req.body;

    const db = admin.firestore();
    const orderRef = db.collection('orders').doc();

    await orderRef.set({
      orderId: orderRef.id,
      buyerId,
      sellerId,
      items,
      address,
      totalAmountPKR,
      paymentMethod: 'stripe',
      stripePaymentIntentId: paymentIntentId,
      status: 'PENDING',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ orderId: orderRef.id });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// ROUTE 4: Seller order status update kare
// ─────────────────────────────────────────
app.patch('/orders/:orderId/status', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;
    // status = "CONFIRMED" ya "COMPLETED" ya "CANCELLED"

    const db = admin.firestore();
    await db.collection('orders').doc(orderId).update({ status });

    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => console.log("Server Running on Port 3000"));
