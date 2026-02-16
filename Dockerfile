FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

FROM node:22-slim

RUN apt-get update && apt-get install -y git curl unzip && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Vercel CLI
RUN npm install -g vercel

# Install Supabase CLI (binary from GitHub)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${ARCH}.tar.gz" | tar -xz -C /usr/local/bin supabase

# Install GitHub CLI (via official apt repo)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install pnpm and bun
RUN npm install -g pnpm

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash agent
USER agent

# Install bun for the agent user
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/agent/.bun/bin:${PATH}"

# Set git identity for automated commits
RUN git config --global user.name "Trello Agent" && \
    git config --global user.email "trello-agent@noreply.local"

WORKDIR /app

# Copy app files (owned by root, readable by agent)
COPY --chown=agent:agent package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build --chown=agent:agent /app/dist ./dist

# Create workspace directory owned by agent
RUN mkdir -p /workspace

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

CMD ["node", "dist/src/daemon.js"]
