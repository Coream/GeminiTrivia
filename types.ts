
export interface HostPersonality {
  id: string;
  name: string;
  description: string;
  avatar: string;
  color: string;
  systemInstruction: string;
}

export interface TriviaQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  source?: string;
}

export interface GameState {
  status: 'IDLE' | 'SETUP' | 'PLAYING' | 'FINISHED';
  personality: HostPersonality | null;
  score: number;
  currentQuestionIndex: number;
  questions: TriviaQuestion[];
  userAnswer: string | null;
  transcription: string;
}

export type MessageType = 'user' | 'host';

export interface ChatMessage {
  role: MessageType;
  text: string;
  timestamp: number;
}
