import { Bot, InlineKeyboard } from "grammy";
import { findListByName, getCardsInList, createCard, createBoard, addAttachment } from "./trello.js";
import { createRepo } from "./github.js";
import { structureCard } from "./structure-card.js";
import {
  getAllProjects,
  getProject,
  addProject,
  hasProjects,
  updateProjectUrl,
} from "./projects.js";
import {
  getActiveProject,
  setActiveProject,
  ensureActiveProject,
} from "./session.js";
import type { ProjectConfig } from "../types.js";

let bot: Bot | null = null;

// Track chats waiting for input (conversation state)
interface PendingState {
  action: "task" | "newproject";
  flags?: { vercel?: boolean };
}
const pendingInput = new Map<number, PendingState>();

function getChatId(): string {
  const id = process.env.TELEGRAM_CHAT_ID;
  if (!id) throw new Error("Missing TELEGRAM_CHAT_ID");
  return id;
}

function getDefaultOrg(): string {
  return process.env.DEFAULT_GITHUB_ORG || "webnatorautoapps";
}

async function registerCommands(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "task", description: "Create a task in the active project" },
      { command: "status", description: "Show cards in To Do and In Progress" },
      { command: "url", description: "Show production URL" },
      { command: "seturl", description: "Set production URL" },
      { command: "projects", description: "List all registered projects" },
      { command: "project", description: "Switch active project" },
      { command: "newproject", description: "Create a new project" },
      { command: "help", description: "Show available commands" },
    ]);
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

function buildProjectKeyboard(): InlineKeyboard {
  const projects = getAllProjects();
  const keyboard = new InlineKeyboard();

  for (const project of projects) {
    keyboard.text(project.name, `select_project:${project.name}`).row();
  }

  return keyboard;
}

