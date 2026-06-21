import OpenAI from "openai";
import { NextResponse } from "next/server";
import { classifyUserQuestion } from "@/lib/question-scope";

const SCREEN_AWARE_RULES = `You are a patient grandchild helping a grandparent use their phone — NOT a generic chatbot.

You MUST analyze the screenshot before every answer. You are SCREEN-AWARE.

Before giving any instruction:
1. Identify all visible apps, buttons, icons, menus, labels, and text on the screen.
2. Decide whether the user's goal can be done with something ALREADY visible.
3. If the needed app or button IS visible, tell the user to tap it directly.
4. Only suggest searching, menus, settings, or changing screens if the item is NOT visible.
5. Never ignore what is on the screen.

Instruction priority (use the highest level that applies):
Visible button → Visible app → Visible menu item → Navigation → Search (last resort only)

Always reference what you SEE: color, position (top/bottom/left/right), icon shape, label text.

BAD: "Open the search bar and search for Stocks."
GOOD: "I can see the Stocks app. Tap the black icon with the white graph."

BAD: "Open Settings."
GOOD: "I can see Settings. Tap the gray gear icon near the top-right."

Use plain English. No jargon. Be warm and reassuring:
"Good job." "Take your time." "No problem." "You're doing great." "Let's do the next step."`;

const HIGHLIGHT_JSON_RULES = `
VISUAL HIGHLIGHT — identify the tap target on screen:
- "target.name": short label (e.g. "Stocks app", "Phone icon")
- "target.location": where on screen (e.g. "bottom-left", "second row center")
- "target.box": bounding box with normalized coordinates 0.0–1.0 (top-left origin):
  { "x": left edge, "y": top edge, "width": width, "height": height }
- If nothing specific to tap, set "target": null
- When target is visible, mention the red circle in the step text (e.g. "Tap the Stocks app inside the red circle.")`;

const STEP_MODE_PROMPT = `${SCREEN_AWARE_RULES}
${HIGHLIGHT_JSON_RULES}

STEP-BY-STEP MODE — give ONLY ONE action at a time.

RULES:
- One step only, under 20 words when possible, one action per response.
- Base the step on what is VISIBLE in the screenshot right now.
- NEVER restart the task from the beginning. NEVER repeat steps the user already completed.
- Continue from current progress only — give the NEXT step after completed steps.
- Never list multiple steps or give the full plan.
- If the needed item is not on screen, say so clearly and set target to null.
- When the task is fully complete, respond exactly:
  {"step":"All done. You successfully completed that task.","isComplete":true,"target":null}

Respond with valid JSON only, no markdown:
{"step":"your single instruction here","isComplete":false,"target":{"name":"Stocks app","location":"center of screen","box":{"x":0.35,"y":0.42,"width":0.12,"height":0.12}}}`;

const STUCK_PROMPT = `${SCREEN_AWARE_RULES}
${HIGHLIGHT_JSON_RULES}

The user is STUCK on their CURRENT step. Do NOT advance to the next step.
Do NOT restart the task or repeat any completed steps.

Re-explain the SAME step only — in an easier, calmer way.
- Start with "No problem" or "Take your time."
- Describe WHERE on screen to look; include target box for the same element.
- Keep it short: 2–3 sentences.

Respond with valid JSON only:
{"step":"your clarification here","isComplete":false,"target":{...}}`;

const STILL_STUCK_PROMPT = `${SCREEN_AWARE_RULES}
${HIGHLIGHT_JSON_RULES}

The user is STILL STUCK on the SAME step after one clarification.
Do NOT restart the task or repeat any completed steps.

Break the SAME action into even smaller pieces with target box for the same element.
- Point to the exact area; stay encouraging.
- Gently mention asking a nearby family member if needed.
- Do NOT give a new step.

Respond with valid JSON only:
{"step":"your clarification here","isComplete":false,"target":{...}}`;

const TEXT_ONLY_STUCK_PROMPT = `You are a patient grandchild helping a grandparent use their phone.

The user is stuck on the CURRENT step. Do NOT advance to the next step.
Do NOT restart the task or repeat completed steps.

Re-explain the SAME step only, in easier plain English.
- Start with "No problem" or "Take your time."
- Keep it short: 2-3 sentences.
- If target details are provided, refer to the red circle and the target location.
- Do NOT invent new screen details.

Respond with valid JSON only:
{"step":"your clarification here","isComplete":false,"target":null}`;

