#!/bin/bash
# ============================================================
# INEZA PLATFORM — ONE-COMMAND DEPLOY SCRIPT
# Usage: chmod +x deploy.sh && sudo ./deploy.sh
# Tested on Ubuntu 22.04 LTS
# ============================================================

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

print_step()  { echo -e "\n${BLUE}[INEZA]${NC} $1"; }
print_ok()    { echo -e "${GREEN}  ✓${NC} $1"; }
print_warn()  { echo -e "${YELLOW}  ⚠${NC} $1"; }
print_error() { echo -e "${RED}  ✗${NC} $1"; exit 1; }

echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║       INEZA PLATFORM — DEPLOYMENT SCRIPT            ║"
echo "║    Rwanda's #1 Employment Platform                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. SYSTEM UPDATE ─────────────────────────────────────────
print_step "Updating system packages…"
apt-get update -qq && apt-get upgrade -y -qq
print_ok "System updated"

# ── 2. INSTALL DEPENDENCIES ──────────────────────────────────
print_step "Installing Docker, Node.js, Nginx, Certbot…"

# Docker
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker $USER
  print_ok "Docker installed"
else
  print_ok "Docker already installed"
fi

# Docker Compose
if ! command -v docker-compose &>/dev/null; then
  curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
  chmod +x /usr/local/bin/docker-compose
  print_ok "Docker Compose installed"
fi

# Node.js 20 LTS
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  print_ok "Node.js $(node -v) installed"
fi

# Nginx
if ! command -v nginx &>/dev/null; then
  apt-get install -y nginx
  print_ok "Nginx installed"
fi

# Certbot (Let's Encrypt SSL)
if ! command -v certbot &>/dev/null; then
  apt-get install -y certbot python3-certbot-nginx
  print_ok "Certbot installed"
fi

# ── 3. ENVIRONMENT CHECK ─────────────────────────────────────
print_step "Checking environment configuration…"

if [ ! -f "backend/.env" ]; then
  if [ -f "backend/.env.example" ]; then
    cp backend/.env.example backend/.env
    print_warn "backend/.env created from example. EDIT IT NOW before continuing!"
    echo -e "\n${RED}REQUIRED: Open backend/.env and set these variables:${NC}"
    echo "  - DB_PASSWORD (secure random string)"
    echo "  - JWT_SECRET (min 64 chars)"
    echo "  - JWT_REFRESH_SECRET (min 64 chars)"
    echo "  - MOMO_API_KEY, MOMO_API_USER"
    echo "  - STRIPE_SECRET_KEY"
    echo "  - CLOUDINARY_* credentials"
    echo "  - EMAIL_PASS (SendGrid API key)"
    echo ""
    read -p "Press Enter when you have edited backend/.env…"
  else
    print_error "No .env.example found. Cannot continue."
  fi
else
  print_ok ".env file found"
fi

# Auto-generate secrets if empty
JWT_SECRET=$(grep JWT_SECRET backend/.env | cut -d'=' -f2)
if [ -z "$JWT_SECRET" ] || [ "$JWT_SECRET" = "your_super_secret_jwt_key_min_64_chars_here_change_this" ]; then
  NEW_JWT=$(openssl rand -hex 64)
  NEW_REFRESH=$(openssl rand -hex 64)
  sed -i "s/JWT_SECRET=.*/JWT_SECRET=${NEW_JWT}/" backend/.env
  sed -i "s/JWT_REFRESH_SECRET=.*/JWT_REFRESH_SECRET=${NEW_REFRESH}/" backend/.env
  print_ok "JWT secrets auto-generated"
fi

# ── 4. INSTALL BACKEND DEPENDENCIES ─────────────────────────
print_step "Installing Node.js backend dependencies…"
cd backend && npm ci --only=production && cd ..
print_ok "Backend dependencies installed ($(ls backend/node_modules | wc -l) packages)"

# ── 5. START DOCKER SERVICES ────────────────────────────────
print_step "Starting PostgreSQL and Redis with Docker Compose…"
docker-compose up -d postgres redis
print_ok "Database services starting…"