export async function startBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  bot = new Bot(token);

  // Register commands for autocomplete
  await registerCommands(bot);

  // Handle inline keyboard callbacks for project selection
  bot.callbackQuery(/^select_project:(.+)$/, async (ctx) => {
    const projectName = ctx.match[1];
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.answerCallbackQuery({ text: "Error: no chat ID" });
      return;
    }

    if (setActiveProject(chatId, projectName)) {
      await ctx.answerCallbackQuery({ text: `Switched to ${projectName}` });
      await ctx.editMessageText(`Active project: ${projectName}`);
    } else {
      await ctx.answerCallbackQuery({ text: `Project "${projectName}" not found` });
    }
  });

  bot.command("projects", async (ctx) => {
    const projects = getAllProjects();

    if (projects.length === 0) {
      await ctx.reply("No projects registered. Use /newproject <name> to create one.");
      return;
    }

    const chatId = ctx.chat.id;
    const activeProject = getActiveProject(chatId);

    const lines = ["Registered projects:"];
    for (const p of projects) {
      const marker = activeProject?.name === p.name ? " (active)" : "";
      lines.push(`  - ${p.name}: ${p.githubOwner}/${p.githubRepo}${marker}`);
    }

    await ctx.reply(lines.join("\n"));
  });

  bot.command("project", async (ctx) => {
    const projectName = ctx.match?.trim();
    const chatId = ctx.chat.id;

    if (!projectName) {
      // Show inline keyboard for project selection
      if (!hasProjects()) {
        await ctx.reply("No projects registered. Use /newproject <name> to create one.");
        return;
      }

      const keyboard = buildProjectKeyboard();
      const activeProject = getActiveProject(chatId);
      const currentText = activeProject
        ? `Current project: ${activeProject.name}\n\nSelect a project:`
        : "Select a project:";

      await ctx.reply(currentText, { reply_markup: keyboard });
      return;
    }

    // Switch to specified project
    if (setActiveProject(chatId, projectName)) {
      await ctx.reply(`Switched to project: ${projectName}`);
    } else {
      await ctx.reply(`Project "${projectName}" not found. Use /projects to see available projects.`);
    }
  });

  bot.command("newproject", async (ctx) => {
    const input = ctx.match?.trim() || "";

    // Parse flags
    const hasVercelFlag = /\s*--vercel\b/.test(input) || /\s*--landing\b/.test(input);
    const name = input.replace(/\s*--(vercel|landing)\b/g, "").trim();

    // If no name provided, prompt for input
    if (!name) {
      pendingInput.set(ctx.chat.id, { action: "newproject", flags: { vercel: hasVercelFlag } });
      const prompt = hasVercelFlag
        ? "Enter a name for the new Vercel/Next.js project:"
        : "Enter a name for the new project:";
      await ctx.reply(prompt, {
        reply_markup: { force_reply: true, selective: true },
      });
      return;
    }

    await handleNewProject(ctx.chat.id, name, ctx, { vercel: hasVercelFlag });
  });

  bot.command("task", async (ctx) => {
    const raw = ctx.match;
    const rawText = raw?.trim() || "";

    // If no text provided, prompt for input
    if (!rawText) {
      const chatId = ctx.chat.id;
      const project = ensureActiveProject(chatId);

      if (!project) {
        if (!hasProjects()) {
          await ctx.reply("No projects registered. Use /newproject <name> to create one first.");
        } else {
          const keyboard = buildProjectKeyboard();
          await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
        }
        return;
      }

      pendingInput.set(chatId, { action: "task" });
      await ctx.reply(`[${project.name}] Describe the task you want to create:`, {
        reply_markup: { force_reply: true, selective: true },
      });
      return;
    }

    await handleTaskCreation(ctx.chat.id, rawText, ctx);
  });

  bot.command("url", async (ctx) => {
    const chatId = ctx.chat.id;
    const project = ensureActiveProject(chatId);

    if (!project) {
      if (!hasProjects()) {
        await ctx.reply("No projects registered.");
      } else {
        const keyboard = buildProjectKeyboard();
        await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
      }
      return;
    }

    if (project.vercelUrl) {
      await ctx.reply(`[${project.name}] Production URL:\n${project.vercelUrl}`);
    } else {
      await ctx.reply(
        `[${project.name}] No production URL set.\n\n` +
        `Use /seturl <url> to set it manually.`
      );
    }
  });

  bot.command("seturl", async (ctx) => {
    const url = ctx.match?.trim();
    const chatId = ctx.chat.id;
    const project = ensureActiveProject(chatId);

    if (!project) {
      if (!hasProjects()) {
        await ctx.reply("No projects registered.");
      } else {
        const keyboard = buildProjectKeyboard();
        await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
      }
      return;
    }

    if (!url) {
      await ctx.reply("Usage: /seturl <production-url>\n\nExample: /seturl https://my-app.vercel.app");
      return;
    }

    // Basic URL validation
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      await ctx.reply("URL must start with http:// or https://");
      return;
    }

    if (updateProjectUrl(project.name, url)) {
      await ctx.reply(`[${project.name}] Production URL set to:\n${url}`);
    } else {
      await ctx.reply(`Failed to update URL for ${project.name}`);
    }
  });

  bot.command("help", async (ctx) => {
    const chatId = ctx.chat.id;
    const activeProject = getActiveProject(chatId);
    const projectInfo = activeProject
      ? `\nActive project: ${activeProject.name}`
      : "\nNo active project selected.";

    await ctx.reply(
      "Available commands:\n" +
      "  /task <text> — Create a task in the active project\n" +
      "  Send photo + caption — Create task with reference image\n" +
      "  /status — Show cards in To Do and In Progress\n" +
      "  /url — Show production URL (Vercel)\n" +
      "  /seturl <url> — Set production URL\n" +
      "  /projects — List all registered projects\n" +
      "  /project — Select active project (inline keyboard)\n" +
      "  /project <name> — Switch to a specific project\n" +
      "  /newproject <name> — Create a new project\n" +
      "  /newproject <name> --vercel — Create project with Vercel + Next.js scaffold\n" +
      "  /help — Show this help message" +
      projectInfo
    );
  });

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat.id;
    const project = ensureActiveProject(chatId);

    if (!project) {
      if (!hasProjects()) {
        await ctx.reply("No projects registered. Use /newproject <name> to create one first.");
      } else {
        const keyboard = buildProjectKeyboard();
        await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
      }
      return;
    }

    try {
      const [todoList, inProgressList] = await Promise.all([
        findListByName(project.trelloBoardId, "To Do"),
        findListByName(project.trelloBoardId, "In Progress"),
      ]);

      const lines: string[] = [`[${project.name}] Status:`];

      if (todoList) {
        const cards = await getCardsInList(todoList.id);
        lines.push(`\nTo Do (${cards.length}):`);
        if (cards.length === 0) lines.push("  (none)");
        for (const c of cards) lines.push(`  - ${c.name}`);
      }

      if (inProgressList) {
        const cards = await getCardsInList(inProgressList.id);
        lines.push(`\nIn Progress (${cards.length}):`);
        if (cards.length === 0) lines.push("  (none)");
        for (const c of cards) lines.push(`  - ${c.name}`);
      }

      if (!todoList && !inProgressList) {
        await ctx.reply(`[${project.name}] Could not find To Do or In Progress lists.`);
        return;
      }

      await ctx.reply(lines.join("\n"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`[${project.name}] Failed to fetch status: ${msg}`);
    }
  });

  // Handle text messages for pending input (conversation flow)
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const pending = pendingInput.get(chatId);

    if (!pending) {
      // No pending action, ignore regular text messages
      return;
    }

    pendingInput.delete(chatId);
    const text = ctx.message.text.trim();

    if (!text) {
      await ctx.reply("No input provided. Action cancelled.");
      return;
    }

    if (pending.action === "task") {
      await handleTaskCreation(chatId, text, ctx);
    } else if (pending.action === "newproject") {
      await handleNewProject(chatId, text, ctx, pending.flags);
    }
  });

  // Handle photos with captions as tasks (design inspiration, etc.)
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption?.trim();

    if (!caption) {
      await ctx.reply(
        "To create a task with an image, add a caption describing the task.\n\n" +
        "Example: Send a photo with caption \"Create a landing page inspired by this design\""
      );
      return;
    }

    const project = ensureActiveProject(chatId);
    if (!project) {
      if (!hasProjects()) {
        await ctx.reply("No projects registered. Use /newproject <name> to create one first.");
      } else {
        const keyboard = buildProjectKeyboard();
        await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
      }
      return;
    }

    await ctx.reply(`[${project.name}] Processing your request with image...`);

    try {
      // Get the largest photo (last in array)
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];

      // Get file URL from Telegram
      const file = await ctx.api.getFile(largestPhoto.file_id);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const imageUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fileName = file.file_path?.split("/").pop() || "image.jpg";

      await handleTaskCreation(chatId, caption, ctx, imageUrl, fileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`[${project.name}] Failed to process image: ${msg}`);
    }
  });

  // Handle documents (files) with captions as tasks
  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption?.trim();

    if (!caption) {
      await ctx.reply(
        "To create a task with a file, add a caption describing the task.\n\n" +
        "Example: Send a file with caption \"Use this config file for the project setup\""
      );
      return;
    }

    const project = ensureActiveProject(chatId);
    if (!project) {
      if (!hasProjects()) {
        await ctx.reply("No projects registered. Use /newproject <name> to create one first.");
      } else {
        const keyboard = buildProjectKeyboard();
        await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
      }
      return;
    }

    await ctx.reply(`[${project.name}] Processing your request with file...`);

    try {
      const document = ctx.message.document;
      const file = await ctx.api.getFile(document.file_id);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fileName = document.file_name || "attachment";

      await handleTaskCreation(chatId, caption, ctx, fileUrl, fileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`[${project.name}] Failed to process file: ${msg}`);
    }
  });

  // Handle audio files with captions as tasks
  bot.on("message:audio", async (ctx) => {
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption?.trim();

    if (!caption) {
      await ctx.reply(
        "To create a task with an audio file, add a caption describing the task.\n\n" +
        "Example: Send an audio file with caption \"Add this sound effect to the app\""
      );
      return;
    }

    const project = ensureActiveProject(chatId);
    if (!project) {
      if (!hasProjects()) {
        await ctx.reply("No projects registered. Use /newproject <name> to create one first.");
      } else {
        const keyboard = buildProjectKeyboard();
        await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
      }
      return;
    }

    await ctx.reply(`[${project.name}] Processing your request with audio...`);

    try {
      const audio = ctx.message.audio;
      const file = await ctx.api.getFile(audio.file_id);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fileName = audio.file_name || `audio.${audio.mime_type?.split("/")[1] || "mp3"}`;

      await handleTaskCreation(chatId, caption, ctx, fileUrl, fileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`[${project.name}] Failed to process audio: ${msg}`);
    }
  });

  // Handle voice messages with captions as tasks
  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption?.trim();

    if (!caption) {
      await ctx.reply(
        "To create a task with a voice message, add a caption describing the task.\n\n" +
        "Example: Send a voice message with caption \"Transcribe this and add to docs\""
      );
      return;
    }

    const project = ensureActiveProject(chatId);
    if (!project) {
      if (!hasProjects()) {
        await ctx.reply("No projects registered. Use /newproject <name> to create one first.");
      } else {
        const keyboard = buildProjectKeyboard();
        await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
      }
      return;
    }

    await ctx.reply(`[${project.name}] Processing your request with voice message...`);

    try {
      const voice = ctx.message.voice;
      const file = await ctx.api.getFile(voice.file_id);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fileName = "voice-message.ogg";

      await handleTaskCreation(chatId, caption, ctx, fileUrl, fileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`[${project.name}] Failed to process voice message: ${msg}`);
    }
  });

  // Handle video files with captions as tasks
  bot.on("message:video", async (ctx) => {
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption?.trim();

    if (!caption) {
      await ctx.reply(
        "To create a task with a video, add a caption describing the task.\n\n" +
        "Example: Send a video with caption \"Create an intro animation like this\""
      );
      return;
    }

    const project = ensureActiveProject(chatId);
    if (!project) {
      if (!hasProjects()) {
        await ctx.reply("No projects registered. Use /newproject <name> to create one first.");
      } else {
        const keyboard = buildProjectKeyboard();
        await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
      }
      return;
    }

    await ctx.reply(`[${project.name}] Processing your request with video...`);

    try {
      const video = ctx.message.video;
      const file = await ctx.api.getFile(video.file_id);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const fileName = video.file_name || `video.${video.mime_type?.split("/")[1] || "mp4"}`;

      await handleTaskCreation(chatId, caption, ctx, fileUrl, fileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`[${project.name}] Failed to process video: ${msg}`);
    }
  });

  bot.start();
  console.log("Telegram bot started");
}

