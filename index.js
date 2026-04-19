/**
 * Stripe + Firestore seller wallets (Railway).
 *
 * Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, FIREBASE_CREDENTIALS_BASE64 (JSON as base64)
 * Optional: PKR_TO_USD (default 278, must match Android)
 */
require('dotenv').config();

const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
let stripe = null;

let db = null;
let startupError = null;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Missing STRIPE_SECRET_KEY');
  }
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  if (!process.env.FIREBASE_CREDENTIALS_BASE64) {
    throw new Error('Missing FIREBASE_CREDENTIALS_BASE64');
  }
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf8')
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
  console.log('Firebase initialized');
} catch (err) {
  startupError = err;
  console.error('Startup config error:', err.message);
}

const PKR_TO_USD = parseFloat(process.env.PKR_TO_USD || '278', 10);

function pkrToUsdCents(amountPKR) {
  const cents = Math.round((amountPKR / PKR_TO_USD) * 100);
  return Math.max(50, cents);
}

/** Stripe metadata values are max 500 chars — we only use compact sellerId:amt,sellerId:amt */
function parsePayoutsFromMetadata(metadata) {
  const sellerIdField = metadata && metadata.sellerId ? String(metadata.sellerId) : '';
  if (!sellerIdField) return [];

  return sellerIdField
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.lastIndexOf(':');
      if (idx <= 0) return null;
      const sid = entry.slice(0, idx).trim();
      const amt = parseInt(entry.slice(idx + 1), 10);
      if (!sid || Number.isNaN(amt)) return null;
      return {
        sellerId: sid,
        amountPKR: amt,
        productSummary: (metadata && metadata.productName) || 'Craftoria Order',
      };
    })
    .filter(Boolean);
}

const app = express();

app.get('/', (_req, res) => {
  res.type('text').send('Stripe wallet API OK');
});

app.get('/health', (_req, res) => {
  if (startupError) {
    return res.status(500).json({ ok: false, error: startupError.message });
  }
  res.json({ ok: true });
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (startupError || !stripe || !db) {
    return res.status(500).json({ error: startupError?.message || 'Server not configured' });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const payouts = parsePayoutsFromMetadata(pi.metadata);

    if (!payouts.length) {
      console.warn('No payouts in metadata for PI', pi.id);
      return res.json({ received: true });
    }

    try {
      await db.runTransaction(async (tx) => {
        const lockRef = db.collection('stripeProcessedPayments').doc(pi.id);
        const lockSnap = await tx.get(lockRef);
        if (lockSnap.exists) return;

        tx.set(lockRef, {
          paymentIntentId: pi.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        for (const row of payouts) {
          const sellerRef = db.collection('users').doc(row.sellerId);
          tx.set(
            sellerRef,
            {
              walletBalance: admin.firestore.FieldValue.increment(row.amountPKR),
              walletUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          const transRef = db.collection('walletTransactions').doc();
          tx.set(transRef, {
            userId: row.sellerId,
            amountPKR: row.amountPKR,
            type: 'credit',
            status: 'completed',
            productName: row.productSummary,
            stripePaymentIntentId: pi.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });
      console.log('Credited sellers for', pi.id, 'count', payouts.length);
    } catch (dbError) {
      console.error('Wallet credit error:', dbError);
    }
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json());

app.post('/create-payment-intent', async (req, res) => {
  if (startupError || !stripe) {
    return res.status(500).json({ error: startupError?.message || 'Stripe not configured' });
  }
  try {
    const {
      amountPKR,
      sellerId,
      productId,
      productName,
      buyerId = '',
      platformFeePKR = 0,
      sellerPayouts,
    } = req.body;

    const amount = parseInt(amountPKR, 10);
    if (Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amountPKR' });
    }

    const payoutsArr = Array.isArray(sellerPayouts) ? sellerPayouts : [];
    const legacySeller = sellerId != null ? String(sellerId) : '';
    const compactSeller =
      payoutsArr.length > 0
        ? payoutsArr
            .map((p) => `${String(p.sellerId).trim()}:${parseInt(p.amountPKR, 10)}`)
            .join(',')
        : legacySeller;

    if (compactSeller.length > 500) {
      return res.status(400).json({
        error: 'Too many sellers for Stripe metadata (500 char limit). Split checkout.',
      });
    }

    const amountUSDCents = pkrToUsdCents(amount);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountUSDCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        sellerId: compactSeller,
        productId: productId != null ? String(productId).slice(0, 200) : '',
        productName: productName != null ? String(productName).slice(0, 200) : '',
        amountPKR: String(amount),
        platformFeePKR: String(parseInt(platformFeePKR, 10) || 0),
        buyerId: String(buyerId || '').slice(0, 128),
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      amountUSD: (amountUSDCents / 100).toFixed(2),
    });
  } catch (error) {
    console.error('Payment intent error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
