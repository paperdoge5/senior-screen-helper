"use client";

import { useEffect, useId, useRef, useState } from "react";
import { classifyUserQuestion } from "@/lib/question-scope";

const EXAMPLE_QUESTIONS = [
  "What am I looking at?",
  "How do I call someone?",
  "How do I send a text?",
  "How do I open Safari?",
  "Does my phone need updates?",
] as const;

type ConversationState =
  | "idle"
  | "guiding"
  | "stuck"
  | "still_stuck"
  | "complete";

type MicStatus = "idle" | "listening" | "captured" | "error";

type BrowserSpeechRecognitionEvent = {
  results: {
    [index: number]: {
      [index: number]: {
        transcript?: string;
      };
    };
  };
};

type BrowserSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  start: () => void;
  abort: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type HighlightTarget = {
  name: string;
  location?: string;
  box: { x: number; y: number; width: number; height: number };
};

type StepApiResponse = {
  answer?: string;
  isComplete?: boolean;
  highlight?: HighlightTarget | null;
};

const ENABLE_AUTO_SCREEN_SUMMARY = false;
const MODEL_IMAGE_MAX_DIMENSION = 768;
const MODEL_IMAGE_TYPE = "image/jpeg";
const MODEL_IMAGE_QUALITY = 0.82;

function getObjectContainRect(
  containerW: number,
  containerH: number,
  imgW: number,
  imgH: number
) {
  const scale = Math.min(containerW / imgW, containerH / imgH);
  const displayW = imgW * scale;
  const displayH = imgH * scale;
  return {
    offsetX: (containerW - displayW) / 2,
    offsetY: (containerH - displayH) / 2,
    displayW,
    displayH,
  };
}

const CIRCLE_PADDING_PX = 15;
const ARROW_LENGTH_PX = 28;
const ARROW_TIP_GAP_PX = 6;

type CircleOverlay = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  arrowFrom: { x: number; y: number };
  arrowTo: { x: number; y: number };
  showArrow: boolean;
};

function formatHighlightCaption(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Tap here.";
  if (/^tap\b/i.test(trimmed)) {
    return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
  }
  return `Tap the ${trimmed}.`;
}

function computeCircleOverlay(
  containerW: number,
  containerH: number,
  imgW: number,
  imgH: number,
  highlight: HighlightTarget
): CircleOverlay {
  const imageRect = getObjectContainRect(containerW, containerH, imgW, imgH);
  const { box } = highlight;

  const targetLeft = imageRect.offsetX + box.x * imageRect.displayW;
  const targetTop = imageRect.offsetY + box.y * imageRect.displayH;
  const targetW = box.width * imageRect.displayW;
  const targetH = box.height * imageRect.displayH;

  const cx = targetLeft + targetW / 2;
  const cy = targetTop + targetH / 2;
  const rx = Math.max(targetW, targetH) / 2 + CIRCLE_PADDING_PX;
  const ry = Math.max(targetW, targetH) / 2 + CIRCLE_PADDING_PX;

  const circleTop = cy - ry;
  const circleBottom = cy + ry;
  const circleLeft = cx - rx;
  const circleRight = cx + rx;

  const imageTop = imageRect.offsetY;
  const imageBottom = imageRect.offsetY + imageRect.displayH;
  const imageLeft = imageRect.offsetX;
  const imageRight = imageRect.offsetX + imageRect.displayW;

  const spaces = {
    above: circleTop - imageTop,
    below: imageBottom - circleBottom,
    left: circleLeft - imageLeft,
    right: imageRight - circleRight,
  };

  const bestDirection = (
    Object.entries(spaces) as [keyof typeof spaces, number][]
  ).sort((a, b) => b[1] - a[1])[0]?.[0];

  let arrowFrom = { x: cx, y: circleTop - ARROW_LENGTH_PX };
  let arrowTo = { x: cx, y: circleTop - ARROW_TIP_GAP_PX };
  let showArrow = spaces.above >= ARROW_LENGTH_PX + ARROW_TIP_GAP_PX;

  switch (bestDirection) {
    case "below":
      arrowFrom = { x: cx, y: circleBottom + ARROW_LENGTH_PX };
      arrowTo = { x: cx, y: circleBottom + ARROW_TIP_GAP_PX };
      showArrow = spaces.below >= ARROW_LENGTH_PX + ARROW_TIP_GAP_PX;
      break;
    case "left":
      arrowFrom = { x: circleLeft - ARROW_LENGTH_PX, y: cy };
      arrowTo = { x: circleLeft - ARROW_TIP_GAP_PX, y: cy };
      showArrow = spaces.left >= ARROW_LENGTH_PX + ARROW_TIP_GAP_PX;
      break;
    case "right":
      arrowFrom = { x: circleRight + ARROW_LENGTH_PX, y: cy };
      arrowTo = { x: circleRight + ARROW_TIP_GAP_PX, y: cy };
      showArrow = spaces.right >= ARROW_LENGTH_PX + ARROW_TIP_GAP_PX;
      break;
    case "above":
    default:
      arrowFrom = {
        x: cx,
        y: Math.max(imageTop + 4, circleTop - ARROW_LENGTH_PX),
      };
      arrowTo = { x: cx, y: circleTop - ARROW_TIP_GAP_PX };
      showArrow = spaces.above >= ARROW_TIP_GAP_PX + 8;
      break;
  }

  return { cx, cy, rx, ry, arrowFrom, arrowTo, showArrow };
}

function ScreenshotWithHighlight({
  src,
  alt,
  highlight,
}: {
  src: string;
  alt: string;
  highlight: HighlightTarget | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const markerId = useId().replace(/:/g, "");
  const [imageVersion, setImageVersion] = useState(0);
  const [overlay, setOverlay] = useState<CircleOverlay | null>(null);

  useEffect(() => {
    function updateOverlay() {
      const container = containerRef.current;
      const img = imageRef.current;
      if (!container || !img || !highlight || !img.naturalWidth) {
        setOverlay(null);
        return;
      }

      const { width: cw, height: ch } = container.getBoundingClientRect();
      setOverlay(
        computeCircleOverlay(
          cw,
          ch,
          img.naturalWidth,
          img.naturalHeight,
          highlight
        )
      );
    }

    updateOverlay();
    window.addEventListener("resize", updateOverlay);
    return () => window.removeEventListener("resize", updateOverlay);
  }, [highlight, src, imageVersion]);

  return (
    <div
      aria-label={
        highlight ? `Screenshot with ${highlight.name} highlighted` : undefined
      }
    >
      {highlight && (
        <p
          className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-center text-2xl font-bold leading-snug text-red-800 sm:text-3xl"
          role="note"
        >
          {formatHighlightCaption(highlight.name)}
        </p>
      )}
      <div ref={containerRef} className="relative mx-auto max-h-[480px] w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          onLoad={() => setImageVersion((v) => v + 1)}
          className="mx-auto max-h-[480px] w-full object-contain"
        />
        {highlight && overlay && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden
          >
            <defs>
              <marker
                id={`highlight-arrowhead-${markerId}`}
                markerWidth="8"
                markerHeight="8"
                refX="4"
                refY="4"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="#dc2626" />
              </marker>
            </defs>
            <ellipse
              cx={overlay.cx}
              cy={overlay.cy}
              rx={overlay.rx}
              ry={overlay.ry}
              fill="none"
              stroke="#dc2626"
              strokeWidth="3"
            />
            {overlay.showArrow && (
              <line
                x1={overlay.arrowFrom.x}
                y1={overlay.arrowFrom.y}
                x2={overlay.arrowTo.x}
                y2={overlay.arrowTo.y}
                stroke="#dc2626"
                strokeWidth="2"
                markerEnd={`url(#highlight-arrowhead-${markerId})`}
              />
            )}
          </svg>
        )}
      </div>
    </div>
  );
}

const SPEECH_RATE = 0.78;
const SPEECH_VOLUME = 1;
const SPEECH_PITCH = 1.0;
const SENTENCE_END_PAUSE_MS = 300;
const STEP_END_PAUSE_MS = 500;

const FEMALE_VOICE_PATTERNS: RegExp[] = [
  /samantha/i,
  /jenny/i,
  /aria/i,
  /zira/i,
  /karen/i,
  /victoria/i,
  /susan/i,
  /moira/i,
  /flo/i,
  /female/i,
  /woman/i,
];

type SpeechChunk = { text: string; pauseAfter: number };

function getEnglishVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"));
}

function matchesVoiceName(voice: SpeechSynthesisVoice, pattern: RegExp): boolean {
  return pattern.test(voice.name);
}

