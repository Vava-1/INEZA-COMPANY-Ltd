'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../models/db');
const { authenticate, requireRole } = require('../middleware/auth');
const paymentService = require('../services/payments');
const emailService = require('../services/email');
const logger = require('../utils/logger');

// Plan definitions
const PLANS = {
  candidate_pro:        { price: 5000,   currency: 'RWF', period: 'month', name: 'Pro Seeker' },
  candidate_premium:    { price: 9900,   currency: 'RWF', period: 'month', name: 'Premium Seeker' },
  employer_starter:     { price: 49000,  currency: 'RWF', period: 'month', name: 'Employer Starter' },
  employer_business:    { price: 120000, currency: 'RWF', period: 'month', name: 'Employer Business' },
  employer_enterprise:  { price: 290000, currency: 'RWF', period: 'month', name: 'Enterprise' },
};

const JOB_BOOSTS = {
  featured: { price: 15000,  currency: 'RWF', name: 'Featured Job Post' },
  urgent:   { price: 28000,  currency: 'RWF', name: 'Urgent + Featured Post' },
};

// ── POST /payments/initiate — Start a payment ─────────────────
router.post('/initiate', authenticate, async (req, res) => {
  try {
    const { payment_type, plan, job_id, boost_type, method, phone } = req.body;

    if (!['subscription','job_posting','upgrade'].includes(payment_type)) {
      return res.status(400).json({ error: 'Invalid payment_type' });
    }
    if (!['mtn_momo','airtel_money','card','bank_transfer'].includes(method)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    let amount, currency, description;
    if (payment_type === 'subscription' || payment_type === 'upgrade') {
      if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
      amount = PLANS[plan].price;
      currency = PLANS[plan].currency;
      description = `Ineza Platform — ${PLANS[plan].name} subscription`;
    } else if (payment_type === 'job_posting') {
      if (!JOB_BOOSTS[boost_type]) return res.status(400).json({ error: 'Invalid boost type' });
      amount = JOB_BOOSTS[boost_type].price;
      currency = JOB_BOOSTS[boost_type].currency;
      description = `Ineza Platform — ${JOB_BOOSTS[boost_type].name}`;
    }

    // Create pending payment record
    const { rows: [payment] } = await query(`
      INSERT INTO payments (user_id, plan, job_id, payment_type, description, amount, currency, method, gateway, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      RETURNING *
    `, [
      req.user.id, plan || null, job_id || null, payment_type,
      description, amount, currency, method,
      method === 'card' ? 'stripe' : method
    ]);

    let gatewayResponse;

    if (method === 'mtn_momo') {
      if (!phone) return res.status(400).json({ error: 'Phone number required for MTN MoMo' });
      gatewayResponse = await paymentService.initiateMoMo({
        paymentId: payment.id,
        amount,
        currency,
        phone,
        description
      });
    } else if (method === 'airtel_money') {
      if (!phone) return res.status(400).json({ error: 'Phone number required for Airtel Money' });
      gatewayResponse = await paymentService.initiateAirtel({
        paymentId: payment.id,
        amount,
        currency,
        phone,
        description
      });
    } else if (method === 'card') {
      gatewayResponse = await paymentService.initiateStripe({
        paymentId: payment.id,
        amount,
        currency,
        email: req.user.email,
        description
      });
    } else if (method === 'bank_transfer') {
      gatewayResponse = {
        method: 'bank_transfer',
        bank_name: 'Bank of Kigali',
        account_name: 'Ineza Company Ltd',
        account_number: '001-001-000-1234',
        reference: `INEZA-${payment.id.substring(0, 8).toUpperCase()}`,
        amount,
        currency,
        instructions: 'Transfer within 3 business days to activate your plan.'
      };
    }

    // Update payment with gateway ref
    await query(
      'UPDATE payments SET gateway_ref=$1, gateway_response=$2 WHERE id=$3',
      [gatewayResponse.reference || gatewayResponse.paymentIntentId, JSON.stringify(gatewayResponse), payment.id]
    );

    res.json({
      message: 'Payment initiated',
      payment_id: payment.id,
      gateway: gatewayResponse
    });
  } catch (err) {
    logger.error('POST /payments/initiate error:', err);
    res.status(500).json({ error: 'Payment initiation failed. Please try again.' });
  }
});

// ── GET /payments/verify/:id — Check payment status ──────────
router.get('/verify/:id', authenticate, async (req, res) => {
  try {
    const { rows: [payment] } = await query(
      'SELECT * FROM payments WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    if (payment.status === 'completed') {
      return res.json({ status: 'completed', payment });
    }

    // Poll gateway for status
    let gatewayStatus;
    if (payment.gateway === 'mtn_momo' && payment.gateway_ref) {
      gatewayStatus = await paymentService.checkMoMoStatus(payment.gateway_ref);
    } else if (payment.gateway === 'airtel') {
      gatewayStatus = await paymentService.checkAirtelStatus(payment.gateway_ref);
    } else if (payment.gateway === 'stripe') {
      gatewayStatus = await paymentService.checkStripeStatus(payment.gateway_ref);
    }

    if (gatewayStatus?.status === 'SUCCESSFUL' || gatewayStatus?.status === 'succeeded') {
      await completePayment(payment);
      return res.json({ status: 'completed', payment: { ...payment, status: 'completed' } });
    }

    res.json({ status: payment.status, payment });
  } catch (err) {
    logger.error('GET /payments/verify error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// ── POST /payments/momo/callback — MTN MoMo Webhook ──────────
router.post('/momo/callback', async (req, res) => {
  try {
    const { referenceId, status, financialTransactionId } = req.body;
    logger.info(`MoMo callback: ref=${referenceId}, status=${status}`);

    const { rows: [payment] } = await query(
      'SELECT * FROM payments WHERE gateway_ref=$1',
      [referenceId]
    );

    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    if (status === 'SUCCESSFUL') {
      await completePayment(payment, financialTransactionId);
    } else if (status === 'FAILED') {
      await query(
        'UPDATE payments SET status=$1, failed_at=NOW() WHERE id=$2',
        ['failed', payment.id]
      );
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('MoMo callback error:', err);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

// ── POST /payments/stripe/webhook — Stripe Webhook ───────────
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const { rows: [payment] } = await query(
      'SELECT * FROM payments WHERE stripe_payment_intent=$1', [pi.id]
    );
    if (payment) await completePayment(payment, pi.id);
  }

  res.json({ received: true });
});

// ── Shared payment completion logic ───────────────────────────
async function completePayment(payment, transactionRef = null) {
  await withTransaction(async (client) => {
    // Mark payment complete
    await client.query(
      `UPDATE payments SET status='completed', completed_at=NOW(), gateway_ref=COALESCE($1, gateway_ref) WHERE id=$2`,
      [transactionRef, payment.id]
    );

    // Activate plan / subscription
    if (payment.payment_type === 'subscription' || payment.payment_type === 'upgrade') {
      const planDuration = { month: 30 }; // days
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await client.query(
        `UPDATE users SET plan=$1, plan_expires_at=$2 WHERE id=$3`,
        [payment.plan, expiresAt, payment.user_id]
      );

      // Upsert subscription
      await client.query(`
        INSERT INTO subscriptions (user_id, plan, current_period_start, current_period_end, payment_method)
        VALUES ($1, $2, NOW(), $3, $4)
        ON CONFLICT (user_id) DO UPDATE SET
          plan=$2, current_period_start=NOW(), current_period_end=$3,
          status='active', payment_method=$4, cancelled_at=NULL
      `, [payment.user_id, payment.plan, expiresAt, payment.method]);
    }

    // Activate job boost
    if (payment.payment_type === 'job_posting' && payment.job_id) {
      const boostFields = payment.description?.includes('Urgent')
        ? 'featured=true, urgent=true, status=\'active\''
        : 'featured=true, status=\'active\'';
      await client.query(
        `UPDATE jobs SET ${boostFields} WHERE id=$1`, [payment.job_id]
      );
    }

    // Send confirmation email (non-blocking)
    const { rows: [user] } = await client.query(
      'SELECT email FROM users WHERE id=$1', [payment.user_id]
    );
    if (user) {
      emailService.sendPaymentConfirmation(user.email, {
        amount: payment.amount,
        currency: payment.currency,
        description: payment.description,
        reference: payment.id.substring(0, 8).toUpperCase()
      }).catch(logger.error);
    }
  });
}

// ── GET /payments/history — User's payment history ───────────
router.get('/history', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows } = await query(`
      SELECT id, payment_type, plan, description, amount, currency,
             method, status, gateway_ref, created_at, completed_at
      FROM payments
      WHERE user_id=$1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, parseInt(limit), offset]);

    res.json({ payments: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// ── GET /payments/subscription — Current subscription info ───
router.get('/subscription', authenticate, async (req, res) => {
  try {
    const { rows: [sub] } = await query(
      'SELECT * FROM subscriptions WHERE user_id=$1',
      [req.user.id]
    );
    res.json({ subscription: sub || null, plan: req.user.plan });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ── POST /payments/subscription/cancel ───────────────────────
router.post('/subscription/cancel', authenticate, async (req, res) => {
  try {
    const { reason } = req.body;
    await query(
      `UPDATE subscriptions SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1, auto_renew=false WHERE user_id=$2`,
      [reason || null, req.user.id]
    );
    res.json({ message: 'Subscription cancelled. Access continues until end of billing period.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Need express for raw body parsing
const express = require('express');
module.exports = router;
