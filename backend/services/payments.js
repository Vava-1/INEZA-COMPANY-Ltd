'use strict';
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ============================================================
// INEZA PAYMENT SERVICE
// Integrates: MTN MoMo, Airtel Money, Stripe
// ============================================================

const PaymentService = {

  // ── MTN MOBILE MONEY ────────────────────────────────────────
  async initiateMoMo({ paymentId, amount, currency, phone, description }) {
    const refId = uuidv4();

    try {
      // Step 1: Get access token
      const tokenRes = await fetch(
        `${process.env.MOMO_BASE_URL}/collection/token/`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(
              `${process.env.MOMO_API_USER}:${process.env.MOMO_API_KEY}`
            ).toString('base64'),
            'Ocp-Apim-Subscription-Key': process.env.MOMO_COLLECTION_KEY
          }
        }
      );

      if (!tokenRes.ok) {
        logger.error('MoMo token fetch failed:', await tokenRes.text());
        throw new Error('MoMo authentication failed');
      }

      const { access_token } = await tokenRes.json();

      // Step 2: Request to Pay
      const cleanPhone = phone.replace(/[\s\-\+]/g, '');
      const payRes = await fetch(
        `${process.env.MOMO_BASE_URL}/collection/v1_0/requesttopay`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'X-Reference-Id': refId,
            'X-Target-Environment': process.env.MOMO_ENVIRONMENT || 'sandbox',
            'Ocp-Apim-Subscription-Key': process.env.MOMO_COLLECTION_KEY,
            'Content-Type': 'application/json',
            'X-Callback-Url': `${process.env.MOMO_CALLBACK_URL || process.env.FRONTEND_URL + '/api/v1/payments/momo/callback'}`
          },
          body: JSON.stringify({
            amount: amount.toString(),
            currency: 'RWF',
            externalId: paymentId,
            payer: { partyIdType: 'MSISDN', partyId: cleanPhone },
            payerMessage: description.substring(0, 160),
            payeeNote: `INEZA-${paymentId.substring(0, 8).toUpperCase()}`
          })
        }
      );

      if (payRes.status !== 202) {
        const errText = await payRes.text();
        logger.error('MoMo requesttopay failed:', errText);
        throw new Error('MoMo payment request failed');
      }

      logger.info(`MoMo payment initiated: refId=${refId}, amount=${amount}`);

      return {
        method: 'mtn_momo',
        reference: refId,
        status: 'pending',
        phone: cleanPhone,
        message: `A payment prompt has been sent to ${phone}. Please enter your MTN MoMo PIN to confirm.`,
        amount,
        currency: 'RWF'
      };
    } catch (err) {
      // In development/sandbox, simulate success
      if (process.env.NODE_ENV === 'development') {
        logger.warn('MoMo simulation mode (development)');
        return {
          method: 'mtn_momo',
          reference: refId,
          status: 'pending',
          simulated: true,
          phone,
          message: `[SANDBOX] Payment prompt simulated for ${phone}. Auto-completing in 5 seconds.`,
          amount,
          currency: 'RWF'
        };
      }
      throw err;
    }
  },

  async checkMoMoStatus(referenceId) {
    try {
      const tokenRes = await fetch(
        `${process.env.MOMO_BASE_URL}/collection/token/`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(
              `${process.env.MOMO_API_USER}:${process.env.MOMO_API_KEY}`
            ).toString('base64'),
            'Ocp-Apim-Subscription-Key': process.env.MOMO_COLLECTION_KEY
          }
        }
      );
      const { access_token } = await tokenRes.json();

      const statusRes = await fetch(
        `${process.env.MOMO_BASE_URL}/collection/v1_0/requesttopay/${referenceId}`,
        {
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'X-Target-Environment': process.env.MOMO_ENVIRONMENT || 'sandbox',
            'Ocp-Apim-Subscription-Key': process.env.MOMO_COLLECTION_KEY
          }
        }
      );

      return await statusRes.json();
    } catch (err) {
      logger.error('MoMo status check error:', err);
      return { status: 'PENDING' };
    }
  },

  // ── AIRTEL MONEY ─────────────────────────────────────────────
  async initiateAirtel({ paymentId, amount, currency, phone, description }) {
    const transactionId = `AIR-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    try {
      // Get OAuth token
      const tokenRes = await fetch(`${process.env.AIRTEL_BASE_URL}/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.AIRTEL_CLIENT_ID,
          client_secret: process.env.AIRTEL_CLIENT_SECRET,
          grant_type: 'client_credentials'
        })
      });
      const { access_token } = await tokenRes.json();

      const cleanPhone = phone.replace(/[\s\-\+]/g, '').replace(/^0/, '250');

      const payRes = await fetch(`${process.env.AIRTEL_BASE_URL}/merchant/v2/payments/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'X-Country': 'RW',
          'X-Currency': 'RWF'
        },
        body: JSON.stringify({
          reference: transactionId,
          subscriber: { country: 'RW', currency: 'RWF', msisdn: cleanPhone },
          transaction: {
            amount: amount.toString(),
            country: 'RW',
            currency: 'RWF',
            id: paymentId
          }
        })
      });

      const result = await payRes.json();
      if (result.status?.response_code !== 'DP00800001001') {
        throw new Error(`Airtel payment failed: ${result.status?.message}`);
      }

      return {
        method: 'airtel_money',
        reference: transactionId,
        status: 'pending',
        phone: cleanPhone,
        message: `A payment prompt has been sent to ${phone}. Enter your Airtel Money PIN to confirm.`,
        amount,
        currency: 'RWF'
      };
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        return {
          method: 'airtel_money',
          reference: transactionId,
          status: 'pending',
          simulated: true,
          phone,
          message: `[SANDBOX] Airtel Money payment simulated for ${phone}.`,
          amount,
          currency: 'RWF'
        };
      }
      throw err;
    }
  },

  async checkAirtelStatus(reference) {
    try {
      const tokenRes = await fetch(`${process.env.AIRTEL_BASE_URL}/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.AIRTEL_CLIENT_ID,
          client_secret: process.env.AIRTEL_CLIENT_SECRET,
          grant_type: 'client_credentials'
        })
      });
      const { access_token } = await tokenRes.json();

      const statusRes = await fetch(
        `${process.env.AIRTEL_BASE_URL}/standard/v1/payments/${reference}`,
        {
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'X-Country': 'RW',
            'X-Currency': 'RWF'
          }
        }
      );
      return await statusRes.json();
    } catch (err) {
      logger.error('Airtel status check error:', err);
      return { status: 'PENDING' };
    }
  },

  // ── STRIPE (International Cards) ─────────────────────────────
  async initiateStripe({ paymentId, amount, currency, email, description }) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

      // Convert RWF to USD cents (approximate) or use USD directly
      // Stripe minimum is 50 cents
      const stripeAmount = currency === 'RWF'
        ? Math.round(amount / 1200 * 100) // approx RWF to USD cents
        : Math.round(amount * 100);
      const stripeCurrency = currency === 'RWF' ? 'usd' : currency.toLowerCase();

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.max(stripeAmount, 50),
        currency: stripeCurrency,
        description,
        receipt_email: email,
        metadata: {
          ineza_payment_id: paymentId,
          original_currency: currency,
          original_amount: amount.toString()
        },
        automatic_payment_methods: { enabled: true }
      });

      logger.info(`Stripe PaymentIntent created: ${paymentIntent.id}`);

      return {
        method: 'card',
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        reference: paymentIntent.id,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        status: 'pending',
        amount: stripeAmount,
        currency: stripeCurrency
      };
    } catch (err) {
      logger.error('Stripe initiation error:', err);
      if (process.env.NODE_ENV === 'development') {
        return {
          method: 'card',
          paymentIntentId: `pi_simulated_${Date.now()}`,
          clientSecret: 'pi_simulated_secret',
          reference: `pi_sim_${Date.now()}`,
          simulated: true,
          status: 'pending'
        };
      }
      throw err;
    }
  },

  async checkStripeStatus(paymentIntentId) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      return { status: pi.status }; // 'succeeded', 'processing', 'payment_failed'
    } catch (err) {
      logger.error('Stripe status check error:', err);
      return { status: 'processing' };
    }
  },

  // ── Placement fee calculator ──────────────────────────────────
  calculatePlacementFee(annualSalary, plan = 'employer_business') {
    const rates = {
      employer_starter: 0.15,
      employer_business: 0.18,
      employer_enterprise: 0.22
    };
    const rate = rates[plan] || 0.18;
    return {
      fee: annualSalary * rate,
      rate,
      annual_salary: annualSalary
    };
  }
};

module.exports = PaymentService;