/** Picks the most natural English voice available in the browser. */
function pickBestNaturalVoice(
  voices: SpeechSynthesisVoice[]
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;

  const englishVoices = getEnglishVoices(voices);
  const candidates = englishVoices.length > 0 ? englishVoices : voices;

  const priorityChecks: Array<(voice: SpeechSynthesisVoice) => boolean> = [
    (voice) =>
      matchesVoiceName(voice, /microsoft aria/i) &&
      matchesVoiceName(voice, /natural/i),
    (voice) =>
      matchesVoiceName(voice, /microsoft jenny/i) &&
      matchesVoiceName(voice, /natural/i),
    (voice) => matchesVoiceName(voice, /google us english/i),
    (voice) => matchesVoiceName(voice, /^samantha$/i),
    (voice) => matchesVoiceName(voice, /samantha/i),
    (voice) => matchesVoiceName(voice, /natural/i),
    (voice) => FEMALE_VOICE_PATTERNS.some((pattern) => pattern.test(voice.name)),
  ];

  for (const check of priorityChecks) {
    const match = candidates.find(check);
    if (match) return match;
  }

  const localEnUs = candidates.find(
    (voice) =>
      voice.localService &&
      (voice.lang === "en-US" || voice.lang.startsWith("en-US"))
  );
  if (localEnUs) return localEnUs;

  const localEnglish = candidates.find((voice) => voice.localService);
  if (localEnglish) return localEnglish;

  const enUs = candidates.find(
    (voice) => voice.lang === "en-US" || voice.lang.startsWith("en-US")
  );
  if (enUs) return enUs;

  return candidates[0] ?? null;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitIntoStepBlocks(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const lines = normalized.split(/\n+/);
  const blocks: string[] = [];
  let current = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isNumberedStep = /^(?:\d+[.)]\s+|step\s+\d+[:.)]?\s+)/i.test(trimmed);
    if (isNumberedStep && current) {
      blocks.push(current.trim());
      current = trimmed;
    } else {
      current += (current ? " " : "") + trimmed;
    }
  }

  if (current) blocks.push(current.trim());

  const hasNumberedSteps = blocks.some((block) =>
    /^(?:\d+[.)]|step\s+\d+)/i.test(block)
  );

  return hasNumberedSteps && blocks.length > 1 ? blocks : [normalized];
}

function parseSpeechChunks(text: string): SpeechChunk[] {
  const stepBlocks = splitIntoStepBlocks(text);
  const chunks: SpeechChunk[] = [];

  stepBlocks.forEach((block, blockIndex) => {
    const sentences = splitIntoSentences(block);

    sentences.forEach((sentence, sentenceIndex) => {
      const isLastSentenceInBlock = sentenceIndex === sentences.length - 1;
      const isLastBlock = blockIndex === stepBlocks.length - 1;

      let pauseAfter = SENTENCE_END_PAUSE_MS;
      if (isLastSentenceInBlock && !isLastBlock) {
        pauseAfter = STEP_END_PAUSE_MS;
      } else if (isLastSentenceInBlock && isLastBlock) {
        pauseAfter = 0;
      }

      chunks.push({ text: sentence, pauseAfter });
    });
  });

  return chunks.length > 0 ? chunks : [{ text: text.trim(), pauseAfter: 0 }];
}

const SCREENSHOT_GUIDE_HIDDEN_KEY = "senior-screen-helper-screenshot-guide-hidden";
const WELCOME_ACK_KEY = "senior-screen-helper-welcome-acknowledged";

const NON_TECHNOLOGY_MESSAGE =
  "This assistant only helps with technology questions. Please contact staff, family, a caregiver, or an appropriate professional for assistance.";

const IPHONE_GUIDE_STEPS = [
  "Press Side Button + Volume Up",
  "Screenshot saves automatically",
  "Tap Upload Screenshot below",
] as const;

const ANDROID_GUIDE_STEPS = [
  "Press Power + Volume Down",
  "Screenshot saves automatically",
  "Tap Upload Screenshot below",
] as const;

function GuideStepList({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="mt-10 space-y-8">
      {steps.map((text, index) => (
        <li key={text} className="flex gap-5">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-blue-600 text-3xl font-bold text-white sm:h-16 sm:w-16"
            aria-hidden
          >
            {index + 1}
          </span>
          <p className="pt-2 text-[20px] font-medium leading-snug text-slate-900 sm:text-[22px]">
            {text}
          </p>
        </li>
      ))}
    </ol>
  );
}

function IPhoneScreenshotDiagram() {
  return (
    <div
      className="flex flex-col items-center gap-8 py-8 sm:flex-row sm:justify-center sm:gap-10"
      role="img"
      aria-label="iPhone with Volume Up on the left and Side Button on the right highlighted"
    >
      <p className="max-w-[140px] text-center text-[22px] font-bold leading-tight text-green-600 sm:text-right sm:text-[24px]">
        ← Volume Up
      </p>

      <svg
        viewBox="0 0 120 260"
        className="h-auto w-[140px] shrink-0 sm:w-[160px]"
        aria-hidden
      >
        <rect
          x="8"
          y="8"
          width="104"
          height="244"
          rx="16"
          fill="#e2e8f0"
          stroke="#64748b"
          strokeWidth="3"
        />
        <rect x="20" y="28" width="80" height="190" rx="4" fill="#f8fafc" />
        <rect
          className="screenshot-guide-flash"
          x="20"
          y="28"
          width="80"
          height="190"
          rx="4"
          fill="#ffffff"
        />
        <rect
          className="screenshot-guide-btn-a"
          x="0"
          y="72"
          width="14"
          height="44"
          rx="4"
          fill="#16a34a"
        />
        <rect
          className="screenshot-guide-btn-b"
          x="106"
          y="88"
          width="14"
          height="52"
          rx="4"
          fill="#2563eb"
        />
      </svg>

      <p className="max-w-[140px] text-center text-[22px] font-bold leading-tight text-blue-600 sm:text-left sm:text-[24px]">
        Side Button →
      </p>
    </div>
  );
}

function AndroidScreenshotDiagram() {
  return (
    <div
      className="flex items-center justify-center gap-8 py-8 sm:gap-10"
      role="img"
      aria-label="Android phone with Power Button and Volume Down highlighted on the right side"
    >
      <svg
        viewBox="0 0 120 260"
        className="h-auto w-[140px] shrink-0 sm:w-[160px]"
        aria-hidden
      >
        <rect
          x="8"
          y="8"
          width="104"
          height="244"
          rx="12"
          fill="#e2e8f0"
          stroke="#64748b"
          strokeWidth="3"
        />
        <rect x="20" y="28" width="80" height="190" rx="3" fill="#f8fafc" />
        <rect
          className="screenshot-guide-flash"
          x="20"
          y="28"
          width="80"
          height="190"
          rx="3"
          fill="#ffffff"
        />
        <rect
          className="screenshot-guide-btn-a"
          x="106"
          y="68"
          width="14"
          height="44"
          rx="4"
          fill="#16a34a"
        />
        <rect
          className="screenshot-guide-btn-b"
          x="106"
          y="122"
          width="14"
          height="44"
          rx="4"
          fill="#2563eb"
        />
      </svg>

      <div className="flex flex-col gap-10">
        <p className="text-[22px] font-bold leading-tight text-green-600 sm:text-[24px]">
          Power Button →
        </p>
        <p className="text-[22px] font-bold leading-tight text-blue-600 sm:text-[24px]">
          Volume Down →
        </p>
      </div>
    </div>
  );
}