// Helper function to handle task creation
async function handleTaskCreation(
  chatId: number,
  rawText: string,
  ctx: { reply: (text: string, options?: object) => Promise<unknown> },
  attachmentUrl?: string,
  attachmentName?: string
): Promise<void> {
  const project = ensureActiveProject(chatId);

  if (!project) {
    if (!hasProjects()) {
      await ctx.reply("No projects registered. Use /newproject <name> to create one first.");
    } else {
      const keyboard = buildProjectKeyboard();
      await ctx.reply("Session expired. Please select a project:", { reply_markup: keyboard });
    }
    return;
  }

  const processingMsg = attachmentUrl
    ? `[${project.name}] Processing your request with attachment...`
    : `[${project.name}] Processing your request...`;
  await ctx.reply(processingMsg);

  try {
    const todoList = await findListByName(project.trelloBoardId, "To Do");
    if (!todoList) {
      await ctx.reply(`[${project.name}] Could not find a 'To Do' list on the board.`);
      return;
    }

    const structured = await structureCard(rawText);

    // Add note about attachment to description if provided
    let description = structured.description;
    if (attachmentUrl) {
      description += `\n\n---\n**File attached:** ${attachmentName || "attachment"}`;
    }

    const card = await createCard(todoList.id, structured.title, description);

    // Attach file if provided
    if (attachmentUrl) {
      try {
        await addAttachment(card.id, attachmentUrl, attachmentName || "attachment");
      } catch (attachErr) {
        console.error("Failed to attach file:", attachErr);
        // Continue anyway, card was created
      }
    }

    const successMsg = attachmentUrl
      ? `[${project.name}] Card created with attachment: ${card.name}\n${card.url}`
      : `[${project.name}] Card created: ${card.name}\n${card.url}`;
    await ctx.reply(successMsg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`[${project.name}] Failed to create card: ${msg}`);
  }
}

