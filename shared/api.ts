import type { OptionLetter } from './question';

export type ReviewState = 'new' | 'once_due' | 'retry_due' | 'done';
export type AttemptStatus = 'correct' | 'wrong' | 'timeout' | 'abandoned';
export type AttemptPhase = 'first' | 'review';
export type SessionStatus = 'active' | 'completed' | 'ended';

export interface VisibleQuestion {
  id: string;
  language: string;
  topic: string;
  stem: string;
  options: Record<OptionLetter, string>;
  durationSeconds: number;
  startedAt: number;
  deadlineAt: number;
  position: number;
  total: number;
  phase: AttemptPhase;
}

export interface Feedback {
  question: VisibleQuestion;
  status: AttemptStatus;
  selectedLabel: OptionLetter | null;
  correctLabel: OptionLetter;
  explanation: string;
  elapsedMs: number;
}

export type SessionView = {
  id: string;
  targetCount: number;
  total: number;
  position: number;
  phase: 'question';
  question: VisibleQuestion;
} | {
  id: string;
  targetCount: number;
  total: number;
  position: number;
  phase: 'feedback';
  feedback: Feedback;
};

export interface Score {
  correct: number;
  total: number;
  averageMs: number | null;
}

export interface SessionSummary {
  id: string;
  status: Exclude<SessionStatus, 'active'>;
  startedAt: number;
  endedAt: number;
  targetCount: number;
  plannedCount: number;
  attemptedCount: number;
  first: Score;
  review: Score;
  timeoutCount: number;
  abandonedCount: number;
}

export interface AttemptHistory {
  id: string;
  questionId: string;
  language: string;
  topic: string;
  stem: string;
  phase: AttemptPhase;
  status: AttemptStatus;
  selectedLabel: OptionLetter | null;
  completedAt: number;
  elapsedMs: number;
  sessionId: string;
}

export interface Stats {
  questions: { total: number; new: number; due: number; waiting: number; done: number; nextDueAt: number | null };
  first: Score;
  review: Score;
  byTopic: Array<{ language: string; topic: string; first: Score; review: Score }>;
  byDay: Array<{ day: string; first: Score; review: Score }>;
  history: AttemptHistory[];
  sessions: SessionSummary[];
  languages: string[];
  topics: string[];
  intervalHours: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
  duplicates?: Array<{ file: string; line: number; reason: 'id' | 'content'; matchedId?: string; matchedFile?: string; matchedLine?: number }>;
}
export interface ImportFile { name: string; jsonl: string }

export interface ApiError {
  error: string;
  details?: string[];
}