const SCREEN_SUMMARY_PROMPT = `${SCREEN_AWARE_RULES}

AUTOMATIC SCREEN SUMMARY — context only, NO instructions.

Look at the screenshot carefully.

RULES:
- Give ONLY a brief, friendly summary of what is visible (under 25 words).
- Start with "I can see..."
- Name visible apps, buttons, icons, menus, or screen types you recognize.
- Do NOT give instructions. Do NOT tell them what to tap or do next.
- Do NOT ask questions. Only describe what you see.

Examples:
"I can see your home screen."
"I can see the Phone, Messages, Safari, and Camera apps."
"I can see your Settings screen."

Respond with plain text only — one short sentence.`;

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://greyflow-ai:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma4:e4b";
const OLLAMA_TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL ?? "gemma3:4b";
const MODEL_TEMPERATURE = 0.1;
const SUMMARY_MAX_TOKENS = 60;
const STEP_MAX_TOKENS = 512;

export type HighlightTarget = {
  name: string;
  location?: string;
  box: { x: number; y: number; width: number; height: number };
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseTarget(raw: unknown): HighlightTarget | null {
  if (!raw || typeof raw !== "object") return null;

  const target = raw as {
    name?: unknown;
    location?: unknown;
    box?: unknown;
  };

  if (typeof target.name !== "string" || !target.name.trim()) return null;

  if (!target.box || typeof target.box !== "object") return null;

  const box = target.box as {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
  };

  if (
    typeof box.x !== "number" ||
    typeof box.y !== "number" ||
    typeof box.width !== "number" ||
    typeof box.height !== "number"
  ) {
    return null;
  }

  if (box.width <= 0 || box.height <= 0) return null;

  return {
    name: target.name.trim(),
    location:
      typeof target.location === "string" ? target.location.trim() : undefined,
    box: {
      x: clamp01(box.x),
      y: clamp01(box.y),
      width: clamp01(box.width),
      height: clamp01(box.height),
    },
  };
}

function parseStepResponse(raw: string): {
  step: string;
  isComplete: boolean;
  target: HighlightTarget | null;
} {
  const trimmed = raw.trim();

  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        step?: unknown;
        isComplete?: unknown;
        target?: unknown;
      };
      if (typeof parsed.step === "string" && parsed.step.trim()) {
        return {
          step: parsed.step.trim(),
          isComplete: Boolean(parsed.isComplete),
          target: parseTarget(parsed.target),
        };
      }
    }
  } catch {
    // fall through to plain-text parsing
  }

  const isComplete = /all done|successfully completed|you'?re ready|task complete/i.test(
    trimmed
  );
  return { step: trimmed, isComplete, target: null };
}

function getCompletionText(
  completion: OpenAI.Chat.Completions.ChatCompletion
): string {
  const message = completion.choices[0]?.message as
    | (OpenAI.Chat.Completions.ChatCompletionMessage & {
        reasoning?: unknown;
      })
    | undefined;
  const content = message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (typeof message?.reasoning === "string" && message.reasoning.trim()) {
    return message.reasoning.trim();
  }
  return "";
}

function logModelTiming({
  mode,
  model,
  hasImage,
  startedAt,
  status,
}: {
  mode: string;
  model: string;
  hasImage: boolean;
  startedAt: number;
  status: "success" | "empty";
}) {
  console.info("Analyze model request", {
    mode,
    model,
    hasImage,
    status,
    durationMs: Date.now() - startedAt,
  });
}

function buildStepModeUserText(
  question: string,
  stepHistory: string[],
  clarificationHistory: string[]
): string {
  let text = `The user's goal: "${question}"\n\n`;
  text +=
    "SESSION MEMORY — continue this task from current progress. Do NOT restart from the beginning. Do NOT repeat completed steps.\n\n";
  text +=
    "Look at the screenshot. What is visible on screen right now?\n\n";

  if (stepHistory.length === 0) {
    text +=
      "The user has not completed any steps yet.\nGive the FIRST single action only — based on what you SEE on the screen. Under 20 words.";
  } else {
    text += "Steps already completed (do NOT repeat these):\n";
    stepHistory.forEach((step, index) => {
      text += `${index + 1}. ${step}\n`;
    });
    text += `\nGive step ${stepHistory.length + 1} only — the NEXT single action based on the current screenshot. Under 20 words. You may briefly encourage them.`;
  }

  if (clarificationHistory.length > 0) {
    text += "\n\nPrevious clarifications for the current step (context only — do not repeat verbatim):\n";
    clarificationHistory.forEach((clarification, index) => {
      text += `- ${clarification}\n`;
    });
  }

  return text;
}