// Helper function to handle new project creation
async function handleNewProject(
  chatId: number,
  name: string,
  ctx: { reply: (text: string, options?: object) => Promise<unknown> },
  flags?: { vercel?: boolean }
): Promise<void> {
  // Validate name (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    await ctx.reply("Project name can only contain letters, numbers, hyphens, and underscores.");
    return;
  }

  // Check if project already exists
  if (getProject(name)) {
    await ctx.reply(`Project "${name}" already exists. Use /project ${name} to switch to it.`);
    return;
  }

  const org = getDefaultOrg();
  const isVercel = flags?.vercel ?? false;

  const creatingMsg = isVercel
    ? `Creating Vercel/Next.js project "${name}"...\n- GitHub repo: ${org}/${name}\n- Trello board: ${name}`
    : `Creating project "${name}"...\n- GitHub repo: ${org}/${name}\n- Trello board: ${name}`;
  await ctx.reply(creatingMsg);

  try {
    // 1. Create GitHub repo first (harder to undo)
    await createRepo(org, name);
    await ctx.reply(`GitHub repo created: https://github.com/${org}/${name}`);

    // 2. Create Trello board
    const board = await createBoard(name);
    await ctx.reply(`Trello board created: ${board.url}`);

    // 3. Register project in registry
    const config: ProjectConfig = {
      name,
      trelloBoardId: board.id,
      githubOwner: org,
      githubRepo: name,
      createdAt: new Date().toISOString(),
    };
    addProject(config);

    // 4. Auto-switch to new project
    setActiveProject(chatId, name);

    // 5. If Vercel flag, create initial scaffolding card
    if (isVercel) {
      const todoList = await findListByName(board.id, "To Do");
      if (todoList) {
        const scaffoldDesc = `## Objective
Create a modern Next.js 14+ landing page and deploy it to Vercel.

## Requirements

### 1. Initialize Next.js
Run: \`npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"\`

### 2. Set up basic structure
- Clean, minimal landing page layout
- Header component with site name
- Footer component
- Hero section on the home page
- Use App Router (not Pages Router)

### 3. Deploy to Vercel
Run: \`vercel link\` to connect this repo to a new Vercel project.
Then run: \`vercel --prod\` to deploy to production.

### 4. Save production URL
After deploying, extract the production URL from the vercel output and save it to the projects config:
Edit \`~/.trello-agent/projects.json\` and add a \`vercelUrl\` field to the "${name}" project with the production URL (e.g., "https://${name}-xxx.vercel.app").

### 5. Verify
- \`npm run build\` succeeds
- \`npm run dev\` starts the dev server
- Home page renders correctly
- Production URL is accessible

## Notes
This is an automated scaffold task. Keep it minimal and clean. The Vercel CLI is already configured locally.`;

        await createCard(todoList.id, "Scaffold Next.js landing page + deploy to Vercel", scaffoldDesc);
        await ctx.reply(`Scaffolding card created. The agent will set up Next.js and Vercel.`);
      }
    }

    const successMsg = isVercel
      ? `Project "${name}" created successfully!\n\n` +
        `- GitHub: https://github.com/${org}/${name}\n` +
        `- Trello: ${board.url}\n` +
        `\nSwitched to ${name}. A scaffolding task has been created.`
      : `Project "${name}" created successfully!\n\n` +
        `- GitHub: https://github.com/${org}/${name}\n` +
        `- Trello: ${board.url}\n\n` +
        `Switched to ${name}. Use /task to create cards.`;

    await ctx.reply(successMsg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Failed to create project: ${msg}`);
  }
}

export function stopBot(): void {
  if (bot) {
    bot.stop();
    console.log("Telegram bot stopped");
  }
}

async function sendMessage(text: string): Promise<void> {
  if (!bot) return;
  try {
    await bot.api.sendMessage(getChatId(), text);
  } catch (err) {
    console.error("Failed to send Telegram message:", err);
  }
}

export async function notifySuccess(projectName: string, cardName: string, prUrl: string): Promise<void> {
  await sendMessage(`[${projectName}] Task completed: ${cardName}\nPR merged: ${prUrl}`);
}

export async function notifyFailure(
  projectName: string,
  cardName: string,
  error: string,
  attempt: number,
  maxRetries: number
): Promise<void> {
  await sendMessage(
    `[${projectName}] Attempt ${attempt}/${maxRetries} failed for: ${cardName}\n\nError: ${error.slice(0, 500)}`
  );
}

export async function notifyMaxRetries(projectName: string, cardName: string): Promise<void> {
  await sendMessage(`[${projectName}] Task failed after max retries: ${cardName}`);
}