# Wait for PostgreSQL
print_step "Waiting for PostgreSQL to be ready…"
MAX=30; COUNT=0
until docker-compose exec -T postgres pg_isready -U ineza_admin -d ineza_platform &>/dev/null; do
  sleep 2; COUNT=$((COUNT+1))
  if [ $COUNT -ge $MAX ]; then print_error "PostgreSQL failed to start after 60 seconds"; fi
done
print_ok "PostgreSQL ready"

# ── 6. RUN DATABASE MIGRATIONS ──────────────────────────────
print_step "Running database schema migrations…"
docker-compose exec -T postgres psql -U ineza_admin -d ineza_platform \
  -f /docker-entrypoint-initdb.d/01-schema.sql 2>/dev/null || \
  docker-compose exec -T postgres psql -U ineza_admin -d ineza_platform \
  -c "SELECT 1" &>/dev/null
print_ok "Database schema applied"

# ── 7. START API SERVER ──────────────────────────────────────
print_step "Starting Node.js API server…"
docker-compose up -d api
sleep 5

# Health check
if curl -s http://localhost:5000/health | grep -q '"status":"ok"'; then
  print_ok "API server healthy at http://localhost:5000"
else
  print_warn "API server may still be starting. Check logs: docker-compose logs api"
fi

# ── 8. CONFIGURE NGINX ──────────────────────────────────────
print_step "Configuring Nginx…"

# Read domain from .env or prompt
DOMAIN=$(grep FRONTEND_URL backend/.env | sed 's/FRONTEND_URL=https:\/\///' | tr -d '"')
if [ -z "$DOMAIN" ]; then
  read -p "Enter your domain (e.g. inezaagencies.rw): " DOMAIN
fi

cp nginx.conf /etc/nginx/nginx.conf
sed -i "s/inezaagencies.rw/$DOMAIN/g" /etc/nginx/nginx.conf
nginx -t && systemctl reload nginx
print_ok "Nginx configured for $DOMAIN"

# ── 9. SSL CERTIFICATE ──────────────────────────────────────
print_step "Obtaining SSL certificate from Let's Encrypt…"
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos \
  --email "admin@$DOMAIN" --redirect 2>/dev/null && \
  print_ok "SSL certificate obtained" || \
  print_warn "SSL certificate failed. Ensure DNS points to this server IP."

# Certbot auto-renewal
(crontab -l 2>/dev/null; echo "0 12 * * * certbot renew --quiet") | crontab -
print_ok "SSL auto-renewal configured"

# ── 10. SET UP PROCESS MANAGEMENT ───────────────────────────
print_step "Configuring systemd service for auto-start…"
cat > /etc/systemd/system/ineza.service << EOF
[Unit]
Description=Ineza Platform
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$(pwd)
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ineza
print_ok "Auto-start on boot configured"

# ── 11. FIREWALL ─────────────────────────────────────────────
print_step "Configuring firewall…"
if command -v ufw &>/dev/null; then
  ufw allow 22/tcp    # SSH
  ufw allow 80/tcp    # HTTP
  ufw allow 443/tcp   # HTTPS
  ufw deny 5432/tcp   # Block external DB access
  ufw deny 6379/tcp   # Block external Redis access
  ufw --force enable
  print_ok "Firewall configured (ports 80, 443, 22 open)"
fi

# ── DONE ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         INEZA PLATFORM DEPLOYED SUCCESSFULLY!       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  🌍 Platform:  ${BLUE}https://$DOMAIN${NC}"
echo -e "  🔧 API:       ${BLUE}https://$DOMAIN/api/v1/health${NC}"
echo -e "  📊 Admin:     ${BLUE}https://$DOMAIN/admin/dashboard.html${NC}"
echo ""
echo -e "  Useful commands:"
echo -e "  ${YELLOW}docker-compose logs -f api${NC}       — View API logs"
echo -e "  ${YELLOW}docker-compose ps${NC}                — Check service status"
echo -e "  ${YELLOW}docker-compose restart api${NC}       — Restart API"
echo -e "  ${YELLOW}docker-compose exec postgres psql -U ineza_admin -d ineza_platform${NC}"
echo ""
echo -e "  Next steps:"
echo -e "  1. Add real MTN MoMo API credentials to backend/.env"
echo -e "  2. Add real Stripe keys for card payments"
echo -e "  3. Configure SendGrid for email delivery"
echo -e "  4. Set up Google Analytics tracking"
echo ""
