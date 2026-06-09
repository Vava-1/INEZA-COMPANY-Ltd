'use strict';
const express = require('express');
const multer  = require('multer');
const cloudinary = require('cloudinary').v2;
const router  = express.Router();
const { query } = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg','image/png','image/webp'
    ];
    cb(allowed.includes(file.mimetype) ? null : new Error('Invalid file type'), allowed.includes(file.mimetype));
  }
});

// POST /uploads/cv
router.post('/cv', authenticate, upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;
    const result = await cloudinary.uploader.upload(dataURI, {
      folder: `ineza/cvs/${req.user.id}`,
      resource_type: 'raw',
      public_id: `cv_${Date.now()}`
    });
    await query(
      'UPDATE candidate_profiles SET cv_url=$1, cv_filename=$2, cv_uploaded_at=NOW() WHERE user_id=$3',
      [result.secure_url, req.file.originalname, req.user.id]
    );
    res.json({ url: result.secure_url, filename: req.file.originalname });
  } catch (err) {
    logger.error('CV upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// POST /uploads/photo
router.post('/photo', authenticate, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;
    const result = await cloudinary.uploader.upload(dataURI, {
      folder: `ineza/photos/${req.user.id}`,
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
      public_id: `photo_${Date.now()}`
    });
    const table = req.user.role === 'candidate' ? 'candidate_profiles' : 'employer_profiles';
    const col   = req.user.role === 'candidate' ? 'profile_photo_url' : 'logo_url';
    await query(`UPDATE ${table} SET ${col}=$1 WHERE user_id=$2`, [result.secure_url, req.user.id]);
    res.json({ url: result.secure_url });
  } catch (err) {
    logger.error('Photo upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// POST /uploads/company-logo
router.post('/company-logo', authenticate, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const result = await cloudinary.uploader.upload(`data:${req.file.mimetype};base64,${b64}`, {
      folder: `ineza/logos/${req.user.id}`,
      transformation: [{ width: 200, height: 200, crop: 'pad', background: 'white' }],
      public_id: `logo_${Date.now()}`
    });
    await query('UPDATE employer_profiles SET logo_url=$1 WHERE user_id=$2', [result.secure_url, req.user.id]);
    res.json({ url: result.secure_url });
  } catch (err) { res.status(500).json({ error: 'Upload failed' }); }
});

module.exports = router;
