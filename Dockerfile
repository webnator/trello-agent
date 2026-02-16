FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

FROM node:22-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Set git identity for automated commits
RUN git config --global user.name "Trello Agent" && \
    git config --global user.email "trello-agent@noreply.local"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Create workspace directory
RUN mkdir -p /workspace

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

CMD ["node", "dist/src/daemon.js"]
