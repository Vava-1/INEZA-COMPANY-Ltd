'use strict';
// ============================================================
// INEZA PLATFORM — MAIN SERVER
// ============================================================
require('dotenv').config();

const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const cors           = require('cors');
const helmet         = require('helmet');
const compression    = require('compression');
const morgan         = require('morgan');
const cookieParser   = require('cookie-parser');
const rateLimit      = require('express-rate-limit');
const xssClean       = require('xss-clean');
const path           = require('path');

const logger         = require('./utils/logger');
const { connectDB }  = require('./models/db');

// Routes
const authRoutes     = require('./routes/auth');
const jobRoutes      = require('./routes/jobs');
const candidateRoutes = require('./routes/candidates');
const employerRoutes = require('./routes/employers');
const applicationRoutes = require('./routes/applications');
const paymentRoutes  = require('./routes/payments');
const messageRoutes  = require('./routes/messages');
const notifRoutes    = require('./routes/notifications');
const uploadRoutes   = require('./routes/uploads');
const adminRoutes    = require('./routes/admin');
const analyticsRoutes = require('./routes/analytics');

const app    = express();
const server = http.createServer(app);

// ── SOCKET.IO ────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
  }
});
app.set('io', io);

// Socket authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    socket.userRole = decoded.role;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.info(`Socket connected: ${socket.userId}`);
  socket.join(`user:${socket.userId}`);

  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv:${conversationId}`);
  });

  socket.on('send_message', async (data) => {
    // Broadcast to conversation room
    io.to(`conv:${data.conversationId}`).emit('new_message', {
      ...data,
      senderId: socket.userId,
      timestamp: new Date().toISOString()
    });
    // Also notify the recipient
    io.to(`user:${data.recipientId}`).emit('message_notification', {
      from: socket.userId,
      conversationId: data.conversationId,
      preview: data.body.substring(0, 60)
    });
  });

  socket.on('typing', (data) => {
    socket.to(`conv:${data.conversationId}`).emit('user_typing', {
      userId: socket.userId,
      conversationId: data.conversationId
    });
  });

  socket.on('disconnect', () => {
    logger.info(`Socket disconnected: ${socket.userId}`);
  });
});

// ── SECURITY MIDDLEWARE ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "res.cloudinary.com", "*.cloudinary.com"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "api.stripe.com", "sandbox.momodeveloper.mtn.com"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ].filter(Boolean);
    if (!origin || allowed.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With']
}));

app.use(xssClean());
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── LOGGING ───────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: msg => logger.info(msg.trim()) }
}));

// ── RATE LIMITING ────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 900000, // 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message: { error: 'Too many auth attempts. Please wait 15 minutes.' }
});

app.use('/api', globalLimiter);

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: require('./package.json').version,
    environment: process.env.NODE_ENV,
    uptime: process.uptime()
  });
});

// ── API ROUTES ───────────────────────────────────────────────
const API = '/api/v1';

app.use(`${API}/auth`,         authLimiter, authRoutes);
app.use(`${API}/jobs`,         jobRoutes);
app.use(`${API}/candidates`,   candidateRoutes);
app.use(`${API}/employers`,    employerRoutes);
app.use(`${API}/applications`, applicationRoutes);
app.use(`${API}/payments`,     paymentRoutes);
app.use(`${API}/messages`,     messageRoutes);
app.use(`${API}/notifications`,notifRoutes);
app.use(`${API}/uploads`,      uploadRoutes);
app.use(`${API}/admin`,        adminRoutes);
app.use(`${API}/analytics`,    analyticsRoutes);

// ── SERVE FRONTEND (Production) ──────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../')));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '../index.html'));
    }
  });
}

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// ── GLOBAL ERROR HANDLER ─────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`${err.status || 500} — ${err.message}`, {
    url: req.url,
    method: req.method,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }

  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await connectDB();
    logger.info('✅ Database connected');

    server.listen(PORT, () => {
      logger.info(`
╔═══════════════════════════════════════════════════╗
║          INEZA PLATFORM SERVER STARTED            ║
║                                                   ║
║  🚀 Running on: http://localhost:${PORT}             ║
║  🌍 Environment: ${(process.env.NODE_ENV || 'development').padEnd(20)}    ║
║  📊 API Docs: http://localhost:${PORT}/api/v1        ║
╚═══════════════════════════════════════════════════╝
      `);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => { logger.info('Server closed.'); process.exit(0); });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  server.close(() => process.exit(1));
});

start();

module.exports = { app, io };
