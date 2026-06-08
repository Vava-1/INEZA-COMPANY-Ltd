'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

// GET /messages/conversations
router.get('/conversations', authenticate, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.id, c.last_message_at, c.job_id,
        j.title AS job_title,
        CASE WHEN c.participant_1=$1 THEN c.participant_2 ELSE c.participant_1 END AS other_user_id,
        COALESCE(cp.first_name||' '||cp.last_name, ep.company_name, ou.email) AS other_name,
        COALESCE(cp.profile_photo_url, ep.logo_url) AS other_avatar,
        (SELECT m2.body FROM messages m2 WHERE m2.conversation_id=c.id ORDER BY m2.created_at DESC LIMIT 1) AS last_message,
        COUNT(m.id) FILTER (WHERE m.sender_id!=$1 AND m.read_at IS NULL) AS unread_count
      FROM conversations c
      JOIN users ou ON ou.id = CASE WHEN c.participant_1=$1 THEN c.participant_2 ELSE c.participant_1 END
      LEFT JOIN candidate_profiles cp ON cp.user_id = ou.id
      LEFT JOIN employer_profiles ep ON ep.user_id = ou.id
      LEFT JOIN jobs j ON c.job_id = j.id
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.participant_1=$1 OR c.participant_2=$1
      GROUP BY c.id, j.title, ou.id, ou.email, cp.first_name, cp.last_name, cp.profile_photo_url, ep.company_name, ep.logo_url
      ORDER BY c.last_message_at DESC
    `, [req.user.id]);
    res.json({ conversations: rows });
  } catch (err) {
    logger.error('GET /conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /messages/conversations/:id — messages in a conversation
router.get('/conversations/:id', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows: [conv] } = await query(
      'SELECT * FROM conversations WHERE id=$1 AND (participant_1=$2 OR participant_2=$2)',
      [req.params.id, req.user.id]
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const { rows: messages } = await query(`
      SELECT m.id, m.body, m.sender_id, m.status, m.read_at, m.created_at,
        COALESCE(cp.first_name||' '||cp.last_name, ep.company_name, u.email) AS sender_name,
        COALESCE(cp.profile_photo_url, ep.logo_url) AS sender_avatar
      FROM messages m JOIN users u ON m.sender_id=u.id
      LEFT JOIN candidate_profiles cp ON cp.user_id=u.id
      LEFT JOIN employer_profiles ep ON ep.user_id=u.id
      WHERE m.conversation_id=$1 ORDER BY m.created_at ASC
      LIMIT $2 OFFSET $3
    `, [req.params.id, parseInt(limit), offset]);
    await query(
      `UPDATE messages SET read_at=NOW(), status='read' WHERE conversation_id=$1 AND sender_id!=$2 AND read_at IS NULL`,
      [req.params.id, req.user.id]
    );
    res.json({ conversation: conv, messages });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch messages' }); }
});

// POST /messages/conversations — start or get existing
router.post('/conversations', authenticate, async (req, res) => {
  try {
    const { recipient_id, job_id, body } = req.body;
    if (!recipient_id || !body?.trim()) return res.status(400).json({ error: 'recipient_id and body required' });
    const p1 = req.user.id < recipient_id ? req.user.id : recipient_id;
    const p2 = req.user.id < recipient_id ? recipient_id : req.user.id;
    let { rows: [conv] } = await query(
      'SELECT id FROM conversations WHERE participant_1=$1 AND participant_2=$2 AND COALESCE(job_id::text,\'x\')=COALESCE($3::text,\'x\')',
      [p1, p2, job_id || null]
    );
    if (!conv) {
      const r = await query('INSERT INTO conversations (participant_1,participant_2,job_id) VALUES ($1,$2,$3) RETURNING *', [p1, p2, job_id || null]);
      conv = r.rows[0];
    }
    const { rows: [msg] } = await query('INSERT INTO messages (conversation_id,sender_id,body) VALUES ($1,$2,$3) RETURNING *', [conv.id, req.user.id, body.trim()]);
    await query('UPDATE conversations SET last_message_at=NOW() WHERE id=$1', [conv.id]);
    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${conv.id}`).emit('new_message', msg);
      io.to(`user:${recipient_id}`).emit('message_notification', { from: req.user.id, conversationId: conv.id, preview: body.substring(0,60) });
    }
    res.status(201).json({ conversation: conv, message: msg });
  } catch (err) { res.status(500).json({ error: 'Failed to send message' }); }
});

// POST /messages/conversations/:id/reply
router.post('/conversations/:id/reply', authenticate, async (req, res) => {
  try {
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Message body required' });
    const { rows: [conv] } = await query('SELECT * FROM conversations WHERE id=$1 AND (participant_1=$2 OR participant_2=$2)', [req.params.id, req.user.id]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const { rows: [msg] } = await query('INSERT INTO messages (conversation_id,sender_id,body) VALUES ($1,$2,$3) RETURNING *', [conv.id, req.user.id, body.trim()]);
    await query('UPDATE conversations SET last_message_at=NOW() WHERE id=$1', [conv.id]);
    const recipientId = conv.participant_1 === req.user.id ? conv.participant_2 : conv.participant_1;
    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${conv.id}`).emit('new_message', msg);
      io.to(`user:${recipientId}`).emit('message_notification', { from: req.user.id, conversationId: conv.id, preview: body.substring(0,60) });
    }
    res.status(201).json({ message: msg });
  } catch (err) { res.status(500).json({ error: 'Failed to send reply' }); }
});

module.exports = router;
