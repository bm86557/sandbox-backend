// index.js - Enhanced for Multi-Seller Orders
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PKR_TO_USD = 278;

// ✅ IMPROVED: Create Payment Intent with Metadata
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { 
      amountPKR,
      metadata,
      description 
    } = req.body;
    
    // Validate input
    if (!amountPKR || amountPKR <= 0) {
      return res.status(400).json({ 
        error: 'Invalid amount. Amount must be greater than 0.' 
      });
    }
    
    // Convert PKR to USD cents
    const amountUSDCents = Math.round((amountPKR / PKR_TO_USD) * 100);
    
    // Minimum amount check (Stripe requires at least 50 cents)
    if (amountUSDCents < 50) {
      return res.status(400).json({ 
        error: 'Amount too small. Minimum is Rs. 14 (50 cents USD).' 
      });
    }
    
    // Create Payment Intent with complete metadata
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountUSDCents,
      currency: 'usd',
      description: description || `Order Payment - Rs. ${amountPKR}`,
      
      // ✅ Include all metadata from app
      metadata: metadata || {},
      
      // ✅ Automatic payment methods
      automatic_payment_methods: {
        enabled: true,
      },
    });
    
    console.log('Payment Intent Created:', {
      id: paymentIntent.id,
      amount: amountPKR,
      sellers: metadata?.sellerCount || 'N/A'
    });
    
    // Return client secret and payment intent ID
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amountUSD: (amountUSDCents / 100).toFixed(2),
      amountPKR: amountPKR
    });
    
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(400).json({ 
      error: error.message 
    });
  }
});

// ✅ NEW: Refund Payment
app.post('/refund-payment', async (req, res) => {
  try {
    const { 
      paymentIntentId,
      amount,
      reason,
      orderId 
    } = req.body;
    
    // Validate input
    if (!paymentIntentId) {
      return res.status(400).json({ 
        error: 'Payment Intent ID is required' 
      });
    }
    
    // Create refund
    const refundData = {
      payment_intent: paymentIntentId,
      reason: reason || 'requested_by_customer',
      metadata: {
        orderId: orderId || '',
        refundedAt: new Date().toISOString()
      }
    };
    
    // If amount specified, do partial refund (convert PKR to USD cents)
    if (amount && amount > 0) {
      const amountUSDCents = Math.round((amount / PKR_TO_USD) * 100);
      refundData.amount = amountUSDCents;
    }
    
    const refund = await stripe.refunds.create(refundData);
    
    console.log('Refund Created:', {
      id: refund.id,
      paymentIntent: paymentIntentId,
      orderId: orderId
    });
    
    res.json({
      success: true,
      refundId: refund.id,
      status: refund.status,
      amountUSD: (refund.amount / 100).toFixed(2),
      currency: refund.currency
    });
    
  } catch (error) {
    console.error('Error creating refund:', error);
    res.status(400).json({ 
      error: error.message 
    });
  }
});

// ✅ NEW: Cancel Payment Intent (before payment)
app.post('/cancel-payment-intent', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    
    if (!paymentIntentId) {
      return res.status(400).json({ 
        error: 'Payment Intent ID is required' 
      });
    }
    
    const paymentIntent = await stripe.paymentIntents.cancel(
      paymentIntentId
    );
    
    console.log('Payment Intent Cancelled:', paymentIntent.id);
    
    res.json({
      success: true,
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id
    });
    
  } catch (error) {
    console.error('Error cancelling payment intent:', error);
    res.status(400).json({ 
      error: error.message 
    });
  }
});

// ✅ NEW: Get Payment Intent Details
app.get('/payment-intent/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const paymentIntent = await stripe.paymentIntents.retrieve(id);
    
    res.json({
      id: paymentIntent.id,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
      metadata: paymentIntent.metadata,
      created: paymentIntent.created,
      description: paymentIntent.description
    });
    
  } catch (error) {
    console.error('Error retrieving payment intent:', error);
    res.status(400).json({ 
      error: error.message 
    });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Server is running',
    version: '2.0.0',
    endpoints: {
      createPayment: 'POST /create-payment-intent',
      refund: 'POST /refund-payment',
      cancel: 'POST /cancel-payment-intent',
      getPayment: 'GET /payment-intent/:id'
    },
    info: {
      currency: 'USD',
      conversionRate: `1 USD = ${PKR_TO_USD} PKR`,
      minAmount: 'Rs. 14 (50 cents USD)'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server Running on Port ${PORT}`);
  console.log(`📊 Conversion Rate: 1 USD = ${PKR_TO_USD} PKR`);
  console.log(`🔑 Stripe Mode: ${process.env.STRIPE_SECRET_KEY.startsWith('sk_test') ? 'TEST' : 'LIVE'}`);
});