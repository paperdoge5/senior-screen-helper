export type QuestionScope = "technology" | "emergency" | "non_technology";

const TECH_ASSISTANCE_PATTERNS = [
  /\bhelp me (call|text|send|open|find|use|turn|connect|download|install|upload|delete|email|message|facetime|face time|zoom|wifi|password|screen|phone|app|safari|camera|settings|update|charge|pair|bluetooth|internet|photo|picture|video|contact|daughter|son|family|mom|dad|grand|wife|husband|friend|doctor|bank|pay|bill)\b/i,
  /\bhow (?:do i|to)\b/i,
  /\bwhat (?:am i|is|are)\b/i,
  /\bwhere (?:is|are|do)\b/i,
  /\bshow me how\b/i,
  /\bcan you help me with\b/i,
  /\bemergency contact\b/i,
  /\bemergency mode\b/i,
  /\b(on|in|using|with) (?:my )?(phone|app|screen|device|ipad|tablet|computer)\b/i,
  /\bscreenshot\b/i,
  /\bwifi\b/i,
  /\btext message\b/i,
];

const EMERGENCY_PHRASES = [
  "medical emergency",
  "having an emergency",
  "this is an emergency",
  "it's an emergency",
  "its an emergency",
  "i fell",
  "i've fallen",
  "i have fallen",
  "can't breathe",
  "cannot breathe",
  "can not breathe",
  "chest pain",
  "having a stroke",
  "think i'm having a stroke",
  "heart attack",
  "having a heart attack",
  "need an ambulance",
  "need ambulance",
  "call 911",
  "call nine one one",
  "call nine-one-one",
  "someone is unconscious",
  "person is unconscious",
  "is unconscious",
  "passed out",
  "i am bleeding",
  "i'm bleeding",
  "im bleeding",
  "i am injured",
  "i'm injured",
  "im injured",
  "badly hurt",
  "seriously hurt",
  "badly injured",
  "life threatening",
  "life-threatening",
  "not breathing",
  "stopped breathing",
  "choking",
  "overdose",
  "kill myself",
  "hurt myself",
  "want to die",
  "suicidal",
  "severe pain",
  "can't move",
  "cannot move",
];

const NON_TECHNOLOGY_PHRASES = [
  "legal advice",
  "financial advice",
  "investment advice",
  "tax advice",
  "retirement advice",
  "should i sue",
  "talk to a lawyer",
  "need a lawyer",
  "power of attorney",
  "my will",
  "court case",
  "lawsuit",
  "medical advice",
  "what medication should",
  "what medicine should",
  "should i take this medicine",
  "what dosage",
  "side effects of my",
  "diagnose me",
  "do i have diabetes",
  "do i have cancer",
  "health condition",
  "my symptoms",
  "am i sick",
  "medical condition",
  "health problem",
  "personal safety",
  "feel unsafe",
  "being abused",
  "someone is hurting me",
  "domestic violence",
  "should i invest",
  "stock market advice",
  "insurance claim",
  "social security benefits",
  "medicare coverage",
  "medicaid eligibility",
];

const DISTRESS_ONLY_PATTERNS = [
  /^help me[!.?\s]*$/i,
  /^help[!.?\s]*$/i,
  /^please help[!.?\s]*$/i,
  /^i need help[!.?\s]*$/i,
  /^someone help[!.?\s]*$/i,
];

function isTechnologyContext(normalized: string): boolean {
  return TECH_ASSISTANCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isEmergencyQuestion(normalized: string): boolean {
  if (EMERGENCY_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  if (/^emergency[!.?\s]*$/i.test(normalized)) {
    return true;
  }

  if (
    /\bemergency\b/i.test(normalized) &&
    /\b(medical|ambulance|911|hospital|doctor|nurse|dying|bleeding|injured|pain)\b/i.test(
      normalized
    )
  ) {
    return true;
  }

  if (DISTRESS_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return false;
}

function isNonTechnologyQuestion(normalized: string): boolean {
  if (NON_TECHNOLOGY_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  if (
    /\b(should i|do i need to|is it safe to)\b/i.test(normalized) &&
    /\b(lawyer|invest|stock|medication|medicine|symptom|diagnos|treatment|insurance claim|taxes|will and testament)\b/i.test(
      normalized
    )
  ) {
    return true;
  }

  if (
    /\b(injured|injury|health issue|health concern|feeling sick|feel sick)\b/i.test(
      normalized
    ) &&
    !/\b(phone|app|screen|device|button|icon)\b/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

/** Classifies whether a user question is in scope for technology assistance. */
export function classifyUserQuestion(text: string): QuestionScope {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "technology";

  if (isTechnologyContext(normalized)) {
    return "technology";
  }

  if (isEmergencyQuestion(normalized)) {
    return "emergency";
  }

  if (isNonTechnologyQuestion(normalized)) {
    return "non_technology";
  }

  return "technology";
}

/** @deprecated Use classifyUserQuestion instead. */
export function detectEmergencyLanguage(text: string): boolean {
  return classifyUserQuestion(text) === "emergency";
}

export function isBlockedQuestion(text: string): boolean {
  return classifyUserQuestion(text) !== "technology";
}
