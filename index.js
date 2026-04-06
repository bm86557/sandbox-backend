require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');


const app = express();
app.use(cors());
app.use(express.json());

const PKR_TO_USD = 278;

app.post('/create-payment-intent',async(req,res)=>{
try {
  const {amountPKR} = req.body;
  const amountUSDCents = Math.round((amountPKR/PKR_TO_USD)*100);
  const paymentIntent= await stripe.paymentIntents.create({
    amount : amountUSDCents,
    currency: 'usd',
  });
  res.json({clientSecret: paymentIntent.client_secret,amountUSD: (amountUSDCents/100).toFixed(2)});
} catch (error) {
  res.status(400).json({error: error.message});
}
});

app.listen(3000,()=> console.log("Server Running on Port 3000"));



