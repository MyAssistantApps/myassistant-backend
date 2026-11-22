# MYASSISTANT_BACKEND — place this file in the repo root
#
# Base: node:22-slim (Debian/glibc, Node 22 LTS — 20 reached end of life in
# April 2026), NOT alpine: the runtime stage needs Debian's ffmpeg and the
# DejaVu/Noto fonts below. Every dependency is pure JavaScript, so nothing
# is compiled and the builder stage needs no toolchain.

# ---------- Stage 1: install deps ----------
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:22-slim

# ca-certificates: node:22-slim ships an empty SYSTEM trust store. Node's
# own fetch bundles its CAs, but native code and child processes validate
# TLS against the system store and fail without it. Keep this even if
# the image is slimmed further.
#
# ffmpeg is for VIDEO GENERATION (and image transforms). It builds a
# genuine MP4 out of generated keyframes — a slow push with crossfades,
# honestly described as that rather than passed off as synthesised video.
#
# ffmpeg here is the headless Debian build (no X, no GUI deps).
#
# FONTS are for PDF GENERATION. PDFKit's built-in fonts are WinAnsi only:
# they cannot draw a single Devanagari, Kannada, Tamil, Telugu, Malayalam
# or Bengali glyph, so a report asked for in Hindi would come out as a
# page of empty boxes. DejaVu covers Latin properly (the built-ins have no
# ₹ either); Noto covers the Indian scripts. docgen.js DISCOVERS whichever
# of these exist at runtime and falls back to the built-ins when none do,
# so removing them degrades PDFs rather than breaking the service.
#
# The Office formats (.docx/.pptx/.xlsx) need none of this — the reader on
# the phone supplies the fonts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates ffmpeg fonts-dejavu-core fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# Server-kept files live here (DATA_DIR: document uploads, recordings, voice
# samples, the published APK); compose.yml mounts ./data:/app/data. Created
# before dropping root so the 'node' user can write to it.
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data

# Don't run as root inside the container
USER node

ENV NODE_ENV=production
# The commit this image was built from; /health reports it (CI passes it).
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
EXPOSE 3000

# Health check via node itself — slim ships no wget/curl, and adding one
# just for this would grow the image.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
