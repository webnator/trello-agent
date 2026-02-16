FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

FROM node:22-slim

RUN apt-get update && apt-get install -y git curl unzip && rm -rf /var/lib/apt/lists/*

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

# Install pnpm
RUN npm install -g pnpm

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
# Grant sudo for entrypoint volume ownership fixes (no password)
RUN useradd -m -s /bin/bash agent && \
    mkdir -p /workspace && chown agent:agent /workspace && \
    apt-get update && apt-get install -y sudo && rm -rf /var/lib/apt/lists/* && \
    echo "agent ALL=(ALL) NOPASSWD: /bin/chown" >> /etc/sudoers.d/agent
USER agent

# Install Claude Code CLI and bun for the agent user
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/agent/.local/bin:/home/agent/.bun/bin:${PATH}"

# Set git identity for automated commits
RUN git config --global user.name "Trello Agent" && \
    git config --global user.email "trello-agent@noreply.local"

WORKDIR /app

# Copy app files (owned by root, readable by agent)
COPY --chown=agent:agent package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build --chown=agent:agent /app/dist ./dist

COPY --chown=agent:agent entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/src/daemon.js"]