function buildStuckUserText(
  question: string,
  currentStep: string,
  stepHistory: string[],
  clarificationHistory: string[],
  stillStuck: boolean,
  currentTarget: HighlightTarget | null,
  hasImage: boolean
): string {
  let text = `The user's goal: "${question}"\n\n`;
  text += `Current step they are stuck on (step ${stepHistory.length + 1}): "${currentStep}"\n\n`;
  text +=
    "SESSION MEMORY — do NOT restart the task. Do NOT repeat completed steps. Clarify ONLY the current step.\n\n";
  if (hasImage) {
    text += "Look at the screenshot carefully.\n\n";
  } else {
    text +=
      "No screenshot is attached for this clarification. Use only the current step, completed steps, and target details below.\n\n";
  }

  if (currentTarget) {
    text += `Existing red-circle target: ${currentTarget.name}`;
    if (currentTarget.location) {
      text += `, ${currentTarget.location}`;
    }
    text += ". Reuse this same target.\n\n";
  }

  if (stepHistory.length > 0) {
    text += "Steps already completed (do NOT repeat these):\n";
    stepHistory.forEach((step, index) => {
      text += `${index + 1}. ${step}\n`;
    });
    text += "\n";
  }

  if (clarificationHistory.length > 0) {
    text += "Clarifications already given for this step:\n";
    clarificationHistory.forEach((clarification, index) => {
      text += `${index + 1}. ${clarification}\n`;
    });
    text += "\n";
  }

  if (stillStuck) {
    text +=
      "They are STILL stuck. Explain this SAME step even more simply. Do not advance. Do not repeat earlier clarifications word-for-word.";
  } else {
    text +=
      "They are stuck. Re-explain this SAME step more clearly. Do not advance.";
  }

  return text;
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Invalid request body." },
        { status: 400 }
      );
    }

    const {
      question,
      image,
      stepHistory,
      clarificationHistory,
      isStepMode,
      currentStep,
      currentHighlight,
      stuckMode,
      isScreenSummary,
    } = body as {
      question?: unknown;
      image?: unknown;
      stepHistory?: unknown;
      clarificationHistory?: unknown;
      isStepMode?: unknown;
      currentStep?: unknown;
      currentHighlight?: unknown;
      stuckMode?: unknown;
      isScreenSummary?: unknown;
    };

    if (
      image !== undefined &&
      (typeof image !== "string" || !image.startsWith("data:image/"))
    ) {
      return NextResponse.json(
        { error: "Image must be a base64 data URL." },
        { status: 400 }
      );
    }

    const ollama = new OpenAI({
      baseURL: `${OLLAMA_BASE_URL.replace(/\/$/, "")}/v1`,
      apiKey: "ollama",
    });

    if (isScreenSummary === true) {
      if (typeof image !== "string") {
        return NextResponse.json(
          { error: "Screen summary requires a screenshot image." },
          { status: 400 }
        );
      }

      const summaryStartedAt = Date.now();
      const completion = await ollama.chat.completions.create({
        model: OLLAMA_MODEL,
        temperature: MODEL_TEMPERATURE,
        max_tokens: SUMMARY_MAX_TOKENS,
        messages: [
          { role: "system", content: SCREEN_SUMMARY_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Look at this screenshot. What do you see? Summary only, under 25 words.",
              },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      });

      const summary = getCompletionText(completion);
      logModelTiming({
        mode: "screen_summary",
        model: OLLAMA_MODEL,
        hasImage: true,
        startedAt: summaryStartedAt,
        status: summary ? "success" : "empty",
      });
      if (!summary) {
        console.error("Empty screen-summary completion", {
          model: OLLAMA_MODEL,
          finishReason: completion.choices[0]?.finish_reason,
          message: completion.choices[0]?.message,
        });
        return NextResponse.json(
          { error: "No summary was returned from the language model." },
          { status: 502 }
        );
      }

      return NextResponse.json({ answer: summary, isComplete: false });
    }

    if (!("question" in body)) {
      return NextResponse.json(
        { error: 'Request body must include a "question" field.' },
        { status: 400 }
      );
    }

    if (typeof question !== "string" || !question.trim()) {
      return NextResponse.json(
        { error: "A non-empty question is required." },
        { status: 400 }
      );
    }

    const scope = classifyUserQuestion(question);
    if (scope !== "technology") {
      return NextResponse.json(
        {
          error:
            scope === "emergency"
              ? "This assistant cannot help with emergencies."
              : "This assistant only helps with technology questions.",
          emergency: scope === "emergency",
          nonTechnology: scope === "non_technology",
        },
        { status: 403 }
      );
    }

    const inStepMode = isStepMode === true;
    const history = Array.isArray(stepHistory)
      ? stepHistory.filter((s): s is string => typeof s === "string")
      : [];
    const clarifications = Array.isArray(clarificationHistory)
      ? clarificationHistory.filter((s): s is string => typeof s === "string")
      : [];
    const isStuck = stuckMode === "stuck" || stuckMode === "still_stuck";
    const isStillStuck = stuckMode === "still_stuck";
    const existingTarget = parseTarget(currentHighlight);
    const hasImage = typeof image === "string";

    if (inStepMode && !isStuck && !hasImage) {
      return NextResponse.json(
        { error: "Step mode requires a screenshot image." },
        { status: 400 }
      );
    }

    if (
      isStuck &&
      (typeof currentStep !== "string" || !currentStep.trim())
    ) {
      return NextResponse.json(
        { error: 'Stuck mode requires a "currentStep" field.' },
        { status: 400 }
      );
    }

    let systemPrompt = SCREEN_AWARE_RULES;
    let userText = question.trim();

    if (inStepMode && isStuck) {
      systemPrompt = hasImage
        ? isStillStuck
          ? STILL_STUCK_PROMPT
          : STUCK_PROMPT
        : TEXT_ONLY_STUCK_PROMPT;
      userText = buildStuckUserText(
        question.trim(),
        currentStep as string,
        history,
        clarifications,
        isStillStuck,
        existingTarget,
        hasImage
      );
    } else if (inStepMode) {
      systemPrompt = STEP_MODE_PROMPT;
      userText = buildStepModeUserText(
        question.trim(),
        history,
        clarifications
      );
    }

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: userText },
    ];

    if (typeof image === "string") {
      userContent.push({
        type: "image_url",
        image_url: { url: image },
      });
    }

    const selectedModel = isStuck && !hasImage ? OLLAMA_TEXT_MODEL : OLLAMA_MODEL;
    const analyzeMode = inStepMode
      ? isStuck
        ? isStillStuck
          ? "still_stuck"
          : "stuck"
        : "step"
      : "general";
    const analyzeStartedAt = Date.now();
    const completion = await ollama.chat.completions.create({
      model: selectedModel,
      temperature: MODEL_TEMPERATURE,
      max_tokens: STEP_MAX_TOKENS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    const rawAnswer = getCompletionText(completion);
    logModelTiming({
      mode: analyzeMode,
      model: selectedModel,
      hasImage,
      startedAt: analyzeStartedAt,
      status: rawAnswer ? "success" : "empty",
    });
    if (!rawAnswer) {
      console.error("Empty analyze completion", {
        model: selectedModel,
        finishReason: completion.choices[0]?.finish_reason,
        message: completion.choices[0]?.message,
      });
      return NextResponse.json(
        { error: "No answer was returned from the language model." },
        { status: 502 }
      );
    }

    if (inStepMode) {
      const { step, isComplete, target } = parseStepResponse(rawAnswer);
      const answer = isComplete
        ? "All done. You successfully completed that task."
        : step;
      const highlight = isStuck && !target ? existingTarget : target;
      return NextResponse.json({
        answer,
        isComplete,
        isClarification: isStuck,
        highlight,
      });
    }

    return NextResponse.json({ answer: rawAnswer, isComplete: false });
  } catch (error) {
    console.error(error);

    if (error instanceof OpenAI.APIError) {
      return NextResponse.json(
        { error: error.message || "Language model request failed." },
        { status: error.status ?? 502 }
      );
    }

    return NextResponse.json(
      { error: "An unexpected error occurred while analyzing your question." },
      { status: 500 }
    );
  }
}
