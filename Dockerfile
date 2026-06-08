# ============================================================
# INEZA PLATFORM — BACKEND DOCKERFILE
# Node.js 20 LTS · Production-optimised · Multi-stage build
# ============================================================

# Stage 1: Build dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# Stage 2: Production image
FROM node:20-alpine AS runner
WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 ineza && \
    adduser  --system --uid 1001 ineza

# Install security patches & curl for healthcheck
RUN apk update && apk upgrade && \
    apk add --no-cache curl dumb-init && \
    rm -rf /var/cache/apk/*

# Copy from deps stage
COPY --from=deps --chown=ineza:ineza /app/node_modules ./node_modules

# Copy application code
COPY --chown=ineza:ineza . .

# Create logs directory
RUN mkdir -p logs && chown -R ineza:ineza logs

# Drop to non-root user
USER ineza

# Environment
ENV NODE_ENV=production
ENV PORT=5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1

# Expose port
EXPOSE 5000

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
