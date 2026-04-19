const admin = require('firebase-admin');
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf8')
);

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { type } = require('node:os');
const { create } = require('node:domain');

admin.initializeApp({
  credential : admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
console.log("Firebase Connected");

const app = express();

app.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log('Webhook error:', err.message);
      return res.status(400).send('Webhook Error');
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      // Metadata se data nikalna
      const { sellerId, productName } = pi.metadata;

      try {
        const batch = db.batch();
        // sellerId string ko split karna
        const distributions = sellerId.split(',');

        distributions.forEach(entry => {
          const [sId, sAmount] = entry.split(':');
          const amount = parseInt(sAmount);

          if (sId && !isNaN(amount)) {
            // 1. Har seller ka wallet balance barhana
            const sellerRef = db.collection('users').doc(sId.trim());
            batch.update(sellerRef, {
              walletBalance: admin.firestore.FieldValue.increment(amount),
              walletUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // 2. Har seller ke liye transaction record banana (Loop ke andar)
            const transRef = db.collection('walletTransactions').doc();
            batch.set(transRef, {
              userId: sId.trim(),
              amountPKR: amount,
              type: 'credit',
              status: 'completed',
              productName: productName || 'Craftoria Order',
              stripePaymentIntentId: pi.id,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        });

        await batch.commit();
        console.log(`✅ Payment distributed to ${distributions.length} sellers`);

      } catch (dbError) {
        console.log('Firestore error:', dbError.message);
        // Error ke bawajood res bhejna zaroori hai
      }
    }

    // Stripe ko response dena ke event receive ho gaya
    res.json({ received: true });
  }
);

app.use(cors());
app.use(express.json());

const PKR_TO_USD = 278;

app.post('/create-payment-intent',async(req,res)=>{
try {
  const {amountPKR,sellerId,productId,productName} = req.body;
  const amountUSDCents = Math.round((amountPKR/PKR_TO_USD)*100);
  const paymentIntent= await stripe.paymentIntents.create({
    amount: amountUSDCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        sellerId: String(sellerId),
        productId: String(productId) || '',
        productName: String(productName)|| '',
        amountPKR: String(amountPKR),
      }
  });
  res.json({clientSecret: paymentIntent.client_secret,amountUSD: (amountUSDCents/100).toFixed(2)});
} catch (error) {
   console.log('Payment intent error:', error.message);
    res.status(400).json({ error: error.message });
}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=> console.log(`Server Running on Port ${PORT}`));



