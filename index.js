const admin = require('firebase-admin');
const serviceAccount = require('./creds.js');

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

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
      const { sellerId, productId, productName } = pi.metadata;

      const sellerPKR = Math.round((pi.amount / 100) * 278);

      try {
        const batch = db.batch();

        // Seller wallet update
        batch.update(db.collection('users').doc(sellerId), {
          walletBalance: admin.firestore.FieldValue.increment(sellerPKR),
          walletUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Transaction record
        batch.set(db.collection('walletTransactions').doc(), {
          userId: sellerId,
          type: 'credit',
          amountPKR: sellerPKR,
          productId: productId || '',
          productName: productName || '',
          stripePaymentIntentId: pi.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();
        console.log(`✅ PKR ${sellerPKR} seller ${sellerId} ko mila`);

      } catch (dbError) {
        console.log('Firestore error:', dbError.message);
      }
    }

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
        sellerId: sellerId || '',
        productId: productId || '',
        productName: productName || '',
        amountPKR: amountPKR.toString(),
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