const STEPS = [
  {
    number: "1",
    title: "Upload a screenshot",
    description: "Take a picture of your screen and upload it here.",
  },
  {
    number: "2",
    title: "Ask a question",
    description: "Type or speak what you want help with.",
  },
  {
    number: "3",
    title: "Get spoken instructions",
    description: "Follow one calm step at a time — guided by your screenshot.",
  },
] as const;

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState("");
  const [screenshotName, setScreenshotName] = useState<string | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(
    null
  );
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [optimizedScreenshotDataUrl, setOptimizedScreenshotDataUrl] = useState<
    string | null
  >(null);
  const [isListening, setIsListening] = useState(false);
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const [helpResponse, setHelpResponse] = useState<string | null>(null);
  const [isHelpLoading, setIsHelpLoading] = useState(false);
  const [originalQuestion, setOriginalQuestion] = useState<string | null>(null);
  const [originalScreenshot, setOriginalScreenshot] = useState<string | null>(
    null
  );
  const [stepHistory, setStepHistory] = useState<string[]>([]);
  const [clarificationHistory, setClarificationHistory] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [isStepMode, setIsStepMode] = useState(false);
  const [isStepComplete, setIsStepComplete] = useState(false);
  const [conversationState, setConversationState] =
    useState<ConversationState>("idle");
  const [highlightTarget, setHighlightTarget] = useState<HighlightTarget | null>(
    null
  );
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>(
    []
  );
  const [selectedVoiceName, setSelectedVoiceName] = useState<string>(
    "Loading voice..."
  );
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [showScreenshotGuide, setShowScreenshotGuide] = useState(true);
  const [emergencyAlertActive, setEmergencyAlertActive] = useState(false);
  const [nonTechnologyAlertActive, setNonTechnologyAlertActive] = useState(false);
  const [showStaffContactInfo, setShowStaffContactInfo] = useState(false);
  const [showWelcomeCard, setShowWelcomeCard] = useState(false);
  const [showHumanHelp, setShowHumanHelp] = useState(false);
  const [summaryCopied, setSummaryCopied] = useState(false);
  const emergencyCardRef = useRef<HTMLDivElement>(null);
  const nonTechCardRef = useRef<HTMLDivElement>(null);
  const [screenSummary, setScreenSummary] = useState<string | null>(null);
  const [isLoadingScreenSummary, setIsLoadingScreenSummary] = useState(false);
  const summaryRequestRef = useRef(0);
  const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const speechSessionRef = useRef(0);
  const speechChunksRef = useRef<SpeechChunk[]>([]);
  const speechIndexRef = useRef(0);
  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearSpeechPauseTimeout() {
    if (pauseTimeoutRef.current) {
      clearTimeout(pauseTimeoutRef.current);
      pauseTimeoutRef.current = null;
    }
  }

  function stopSpeech() {
    speechSessionRef.current += 1;
    clearSpeechPauseTimeout();

    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  function speakSingleStep(text: string) {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    stopSpeech();

    const session = speechSessionRef.current;
    speechChunksRef.current = parseSpeechChunks(text);
    speechIndexRef.current = 0;

    const speakNextChunk = () => {
      if (session !== speechSessionRef.current) return;

      if (speechIndexRef.current >= speechChunksRef.current.length) {
        return;
      }

      const { text: chunkText, pauseAfter } =
        speechChunksRef.current[speechIndexRef.current];
      const utterance = new SpeechSynthesisUtterance(chunkText);
      utterance.rate = SPEECH_RATE;
      utterance.volume = SPEECH_VOLUME;
      utterance.pitch = SPEECH_PITCH;
      utterance.lang = "en-US";

      if (selectedVoiceRef.current) {
        utterance.voice = selectedVoiceRef.current;
      }

      utterance.onend = () => {
        if (session !== speechSessionRef.current) return;

        speechIndexRef.current += 1;

        if (speechIndexRef.current >= speechChunksRef.current.length) {
          return;
        }

        if (pauseAfter > 0) {
          pauseTimeoutRef.current = setTimeout(speakNextChunk, pauseAfter);
        } else {
          speakNextChunk();
        }
      };

      utterance.onerror = () => {
        if (session !== speechSessionRef.current) return;
      };

      window.speechSynthesis.speak(utterance);
    };

    speakNextChunk();
  }

  function loadSpeechVoices() {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const voices = window.speechSynthesis.getVoices();
    setAvailableVoices(voices);

    const bestVoice = pickBestNaturalVoice(voices);
    selectedVoiceRef.current = bestVoice;
    setSelectedVoiceName(bestVoice?.name ?? "Default browser voice");
  }

  function resetStepMode() {
    setOriginalQuestion(null);
    setOriginalScreenshot(null);
    setStepHistory([]);
    setClarificationHistory([]);
    setCurrentStep(null);
    setIsStepMode(false);
    setIsStepComplete(false);
    setConversationState("idle");
    setHighlightTarget(null);
  }

  function resetForNewQuestion() {
    stopSpeech();
    setStepHistory([]);
    setClarificationHistory([]);
    setCurrentStep(null);
    setIsStepMode(false);
    setIsStepComplete(false);
    setConversationState("idle");
    setHelpResponse(null);
    setOriginalQuestion(null);
    setOriginalScreenshot(null);
    setHighlightTarget(null);
  }

  function applyStepApiResponse(
    data: StepApiResponse,
    mode: "guiding" | "stuck" | "still_stuck"
  ) {
    if (typeof data.answer !== "string" || !data.answer.trim()) {
      setHelpResponse("Sorry, something went wrong.");
      setIsStepMode(false);
      setHighlightTarget(null);
      return false;
    }

    const answer = data.answer;
    const complete = Boolean(data.isComplete);
    if (mode === "guiding") {
      setCurrentStep(complete ? null : answer);
    } else if (mode === "stuck" || mode === "still_stuck") {
      setClarificationHistory((prev) => [...prev, answer]);
    }
    setHelpResponse(answer);
    setIsStepComplete(complete);
    setConversationState(complete ? "complete" : mode);
    setHighlightTarget((previous) => {
      if (complete) return null;
      if (data.highlight) return data.highlight;
      return mode === "guiding" ? null : previous;
    });
    speakSingleStep(answer);
    return true;
  }

  async function fileToDataUrl(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function fileToOptimizedDataUrl(file: File): Promise<string> {
    if (typeof window === "undefined") {
      return fileToDataUrl(file);
    }

    const originalDataUrl = await fileToDataUrl(file);
    const image = new Image();
    image.decoding = "async";

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = reject;
      image.src = originalDataUrl;
    });

    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;

    if (!sourceWidth || !sourceHeight) {
      return originalDataUrl;
    }

    const scale = Math.min(
      1,
      MODEL_IMAGE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight)
    );
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      return originalDataUrl;
    }

    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const optimizedDataUrl = await new Promise<string>((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(originalDataUrl);
            return;
          }

          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve(originalDataUrl);
          reader.readAsDataURL(blob);
        },
        MODEL_IMAGE_TYPE,
        MODEL_IMAGE_QUALITY
      );
    });

    console.info("Screenshot optimized for model", {
      originalBytes: file.size,
      optimizedBytes: Math.round((optimizedDataUrl.length * 3) / 4),
      sourceSize: `${sourceWidth}x${sourceHeight}`,
      modelSize: `${targetWidth}x${targetHeight}`,
    });

    return optimizedDataUrl;
  }

  async function fetchScreenSummary(file: File) {
    const requestId = ++summaryRequestRef.current;
    setIsLoadingScreenSummary(true);
    setScreenSummary(null);

    try {
      const imageDataUrl = await fileToDataUrl(file);
      if (requestId !== summaryRequestRef.current) return;

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageDataUrl, isScreenSummary: true }),
      });

      if (requestId !== summaryRequestRef.current) return;

      if (!response.ok) return;

      const data = (await response.json()) as { answer?: string };
      if (
        requestId === summaryRequestRef.current &&
        typeof data.answer === "string" &&
        data.answer.trim()
      ) {
        setScreenSummary(data.answer.trim());
      }
    } catch {
      // Summary is optional context; fail silently.
    } finally {
      if (requestId === summaryRequestRef.current) {
        setIsLoadingScreenSummary(false);
      }
    }
  }

  function showEmergencyAlert() {
    stopSpeech();
    setIsHelpLoading(false);
    setEmergencyAlertActive(true);
    setNonTechnologyAlertActive(false);
    setHelpResponse(null);
    setIsStepMode(false);
    setIsStepComplete(false);
    setHighlightTarget(null);
    setShowHumanHelp(false);
    resetStepMode();
    requestAnimationFrame(() => {
      emergencyCardRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }

  function showNonTechnologyAlert() {
    stopSpeech();
    setIsHelpLoading(false);
    setNonTechnologyAlertActive(true);
    setEmergencyAlertActive(false);
    setHelpResponse(null);
    setIsStepMode(false);
    setIsStepComplete(false);
    setHighlightTarget(null);
    setShowHumanHelp(false);
    resetStepMode();
    requestAnimationFrame(() => {
      nonTechCardRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }

  function clearOutOfScopeAlerts() {
    setEmergencyAlertActive(false);
    setNonTechnologyAlertActive(false);
  }

  function blockIfOutOfScope(text: string): boolean {
    const scope = classifyUserQuestion(text);
    if (scope === "emergency") {
      showEmergencyAlert();
      return true;
    }
    if (scope === "non_technology") {
      showNonTechnologyAlert();
      return true;
    }
    clearOutOfScopeAlerts();
    return false;
  }

  function resetToHomeState() {
    stopSpeech();
    summaryRequestRef.current += 1;
    setQuestion("");
    setHelpResponse(null);
    setScreenSummary(null);
    setIsLoadingScreenSummary(false);
    clearOutOfScopeAlerts();
    setShowStaffContactInfo(false);
    setShowHumanHelp(false);
    setSummaryCopied(false);
    resetForNewQuestion();
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (screenshotPreview) {
      URL.revokeObjectURL(screenshotPreview);
    }
    setScreenshotName(null);
    setScreenshotPreview(null);
    setScreenshotFile(null);
    setOptimizedScreenshotDataUrl(null);
  }

  function handleStartOver() {
    const hasActivity =
      Boolean(screenshotPreview) ||
      Boolean(question.trim()) ||
      isStepMode ||
      Boolean(helpResponse);

    if (!hasActivity) return;

    if (window.confirm("Are you sure you want to start over?")) {
      resetToHomeState();
    }
  }

  function buildHumanHelpSummary(): string {
    const parts: string[] = [];
    const goal = originalQuestion || question.trim();

    if (goal) {
      parts.push(`User is trying to ${goal.replace(/^help me /i, "").replace(/\.$/, "")}.`);
    }

    if (stepHistory.length > 0) {
      if (stepHistory.length === 1) {
        parts.push(`Completed step: ${stepHistory[0]}`);
      } else {
        parts.push(
          `Completed ${stepHistory.length} steps, including: ${stepHistory[stepHistory.length - 1]}`
        );
      }
    }

    if (currentStep && conversationState !== "complete") {
      parts.push(`The user is currently trying to: ${currentStep}`);
    }

    if (conversationState === "stuck" || conversationState === "still_stuck") {
      parts.push("The user is stuck and may need hands-on help with this step.");
    } else if (conversationState === "complete") {
      parts.push("The user completed the technology task.");
    }

    if (clarificationHistory.length > 0) {
      parts.push(
        "Extra guidance was already given, but the user may still need help."
      );
    }

    return (
      parts.join("\n\n") ||
      "The user is using the phone helper and may need assistance getting started."
    );
  }

  function handleShowHumanHelp() {
    setShowHumanHelp(true);
    setSummaryCopied(false);
    requestAnimationFrame(() => {
      document
        .getElementById("human-help-summary")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  async function handleCopyHumanHelpSummary() {
    const summary = buildHumanHelpSummary();
    try {
      await navigator.clipboard.writeText(summary);
      setSummaryCopied(true);
    } catch {
      setSummaryCopied(false);
    }
  }

  function handleWelcomeAcknowledge() {
    setShowWelcomeCard(false);
    try {
      localStorage.setItem(WELCOME_ACK_KEY, "true");
    } catch {
      // Welcome card stays dismissed for this visit.
    }
  }

  async function parseAnalyzeResponse(
    response: Response
  ): Promise<
    | { status: "ok"; data: StepApiResponse }
    | { status: "emergency" }
    | { status: "non_technology" }
    | { status: "error" }
  > {
    if (response.status === 403) {
      try {
        const data = (await response.json()) as {
          emergency?: boolean;
          nonTechnology?: boolean;
        };
        if (data.emergency) {
          showEmergencyAlert();
          return { status: "emergency" };
        }
        if (data.nonTechnology) {
          showNonTechnologyAlert();
          return { status: "non_technology" };
        }
      } catch {
        // Fall through to generic error handling.
      }
      return { status: "error" };
    }
    if (!response.ok) return { status: "error" };
    return {
      status: "ok",
      data: (await response.json()) as StepApiResponse,
    };
  }

  async function fetchStep(history: string[], clarifications = clarificationHistory) {
    if (!originalQuestion || !originalScreenshot) return;
    if (blockIfOutOfScope(originalQuestion)) return;

    setIsHelpLoading(true);
    stopSpeech();
    setHelpResponse("Thinking...");
    setHighlightTarget(null);
    setConversationState("guiding");

    try {
      const startedAt = performance.now();
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: originalQuestion,
          image: originalScreenshot,
          stepHistory: history,
          clarificationHistory: clarifications,
          isStepMode: true,
        }),
      });
      console.info(
        "Analyze step request took",
        `${Math.round(performance.now() - startedAt)}ms`
      );

      const result = await parseAnalyzeResponse(response);
      if (result.status === "emergency" || result.status === "non_technology") {
        return;
      }
      if (result.status === "error") {
        setHelpResponse("Sorry, something went wrong.");
        setIsStepMode(false);
        setHighlightTarget(null);
        return;
      }
      if (!applyStepApiResponse(result.data, "guiding")) {
        setIsStepMode(false);
      }
    } catch {
      setHelpResponse("Sorry, something went wrong.");
      setIsStepMode(false);
      setHighlightTarget(null);
    } finally {
      setIsHelpLoading(false);
    }
  }

  async function fetchStuckHelp(mode: "stuck" | "still_stuck") {
    if (!originalQuestion || !originalScreenshot || !currentStep) return;
    if (blockIfOutOfScope(originalQuestion)) return;

    setIsHelpLoading(true);
    stopSpeech();
    setHelpResponse("Thinking...");
    setHighlightTarget(null);

    try {
      const startedAt = performance.now();
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: originalQuestion,
          stepHistory,
          clarificationHistory,
          currentStep,
          currentHighlight: highlightTarget,
          isStepMode: true,
          stuckMode: mode,
        }),
      });
      console.info(
        "Analyze stuck request took",
        `${Math.round(performance.now() - startedAt)}ms`
      );

      const result = await parseAnalyzeResponse(response);
      if (result.status === "emergency" || result.status === "non_technology") {
        return;
      }
      if (result.status === "error") {
        setHelpResponse("Sorry, something went wrong.");
        return;
      }
      applyStepApiResponse(
        result.data,
        mode === "stuck" ? "stuck" : "still_stuck"
      );
    } catch {
      setHelpResponse("Sorry, something went wrong.");
      setHighlightTarget(null);
    } finally {
      setIsHelpLoading(false);
    }
  }

  function handleIDidIt() {
    if (!currentStep || isStepComplete || isHelpLoading) return;
    setConversationState("guiding");
    const newHistory = [...stepHistory, currentStep];
    setStepHistory(newHistory);
    setClarificationHistory([]);
    void fetchStep(newHistory, []);
  }

  function handleImStuck() {
    if (!currentStep || isStepComplete || isHelpLoading) return;
    void fetchStuckHelp("stuck");
  }

  function handleStillStuck() {
    if (!currentStep || isHelpLoading || conversationState !== "stuck") return;
    void fetchStuckHelp("still_stuck");
  }

  function handleRepeatStep() {
    const textToRead = helpResponse ?? currentStep;
    if (textToRead && textToRead !== "Thinking...") {
      speakSingleStep(textToRead);
    }
  }

  function handleStopVoice() {
    stopSpeech();
  }

  function handleRestartTask() {
    if (!originalQuestion || !originalScreenshot || isHelpLoading) return;

    stopSpeech();
    setStepHistory([]);
    setClarificationHistory([]);
    setCurrentStep(null);
    setIsStepComplete(false);
    setIsStepMode(true);
    setConversationState("guiding");
    setHelpResponse("Thinking...");
    setHighlightTarget(null);
    void fetchStep([], []);
  }

  function handleStartNewTask() {
    resetToHomeState();
  }

  function handleAskAnotherQuestion() {
    stopSpeech();
    setQuestion("");
    setHelpResponse(null);
    resetForNewQuestion();
  }

  function handleGetMoreHelp() {
    stopSpeech();
    setHelpResponse(null);
    resetForNewQuestion();
    document.getElementById("question")?.focus();
  }

  function renderScreenSummaryBox() {
    if (!screenshotPreview) return null;
    if (!isLoadingScreenSummary && !screenSummary) return null;

    const showHelpPrompt =
      !question.trim() && !isStepMode && !helpResponse && !isHelpLoading;

    return (
      <div
        className="mt-6 rounded-2xl border-2 border-blue-200 bg-white p-5 sm:p-6"
        role="status"
        aria-live="polite"
      >
        {isLoadingScreenSummary ? (
          <p className="text-lg text-blue-800 sm:text-xl">
            Looking at your screen...
          </p>
        ) : (
          <>
            <p className="text-lg font-medium text-slate-800 sm:text-xl">
              {screenSummary}
            </p>
            {showHelpPrompt && (
              <p className="mt-3 text-lg font-semibold text-blue-800 sm:text-xl">
                What would you like help doing?
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  function renderHelpResponseBox() {
    if (!helpResponse) return null;

    const showStepControls =
      isStepMode &&
      (currentStep || conversationState === "complete") &&
      !isHelpLoading &&
      helpResponse !== "Thinking...";

    const isStuckHelp =
      conversationState === "stuck" || conversationState === "still_stuck";

    return (
      <div
        className="mt-6 rounded-2xl border-2 border-blue-200 bg-blue-50 p-5 sm:p-6"
        role="status"
        aria-live="polite"
      >
        {showStepControls && conversationState === "guiding" && originalQuestion && (
          <p className="mb-2 text-base text-slate-600 sm:text-lg">
            Task: {originalQuestion}
          </p>
        )}
        {showStepControls && conversationState === "guiding" && stepHistory.length > 0 && (
          <p className="mb-3 text-base text-slate-500 sm:text-lg">
            {stepHistory.length} step{stepHistory.length === 1 ? "" : "s"} completed
          </p>
        )}
        {showStepControls && conversationState === "guiding" && (
          <p className="mb-3 text-lg font-semibold text-blue-800 sm:text-xl">
            Step {stepHistory.length + 1}
          </p>
        )}
        {showStepControls && isStuckHelp && originalQuestion && (
          <p className="mb-2 text-base text-slate-600 sm:text-lg">
            Task: {originalQuestion}
          </p>
        )}
        {showStepControls && isStuckHelp && stepHistory.length > 0 && (
          <p className="mb-2 text-base text-slate-500 sm:text-lg">
            {stepHistory.length} step{stepHistory.length === 1 ? "" : "s"} completed
          </p>
        )}
        {showStepControls && isStuckHelp && (
          <p className="mb-3 text-lg font-semibold text-amber-800 sm:text-xl">
            Step {stepHistory.length + 1} — extra help
          </p>
        )}
        {showStepControls && isStuckHelp && currentStep && (
          <p className="mb-3 text-base text-slate-600 sm:text-lg">
            Your step: {currentStep}
          </p>
        )}
        {showStepControls && conversationState === "complete" && (
          <p className="mb-3 text-lg font-semibold text-green-800 sm:text-xl sr-only">
            Task complete
          </p>
        )}
        {showStepControls && highlightTarget && (
          <p className="mb-3 text-base font-medium text-red-700 sm:text-lg">
            Read the caption above your screenshot, then tap{" "}
            {highlightTarget.name}.
            {highlightTarget.location
              ? ` (${highlightTarget.location})`
              : ""}
          </p>
        )}
        <p className="text-xl leading-relaxed text-slate-800 sm:text-2xl">
          {helpResponse}
        </p>
        {showStepControls && conversationState === "complete" && (
          <div className="mt-6 flex flex-col gap-4">
            <p className="text-center text-[28px] font-bold text-green-800 sm:text-[32px]">
              ✅ Task Complete
            </p>
            <p className="text-center text-[20px] leading-relaxed text-slate-800 sm:text-[22px]">
              Great job! You completed your task.
            </p>
            <button
              type="button"
              onClick={handleAskAnotherQuestion}
              className="flex min-h-[64px] items-center justify-center rounded-2xl bg-blue-600 px-6 py-4 text-[22px] font-bold text-white transition hover:bg-blue-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 sm:text-[24px]"
            >
              ➕ Ask Another Question
            </button>
            <button
              type="button"
              onClick={handleStartNewTask}
              className="flex min-h-[64px] items-center justify-center rounded-2xl border-2 border-blue-600 bg-white px-6 py-4 text-[22px] font-bold text-blue-700 transition hover:bg-blue-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 sm:text-[24px]"
            >
              🔄 Start New Task
            </button>
            <button
              type="button"
              onClick={handleShowHumanHelp}
              className="flex min-h-[64px] items-center justify-center rounded-2xl border-2 border-slate-400 bg-white px-6 py-4 text-[22px] font-bold text-slate-800 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-300 sm:text-[24px]"
            >
              👤 Ask Staff or Family for Help
            </button>
          </div>
        )}
        {showStepControls && conversationState !== "complete" && (
          <div className="mt-5 flex flex-col gap-3">
            <button
              type="button"
              onClick={handleIDidIt}
              disabled={isHelpLoading}
              className="flex min-h-[72px] items-center justify-center rounded-2xl bg-blue-600 px-6 py-5 text-2xl font-bold text-white shadow-lg shadow-blue-200 transition hover:bg-blue-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 disabled:opacity-70 sm:text-3xl"
            >
              ✓ I Did It
            </button>
            {conversationState !== "still_stuck" && (
              <button
                type="button"
                onClick={
                  conversationState === "stuck"
                    ? handleStillStuck
                    : handleImStuck
                }
                disabled={isHelpLoading}
                className="flex min-h-[72px] items-center justify-center rounded-2xl border-2 border-amber-400 bg-amber-50 px-6 py-5 text-2xl font-semibold text-amber-900 transition hover:bg-amber-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-amber-300 disabled:opacity-70 sm:text-3xl"
              >
                {conversationState === "stuck"
                  ? "❓ Still stuck"
                  : "❓ I'm Stuck"}
              </button>
            )}
            <button
              type="button"
              onClick={handleShowHumanHelp}
              className="flex min-h-[64px] items-center justify-center rounded-2xl border-2 border-slate-500 bg-slate-50 px-6 py-4 text-[20px] font-bold text-slate-800 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-300 sm:text-[22px]"
            >
              👤 Ask Staff or Family for Help
            </button>
            <button
              type="button"
              onClick={handleRestartTask}
              disabled={isHelpLoading}
              className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl border-2 border-slate-300 bg-white px-4 py-4 text-xl font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-300 disabled:opacity-50 sm:text-2xl"
            >
              🔄 Restart Task
            </button>
            <button
              type="button"
              onClick={handleRepeatStep}
              disabled={isHelpLoading}
              className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl border-2 border-blue-600 bg-white px-4 py-4 text-xl font-semibold text-blue-700 transition hover:bg-blue-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 disabled:opacity-50 sm:text-2xl"
            >
              🔁 Repeat step
            </button>
            <button
              type="button"
              onClick={handleStopVoice}
              className="flex min-h-[64px] items-center justify-center gap-2 rounded-2xl border-2 border-slate-400 bg-white px-4 py-4 text-xl font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-300 sm:text-2xl"
            >
              🛑 Stop
            </button>
          </div>
        )}
      </div>
    );
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      try {
        if (localStorage.getItem(WELCOME_ACK_KEY) !== "true") {
          setShowWelcomeCard(true);
        }
      } catch {
        setShowWelcomeCard(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      try {
        if (localStorage.getItem(SCREENSHOT_GUIDE_HIDDEN_KEY) === "true") {
          setShowScreenshotGuide(false);
        }
      } catch {
        // Keep guide visible if storage is unavailable.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function handleHideScreenshotGuide() {
    setShowScreenshotGuide(false);
    try {
      localStorage.setItem(SCREENSHOT_GUIDE_HIDDEN_KEY, "true");
    } catch {
      // Preference not saved; guide still collapses for this visit.
    }
  }

  function handleShowScreenshotGuide() {
    setShowScreenshotGuide(true);
  }

  function renderScreenshotGuide() {
    if (!showScreenshotGuide) {
      return (
        <section
          className="mb-10"
          aria-label="Screenshot instructions"
        >
          <button
            type="button"
            onClick={handleShowScreenshotGuide}
            className="flex w-full min-h-[72px] items-center justify-center gap-3 rounded-2xl border-2 border-blue-300 bg-blue-50 px-6 py-5 text-[22px] font-bold text-blue-900 transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 sm:text-[24px]"
          >
            📸 Show Screenshot Instructions
          </button>
        </section>
      );
    }

    return (
      <section
        className="mb-12 rounded-3xl border-2 border-blue-200 bg-gradient-to-b from-blue-50 to-white p-8 shadow-sm sm:p-10"
        aria-labelledby="screenshot-guide-heading"
      >
        <h2
          id="screenshot-guide-heading"
          className="text-center text-[28px] font-bold leading-tight text-blue-900 sm:text-[32px]"
        >
          📸 Need help taking a screenshot?
        </h2>

        <div className="mt-10 grid gap-10 lg:grid-cols-2 lg:gap-12">
          <article className="rounded-2xl border-2 border-slate-200 bg-white p-8 sm:p-10">
            <h3 className="flex items-center justify-center gap-3 text-[28px] font-bold text-slate-900 sm:text-[32px]">
              <span aria-hidden>🍎</span> iPhone
            </h3>
            <div className="mt-8 rounded-2xl bg-slate-50 px-4 sm:px-6">
              <IPhoneScreenshotDiagram />
            </div>
            <GuideStepList steps={IPHONE_GUIDE_STEPS} />
            <p className="mt-8 rounded-xl border-2 border-amber-200 bg-amber-50 px-5 py-4 text-center text-[20px] font-semibold leading-snug text-amber-950 sm:text-[22px]">
              You should see a quick flash on your screen.
            </p>
          </article>

          <article className="rounded-2xl border-2 border-slate-200 bg-white p-8 sm:p-10">
            <h3 className="flex items-center justify-center gap-3 text-[28px] font-bold text-slate-900 sm:text-[32px]">
              <span aria-hidden>🤖</span> Android
            </h3>
            <div className="mt-8 rounded-2xl bg-slate-50 px-4 sm:px-6">
              <AndroidScreenshotDiagram />
            </div>
            <GuideStepList steps={ANDROID_GUIDE_STEPS} />
            <p className="mt-8 rounded-xl border-2 border-amber-200 bg-amber-50 px-5 py-4 text-center text-[20px] font-semibold leading-snug text-amber-950 sm:text-[22px]">
              You should see a quick flash on your screen.
            </p>
          </article>
        </div>

        <p className="mt-10 rounded-2xl border-2 border-blue-300 bg-blue-100 px-6 py-5 text-center text-[20px] font-bold leading-snug text-blue-950 sm:text-[22px]">
          Need help? Ask a family member or staff member to help you take your
          first screenshot.
        </p>

        <button
          type="button"
          onClick={handleHideScreenshotGuide}
          className="mt-8 flex w-full min-h-[72px] items-center justify-center rounded-2xl border-2 border-slate-400 bg-white px-6 py-5 text-[22px] font-bold text-slate-800 transition hover:border-slate-500 hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-300 sm:text-[24px]"
        >
          Hide Screenshot Instructions
        </button>
      </section>
    );
  }

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const timer = window.setTimeout(loadSpeechVoices, 0);
    window.speechSynthesis.addEventListener("voiceschanged", loadSpeechVoices);

    return () => {
      window.clearTimeout(timer);
      window.speechSynthesis.removeEventListener("voiceschanged", loadSpeechVoices);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (screenshotPreview) {
        URL.revokeObjectURL(screenshotPreview);
      }
      stopSpeech();
      recognitionRef.current?.abort();
    };
  }, [screenshotPreview]);

  useEffect(() => {
    if (micStatus !== "captured") return;
    const timer = setTimeout(() => setMicStatus("idle"), 5000);
    return () => clearTimeout(timer);
  }, [micStatus]);

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("Please choose an image file (PNG, JPG, or similar).");
      e.target.value = "";
      return;
    }

    if (screenshotPreview) {
      URL.revokeObjectURL(screenshotPreview);
    }

    setScreenshotName(file.name);
    setScreenshotFile(file);
    setOptimizedScreenshotDataUrl(null);
    setScreenshotPreview(URL.createObjectURL(file));

    const optimizedScreenshotPromise = fileToOptimizedDataUrl(file)
      .then((dataUrl) => {
        setOptimizedScreenshotDataUrl(dataUrl);
        return dataUrl;
      })
      .catch(() => fileToDataUrl(file));

    const sessionActive =
      isStepMode &&
      originalQuestion &&
      !isStepComplete &&
      (conversationState === "guiding" ||
        conversationState === "stuck" ||
        conversationState === "still_stuck");

    if (sessionActive) {
      void optimizedScreenshotPromise.then((dataUrl) => {
        setOriginalScreenshot(dataUrl);
      });
      setHighlightTarget(null);
    } else {
      resetStepMode();
      setHelpResponse(null);
      setHighlightTarget(null);
    }

    if (ENABLE_AUTO_SCREEN_SUMMARY) {
      void fetchScreenSummary(file);
    } else {
      summaryRequestRef.current += 1;
      setScreenSummary(null);
      setIsLoadingScreenSummary(false);
    }
  }

  function handleRemoveScreenshot() {
    summaryRequestRef.current += 1;
    setScreenSummary(null);
    setIsLoadingScreenSummary(false);
    if (screenshotPreview) {
      URL.revokeObjectURL(screenshotPreview);
    }
    setScreenshotName(null);
    setScreenshotPreview(null);
    setScreenshotFile(null);
    setOptimizedScreenshotDataUrl(null);
    setHelpResponse(null);
    resetStepMode();
    stopSpeech();
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleExampleClick(text: string) {
    setQuestion(text);
  }

  function handleMicClick() {
    if (isListening) return;

    const SpeechRecognition =
      typeof window !== "undefined"
        ? (
            window as Window & {
              SpeechRecognition?: BrowserSpeechRecognitionConstructor;
              webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
            }
          ).SpeechRecognition ||
          (
            window as Window & {
              webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
            }
          ).webkitSpeechRecognition
        : undefined;

    if (!SpeechRecognition) {
      setMicStatus("error");
      return;
    }

    setMicStatus("listening");
    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setMicStatus("listening");
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
      setMicStatus((prev) => (prev === "listening" ? "error" : prev));
    };

    recognition.onerror = () => {
      setIsListening(false);
      setMicStatus("error");
      recognitionRef.current = null;
    };

    recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) {
        setQuestion(transcript);
        setEmergencyAlertActive(classifyUserQuestion(transcript) === "emergency");
        setNonTechnologyAlertActive(
          classifyUserQuestion(transcript) === "non_technology"
        );
        setMicStatus("captured");
      } else {
        setMicStatus("error");
      }
    };

    try {
      recognition.start();
    } catch {
      setIsListening(false);
      setMicStatus("error");
      recognitionRef.current = null;
    }
  }

  function renderMicStatus() {
    if (micStatus === "idle") return null;

    const styles: Record<Exclude<MicStatus, "idle">, string> = {
      listening: "border-blue-300 bg-blue-50 text-blue-900",
      captured: "border-green-300 bg-green-50 text-green-900",
      error: "border-red-300 bg-red-50 text-red-900",
    };

    const messages: Record<Exclude<MicStatus, "idle">, string> = {
      listening: "🎤 Listening... Speak your question now.",
      captured: "✅ Question captured. Press Help Me when you are ready.",
      error: "❌ Could not hear you. Tap the microphone to try again, or type your question.",
    };

    return (
      <p
        className={`mt-4 rounded-2xl border-2 px-5 py-4 text-xl font-semibold sm:text-2xl ${styles[micStatus]}`}
        role="status"
        aria-live="polite"
      >
        {messages[micStatus]}
      </p>
    );
  }

  async function handleHelpMe() {
    const hasScreenshot = Boolean(screenshotPreview);
    const hasQuestion = Boolean(question.trim());

    if (!hasScreenshot && !hasQuestion) {
      setHelpResponse(
        "Please upload a screenshot and type what you are trying to do."
      );
      return;
    }

    if (!hasScreenshot) {
      setHelpResponse(
        "Please upload a screenshot first so I can see what you are looking at."
      );
      return;
    }

    if (!hasQuestion) {
      setHelpResponse("Please type what you are trying to do first.");
      return;
    }

    const trimmedQuestion = question.trim();
    const sessionActive =
      isStepMode &&
      originalQuestion &&
      originalScreenshot &&
      !isStepComplete &&
      (conversationState === "guiding" ||
        conversationState === "stuck" ||
        conversationState === "still_stuck");

    if (sessionActive) {
      return;
    }

    if (blockIfOutOfScope(trimmedQuestion)) {
      return;
    }

    setIsHelpLoading(true);
    stopSpeech();
    setHelpResponse("Thinking...");
    setHighlightTarget(null);

    try {
      const imageDataUrl = optimizedScreenshotDataUrl
        ? optimizedScreenshotDataUrl
        : screenshotFile
          ? await fileToOptimizedDataUrl(screenshotFile)
        : undefined;

      if (!imageDataUrl) {
        setHelpResponse("Sorry, something went wrong.");
        return;
      }

      setOptimizedScreenshotDataUrl(imageDataUrl);
      setOriginalQuestion(trimmedQuestion);
      setOriginalScreenshot(imageDataUrl);
      setStepHistory([]);
      setClarificationHistory([]);
      setCurrentStep(null);
      setIsStepMode(true);
      setIsStepComplete(false);
      setConversationState("guiding");

      const startedAt = performance.now();
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmedQuestion,
          image: imageDataUrl,
          stepHistory: [],
          clarificationHistory: [],
          isStepMode: true,
        }),
      });
      console.info(
        "Analyze first step request took",
        `${Math.round(performance.now() - startedAt)}ms`
      );

      const result = await parseAnalyzeResponse(response);
      if (result.status === "emergency" || result.status === "non_technology") {
        return;
      }
      if (result.status === "error") {
        setHelpResponse("Sorry, something went wrong.");
        setIsStepMode(false);
        setHighlightTarget(null);
        return;
      }
      if (!applyStepApiResponse(result.data, "guiding")) {
        setIsStepMode(false);
      }
    } catch {
      setHelpResponse("Sorry, something went wrong.");
      setIsStepMode(false);
      setHighlightTarget(null);
    } finally {
      setIsHelpLoading(false);
    }
  }

  function renderWelcomeCard() {
    if (!showWelcomeCard) return null;

    return (
      <section
        className="mb-8 rounded-3xl border-2 border-blue-300 bg-blue-50 p-8 shadow-sm sm:p-10"
        aria-labelledby="welcome-heading"
      >
        <h2
          id="welcome-heading"
          className="text-center text-[28px] font-bold text-blue-900 sm:text-[32px]"
        >
          Welcome!
        </h2>
        <p className="mt-6 text-[20px] leading-relaxed text-slate-800 sm:text-[22px]">
          This assistant helps you use your phone one step at a time.
        </p>
        <ol className="mt-6 space-y-4 text-[20px] leading-relaxed text-slate-900 sm:text-[22px]">
          <li>1. Take a screenshot.</li>
          <li>2. Upload it.</li>
          <li>3. Ask what you need help with.</li>
          <li>4. Follow the instructions one step at a time.</li>
        </ol>
        <p className="mt-6 text-center text-[20px] font-semibold text-blue-800 sm:text-[22px]">
          Take your time. We&apos;re here to help.
        </p>
        <button
          type="button"
          onClick={handleWelcomeAcknowledge}
          className="mt-8 flex w-full min-h-[64px] items-center justify-center rounded-2xl bg-blue-600 px-6 py-4 text-[22px] font-bold text-white transition hover:bg-blue-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 sm:text-[24px]"
        >
          ✓ Got It
        </button>
      </section>
    );
  }

  function renderTechnologyDisclaimer() {
    return (
      <section
        className="mb-8 rounded-3xl border-2 border-blue-300 bg-white p-6 shadow-sm sm:p-8"
        aria-labelledby="tech-disclaimer-heading"
      >
        <h2
          id="tech-disclaimer-heading"
          className="text-[24px] font-bold text-blue-900 sm:text-[28px]"
        >
          ℹ️ Technology Help Assistant
        </h2>
        <p className="mt-4 text-[18px] leading-relaxed text-slate-800 sm:text-[20px]">
          This assistant helps with phones, apps, screenshots, and technology
          questions.
        </p>
        <p className="mt-3 text-[18px] leading-relaxed text-slate-700 sm:text-[20px]">
          For medical concerns, safety concerns, emergencies, legal matters, or
          financial decisions, please contact staff, family members, caregivers,
          or appropriate professionals.
        </p>
      </section>
    );
  }

  function renderPrivacyNotice() {
    return (
      <section
        className="mb-6 rounded-2xl border-2 border-slate-200 bg-slate-50 p-6 sm:p-7"
        aria-labelledby="privacy-notice-heading"
      >
        <h2
          id="privacy-notice-heading"
          className="text-[24px] font-bold text-slate-900 sm:text-[26px]"
        >
          🔒 Privacy Reminder
        </h2>
        <p className="mt-3 text-[18px] leading-relaxed text-slate-700 sm:text-[20px]">
          Please do not upload screenshots containing passwords, banking
          information, private messages, social security numbers, or other
          sensitive personal information.
        </p>
      </section>
    );
  }

  function renderNonTechnologyAlert() {
    if (!nonTechnologyAlertActive) return null;

    return (
      <div
        ref={nonTechCardRef}
        className="mt-6 rounded-3xl border-4 border-amber-600 bg-amber-50 p-6 shadow-lg sm:p-8"
        role="alert"
        aria-live="assertive"
      >
        <h2 className="text-center text-[26px] font-bold text-amber-950 sm:text-[28px]">
          Outside Technology Help
        </h2>
        <p className="mt-5 text-center text-[20px] leading-relaxed text-amber-950 sm:text-[22px]">
          {NON_TECHNOLOGY_MESSAGE}
        </p>
      </div>
    );
  }

  function renderHumanHelpCard() {
    if (!showHumanHelp) return null;

    const summary = buildHumanHelpSummary();

    return (
      <section
        id="human-help-summary"
        className="mt-6 rounded-3xl border-2 border-slate-300 bg-white p-6 shadow-sm sm:p-8"
        aria-labelledby="human-help-heading"
      >
        <h2
          id="human-help-heading"
          className="text-center text-[24px] font-bold text-slate-900 sm:text-[28px]"
        >
          👤 Help Summary for Staff or Family
        </h2>
        <p className="mt-5 whitespace-pre-line text-[20px] leading-relaxed text-slate-800 sm:text-[22px]">
          {summary}
        </p>
        <button
          type="button"
          onClick={() => void handleCopyHumanHelpSummary()}
          className="mt-6 flex w-full min-h-[64px] items-center justify-center rounded-2xl bg-blue-600 px-6 py-4 text-[22px] font-bold text-white transition hover:bg-blue-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 sm:text-[24px]"
        >
          📋 Copy Summary
        </button>
        {summaryCopied && (
          <p className="mt-3 text-center text-[18px] font-semibold text-green-700 sm:text-[20px]">
            Summary copied. You can paste it in a message or email.
          </p>
        )}
      </section>
    );
  }

  function renderStartOverButton() {
    const hasActivity =
      Boolean(screenshotPreview) ||
      Boolean(question.trim()) ||
      isStepMode ||
      Boolean(helpResponse);

    if (!hasActivity) return null;

    return (
      <button
        type="button"
        onClick={handleStartOver}
        className="mb-6 flex w-full min-h-[64px] items-center justify-center gap-3 rounded-2xl border-2 border-slate-400 bg-white px-6 py-4 text-[22px] font-bold text-slate-800 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-300 sm:text-[24px]"
      >
        🔄 Start Over
      </button>
    );
  }

  function renderEmergencyAlert() {
    if (!emergencyAlertActive) return null;

    return (
      <div
        ref={emergencyCardRef}
        className="mt-6 rounded-3xl border-4 border-red-700 bg-red-600 p-6 text-white shadow-xl sm:p-8"
        role="alert"
        aria-live="assertive"
      >
        <h2 className="text-center text-[28px] font-bold leading-tight sm:text-[32px]">
          🚨 This Assistant Cannot Help With Emergencies
        </h2>
        <p className="mt-6 text-center text-[20px] font-semibold leading-relaxed sm:text-[22px]">
          This assistant is only for technology support.
        </p>
        <p className="mt-4 text-center text-[20px] leading-relaxed sm:text-[22px]">
          Please contact your facility office, nursing staff, caregiver, or
          emergency services immediately.
        </p>
        <p className="mt-4 text-center text-[22px] font-bold leading-relaxed sm:text-[24px]">
          If this is a life-threatening emergency, call 911 now.
        </p>

        <div className="mt-8 flex flex-col gap-4">
          <a
            href="tel:911"
            className="flex min-h-[72px] items-center justify-center gap-3 rounded-2xl bg-white px-6 py-5 text-[22px] font-bold text-red-700 transition hover:bg-red-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-white sm:text-[24px]"
          >
            📞 Call 911
          </a>
          <button
            type="button"
            onClick={() => setShowStaffContactInfo((open) => !open)}
            aria-expanded={showStaffContactInfo}
            className="flex min-h-[72px] items-center justify-center gap-3 rounded-2xl border-2 border-white bg-red-700 px-6 py-5 text-[22px] font-bold text-white transition hover:bg-red-800 focus:outline-none focus-visible:ring-4 focus-visible:ring-white sm:text-[24px]"
          >
            🏢 Contact Office / Staff
          </button>
        </div>

        {showStaffContactInfo && (
          <p className="mt-5 rounded-2xl border-2 border-white/80 bg-red-700 px-5 py-4 text-center text-[20px] leading-relaxed sm:text-[22px]">
            Go to the front desk, use your call button for nursing staff, or ask
            a nearby caregiver for help right away.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Hero */}
      <header className="border-b border-blue-100 bg-gradient-to-b from-blue-50 to-white">
        <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14 text-center">
          <div
            className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-blue-600 text-white shadow-lg shadow-blue-200 sm:h-24 sm:w-24"
            aria-hidden
          >
            <svg
              className="h-10 w-10 sm:h-12 sm:w-12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.75}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-blue-900 sm:text-5xl">
            Senior Screen Helper
          </h1>
          <p className="mt-4 text-xl leading-relaxed text-slate-600 sm:text-2xl">
            Your patient guide for using your phone — one step at a time,
            based on what&apos;s on your screen.
          </p>
          <button
            type="button"
            onClick={() => setShowVoiceSettings((open) => !open)}
            className="mt-6 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border-2 border-blue-200 bg-white px-5 py-3 text-lg font-semibold text-blue-800 transition hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 sm:text-xl"
            aria-expanded={showVoiceSettings}
            aria-controls="voice-settings-panel"
          >
            ⚙ Settings
          </button>
          {showVoiceSettings && (
            <div
              id="voice-settings-panel"
              className="mx-auto mt-4 max-w-md rounded-2xl border-2 border-blue-200 bg-white p-5 text-left shadow-sm"
            >
              <h2 className="text-lg font-bold text-blue-900 sm:text-xl">
                Voice settings
              </h2>
              <p className="mt-3 text-base text-slate-700 sm:text-lg">
                <span className="font-semibold">Speaking voice:</span>{" "}
                {selectedVoiceName}
              </p>
              <p className="mt-2 text-base text-slate-600 sm:text-lg">
                Speed: {SPEECH_RATE} · Pitch: {SPEECH_PITCH}
              </p>
              <p className="mt-2 text-sm text-slate-500 sm:text-base">
                {availableVoices.length} voices found in your browser
              </p>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-12">
        {renderWelcomeCard()}
        {renderTechnologyDisclaimer()}
        {renderStartOverButton()}
        {renderScreenshotGuide()}

        {/* Main actions */}
        <section aria-labelledby="get-help-heading">
          <h2 id="get-help-heading" className="sr-only">
            Get help
          </h2>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={handleFileChange}
            aria-label="Upload screenshot file"
          />

          {renderPrivacyNotice()}

          <button
            id="upload-screenshot-button"
            type="button"
            onClick={handleUploadClick}
            className="flex w-full min-h-[72px] items-center justify-center gap-4 rounded-2xl border-2 border-blue-200 bg-blue-50 px-6 py-5 text-2xl font-semibold text-blue-800 transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 sm:text-3xl"
          >
            <svg
              className="h-9 w-9 shrink-0 text-blue-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            Upload Screenshot
          </button>

          {screenshotPreview && (
            <div className="mt-6" role="region" aria-label="Uploaded screenshot">
              <div className="overflow-hidden rounded-2xl border-2 border-blue-200 bg-slate-50 shadow-sm">
                <ScreenshotWithHighlight
                  src={screenshotPreview}
                  alt={`Screenshot preview: ${screenshotName ?? "uploaded image"}`}
                  highlight={highlightTarget}
                />
              </div>
              <p className="mt-3 text-center text-lg text-blue-700" role="status">
                Screenshot ready: {screenshotName}
              </p>
              {renderScreenSummaryBox()}
              <button
                type="button"
                onClick={handleRemoveScreenshot}
                className="mt-4 flex w-full min-h-[56px] items-center justify-center gap-2 rounded-2xl border-2 border-slate-300 bg-white px-6 py-4 text-xl font-semibold text-slate-700 transition hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-red-200 sm:text-2xl"
              >
                <svg
                  className="h-6 w-6 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                Remove Screenshot
              </button>
              {renderHelpResponseBox()}
            </div>
          )}

          <label
            htmlFor="question"
            className="mt-8 block text-xl font-semibold text-slate-800 sm:text-2xl"
          >
            What do you need help with?
          </label>
          <p className="mt-2 text-lg text-slate-600 sm:text-xl">
            Type your question below, or tap the microphone to speak it.
          </p>
          <textarea
            id="question"
            value={question}
            onChange={(e) => {
              const nextQuestion = e.target.value;
              setQuestion(nextQuestion);
              const scope = classifyUserQuestion(nextQuestion);
              setEmergencyAlertActive(scope === "emergency");
              setNonTechnologyAlertActive(scope === "non_technology");
              if (micStatus === "captured" || micStatus === "error") {
                setMicStatus("idle");
              }
            }}
            placeholder="For example: How do I call my daughter?"
            rows={4}
            className="mt-3 w-full resize-none rounded-2xl border-2 border-slate-200 bg-white p-5 text-xl leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-100 sm:text-2xl"
          />

          {renderMicStatus()}

          <button
            type="button"
            onClick={handleMicClick}
            disabled={isListening}
            aria-pressed={isListening}
            aria-label={
              isListening
                ? "Listening, speak your question"
                : "Speak your question with microphone"
            }
            className={`mt-6 flex w-full min-h-[80px] items-center justify-center gap-4 rounded-2xl border-2 px-6 py-5 text-2xl font-semibold transition focus:outline-none focus-visible:ring-4 disabled:opacity-80 sm:text-3xl ${
              isListening
                ? "border-red-400 bg-red-50 text-red-800 focus-visible:ring-red-300 animate-pulse"
                : "border-blue-600 bg-white text-blue-700 hover:bg-blue-50 focus-visible:ring-blue-300"
            }`}
          >
            <span
              className={`flex h-14 w-14 items-center justify-center rounded-full text-3xl ${
                isListening ? "bg-red-100" : "bg-blue-100"
              }`}
              aria-hidden
            >
              🎤
            </span>
            {isListening ? "Listening..." : "Tap to Speak Your Question"}
          </button>

          <button
            type="button"
            onClick={handleHelpMe}
            disabled={
              isHelpLoading || emergencyAlertActive || nonTechnologyAlertActive
            }
            className="mt-4 flex w-full min-h-[80px] items-center justify-center gap-3 rounded-2xl bg-blue-600 px-6 py-5 text-2xl font-bold text-white shadow-lg shadow-blue-200 transition hover:bg-blue-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-300 disabled:opacity-70 sm:text-3xl"
          >
            <svg
              className="h-8 w-8 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            Help Me
          </button>

          {renderEmergencyAlert()}
          {renderNonTechnologyAlert()}
          {renderHumanHelpCard()}

          {helpResponse && !screenshotPreview && renderHelpResponseBox()}
        </section>

        {/* Example questions */}
        <section className="mt-12" aria-labelledby="examples-heading">
          <h2
            id="examples-heading"
            className="text-2xl font-bold text-blue-900 sm:text-3xl"
          >
            Try asking:
          </h2>
          <ul className="mt-4 flex flex-col gap-3">
            {EXAMPLE_QUESTIONS.map((text) => (
              <li key={text}>
                <button
                  type="button"
                  onClick={() => handleExampleClick(text)}
                  className="w-full rounded-2xl border-2 border-slate-200 bg-slate-50 px-5 py-4 text-left text-xl font-medium text-slate-800 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-900 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-200 sm:text-2xl"
                >
                  “{text}”
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* How it works */}
        <section
          className="mt-14 rounded-3xl border-2 border-blue-100 bg-blue-50 p-6 sm:p-8"
          aria-labelledby="how-heading"
        >
          <h2
            id="how-heading"
            className="text-center text-2xl font-bold text-blue-900 sm:text-3xl"
          >
            How it works
          </h2>
          <ol className="mt-8 space-y-6">
            {STEPS.map((step) => (
              <li key={step.number} className="flex gap-5">
                <span
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-2xl font-bold text-white"
                  aria-hidden
                >
                  {step.number}
                </span>
                <div>
                  <h3 className="text-xl font-bold text-blue-900 sm:text-2xl">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-lg leading-relaxed text-slate-600 sm:text-xl">
                    {step.description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <p className="mt-10 text-center text-lg text-slate-500 sm:text-xl">
          No account needed. Your screenshot stays private.
        </p>

        <p className="mt-6 rounded-2xl border-2 border-slate-200 bg-slate-50 px-5 py-4 text-center text-[18px] leading-relaxed text-slate-600 sm:text-[20px]">
          This assistant provides technology assistance only and should not be
          used for medical, legal, financial, or emergency situations.
        </p>
      </main>
    </div>
  );
}
